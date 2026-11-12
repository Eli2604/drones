// Simulation orchestrator: world, swarm, radio, failure injection, metrics.
// Runs headless (Node tests) or under the 3D UI.

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { Rng } from './rng.js';
import { Terrain, terrainParams } from './terrain.js';
import { Weather } from './weather.js';
import { Radio } from './comms.js';
import { Drone } from './drone.js';
import { planPath } from './planner.js';
import { slotOffsets, tableExtent, offsetToWorld } from './formation.js';
import { dist, distH } from './vec.js';
import { jamAt } from './jamming.js';

export const FAILURE_TYPES = {
  crash: 'motor failure (falls out of the sky)',
  shot: 'shot down',
  radio: 'radio failure (keeps flying, silent)',
  battery: 'battery fault (drains fast, hands over and lands)',
};

export class Simulation {
  constructor(cfg = {}) {
    this.listeners = new Set();
    this.reset(cfg);
  }

  reset(cfg) {
    this.cfg = mergeConfig(DEFAULT_CONFIG, cfg ?? this.cfg);
    const c = this.cfg;
    this.rng = new Rng(c.seed);
    const mapRng = new Rng(c.seed * 31 + 101);
    if (!this.terrain || this.terrain.key !== JSON.stringify([c.terrain.size, c.terrain.res, c.seed, terrainParams(c.terrain)])) {
      this.terrain = new Terrain({ ...c.terrain, seed: c.seed });
    }
    this.weather = new Weather(c.weather);
    this.radio = new Radio(this);
    this.t = 0;
    this.tick = 0;
    this.phase = 'ready'; // ready | running | complete
    this.events = [];
    this.loggedKeys = new Set();
    this.history = [];
    this.recentFixes = [];
    this.verCounter = 0;
    this.stats = { elections: 0, leaderChanges: 0, beaconFixes: 0, gnssFixes: 0, failures: 0, collisions: 0 };
    this.pendingOrders = [];
    this.arrivalTime = null;
    this.mainLeaderId = null;

    // Landmarks with known geolocation, recognisable by camera.
    const half = c.terrain.size / 2 - 80;
    this.beacons = [];
    for (let i = 0; i < c.nav.beaconCount; i++) {
      const x = mapRng.uniform(-half, half), z = mapRng.uniform(-half, half);
      this.beacons.push({ id: i, x, z, y: this.terrain.heightAt(x, z) });
    }
    for (const b of c.customBeacons) {
      this.beacons.push({ id: this.beacons.length, x: b.x, z: b.z, y: this.terrain.heightAt(b.x, b.z), custom: true });
    }

    // Anti-air threat sites (ground truth; the swarm has to discover them).
    this.threats = [];
    const tc = c.threats;
    for (let i = 0, tries = 0; i < tc.count && tries < 500; tries++) {
      const x = mapRng.uniform(-half, half), z = mapRng.uniform(-half, half);
      if (distH({ x, z }, c.origin) < 450 || distH({ x, z }, c.destination) < 350) continue;
      this.addThreat(x, z);
      i++;
    }
    for (const p of tc.custom) this.addThreat(p.x, p.z, true);
    // Jammers (ground truth) and the central ground station.
    this.jammers = [];
    const jc = c.jammers;
    for (let i = 0, tries = 0; i < jc.count && tries < 500; tries++) {
      const x = mapRng.uniform(-half, half), z = mapRng.uniform(-half, half);
      if (distH({ x, z }, c.origin) < jc.radius + 250 || distH({ x, z }, c.destination) < jc.radius + 100) continue;
      this.addJammer(x, z, jc.type, jc.radius);
      i++;
    }
    for (const p of jc.custom) this.addJammer(p.x, p.z, p.type ?? jc.type, p.r ?? jc.radius, true);
    const cx = c.central.x ?? c.origin.x, cz = c.central.z ?? c.origin.z;
    this.central = { x: cx, z: cz, y: this.terrain.heightAt(cx, cz) + 8 };
    this.shots = [];
    this.explosions = [];

    // Spawn on the ground around the origin.
    this.drones = [];
    const n = c.swarm.count;
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const x = c.origin.x + ((i % cols) - (cols - 1) / 2) * 10;
      const z = c.origin.z + (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * 10;
      this.drones.push(new Drone(i, { x, y: this.terrain.heightAt(x, z) + 0.2, z }, this));
    }
    this.failureQueue = [...c.failures].sort((a, b) => a.t - b.t);
    this.nextChaos = c.chaosInterval > 0 ? c.chaosInterval : Infinity;
    this.emit('reset');
  }

  // ---------------------------------------------------------------- events
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners) fn(type, data);
  }
  log(type, text) {
    const e = { t: this.t, type, text };
    this.events.push(e);
    if (this.events.length > 2000) this.events.shift();
    this.emit('event', e);
  }
  logOnce(key, type, text) {
    if (this.loggedKeys.has(key)) return false;
    this.loggedKeys.add(key);
    this.log(type, text);
    return true;
  }
  nextVer() {
    return ++this.verCounter;
  }

  // ---------------------------------------------------------------- queries
  /** The leader of the largest group (there can be several after partitions). */
  get leader() {
    let best = null, bestN = -1;
    for (const d of this.drones) {
      if (!d.isLeader || !d.active) continue;
      const n = d.memberIds().length;
      if (n > bestN) (best = d), (bestN = n);
    }
    return best;
  }
  get activeDrones() {
    return this.drones.filter((d) => d.active && d.flying());
  }

  /**
   * Slot table (metres) for n drones under the current operator formation settings.
   * `dispersed` spreads the formation out horizontally (reaction to enemy fire).
   */
  formationTable(n, dispersed = false) {
    const s = this.cfg.swarm;
    return slotOffsets(s.formation, n, s.spacing, { vSpread: s.vSpread, custom: s.customSlots, scaleH: dispersed ? 1.7 : 1 });
  }
  formationSig(dispersed = false) {
    const s = this.cfg.swarm;
    return JSON.stringify([s.formation, s.spacing, s.vSpread, s.formation === 'custom' ? s.customSlots : 0, dispersed]);
  }
  formationExtent() {
    return tableExtent(this.formationTable(this.cfg.swarm.count));
  }
  formationRadius() {
    return this.formationExtent().radius;
  }

  planRoute(from, avoid = []) {
    const c = this.cfg;
    const ext = this.formationExtent();
    const res = planPath({
      terrain: this.terrain,
      start: from,
      goal: c.destination,
      wind: this.weather.baseWind(),
      noFly: [...c.noFly, ...avoid],
      opts: {
        gridN: 96,
        // Lowest drone of a 3D formation must still clear the terrain by cruiseAGL.
        clearance: c.swarm.cruiseAGL + ext.below,
        // Highest drone must stay under the ceiling.
        maxAltitude: c.swarm.maxAltitude - ext.above,
        corridor: Math.max(30, ext.radius * 0.8),
        cruiseSpeed: c.swarm.cruiseSpeed,
      },
    });
    this.lastPlan = res;
    return res;
  }

  // ---------------------------------------------------------------- threats & effects
  addThreat(x, z, custom = false) {
    const t = { id: this.threats.length, x, z, y: this.terrain.heightAt(x, z), custom, nextShot: 0, shots: 0, kills: 0 };
    this.threats.push(t);
    return t;
  }

  addJammer(x, z, type = this.cfg.jammers.type, r = this.cfg.jammers.radius, custom = false) {
    const j = { id: this.jammers.length, x, z, y: this.terrain.heightAt(x, z) + 6, type, r, custom };
    this.jammers.push(j);
    return j;
  }

  jamAt(p) {
    return jamAt(this.jammers, p);
  }

  /**
   * Electronic warfare, each tick: what every drone can hear and where it can fix its position.
   * C2: in range of the central, radio working, not jammed (at the drone or at the central).
   * GNSS: switched on and not jammed: a fix now and then. Getting jammed is noticed (reaction).
   */
  stepEW(dt) {
    const c = this.cfg, cen = this.central;
    const centralJam = this.jamAt(cen).comms;
    for (const d of this.drones) {
      if (!d.flying()) {
        d.jam = { comms: 0, gnss: 0 };
        continue;
      }
      const j = this.jamAt(d.truePos);
      const was = d.jam ?? { comms: 0, gnss: 0 };
      d.jam = j;
      const c2 = d.radioOk && j.comms < 0.5 && centralJam < 0.5 && dist(d.truePos, cen) < c.central.range;
      if (d.c2Ok && !c2 && d.active) this.logOnce(`c2-lost-${d.id}-${Math.floor(this.t / 20)}`, 'ew', `D${d.id} lost the link to the central${j.comms >= 0.5 ? ' (jammed)' : ''}`);
      d.c2Ok = c2;
      d.gnssOk = c.nav.gnss && j.gnss < 0.5;
      if (d.active && d.status !== 'takeoff') {
        if (j.comms >= 0.5 && was.comms < 0.5) d.onJammed('comms');
        if (c.nav.gnss && j.gnss >= 0.5 && was.gnss < 0.5) d.onJammed('gnss');
      }
      if (d.gnssOk && d.status !== 'takeoff' && this.rng.next() < c.nav.gnssRate * dt) {
        const s = c.nav.gnssSigma;
        d.loc.absoluteFix({ x: d.truePos.x + this.rng.gauss(0, s), z: d.truePos.z + this.rng.gauss(0, s) }, s);
        this.stats.gnssFixes++;
      }
    }
  }

  /** An operator order: carried out now if the leader is in contact with the central, else queued. */
  order(kind, fn) {
    const L = this.leader;
    if (this.phase === 'ready' || !L || L.c2Ok !== false) return fn();
    this.pendingOrders.push({ kind, fn });
    this.log('ew', `Order "${kind}" queued: leader D${L.id} is out of contact with the central`);
    return null;
  }

  /** Terrain masking: is the straight line from a to b above the ground everywhere? */
  lineOfSight(a, b) {
    const n = Math.max(4, Math.ceil(dist(a, b) / 15));
    for (let k = 1; k < n; k++) {
      const s = k / n;
      const x = a.x + (b.x - a.x) * s, y = a.y + (b.y - a.y) * s, z = a.z + (b.z - a.z) * s;
      if (this.terrain.heightAt(x, z) > y - 1) return false;
    }
    return true;
  }

  stepThreats() {
    const tc = this.cfg.threats;
    for (const th of this.threats) {
      if (this.t < th.nextShot) continue;
      const gun = { x: th.x, y: th.y + 4, z: th.z };
      const cand = this.drones.filter(
        (d) => d.flying() && d.status !== 'landing' && dist(gun, d.truePos) < tc.range && this.lineOfSight(gun, d.truePos),
      );
      if (!cand.length) {
        th.nextShot = this.t + 0.5;
        continue;
      }
      let target;
      const nearest = () => cand.reduce((a, b) => (dist(gun, a.truePos) < dist(gun, b.truePos) ? a : b));
      if (tc.targeting === 'leader') target = cand.find((d) => d.isLeader && d.active) ?? nearest();
      else if (tc.targeting === 'random') target = this.rng.pick(cand);
      else target = nearest();

      const d = dist(gun, target.truePos);
      const speed = Math.hypot(target.trueVel.x, target.trueVel.y, target.trueVel.z);
      const p = tc.hitProb * (1 - 0.6 * (d / tc.range)) * (target.isEvading() ? 0.45 : 1) * Math.min(1, Math.max(0.5, 1.1 - speed / 30));
      const hit = this.rng.next() < p;
      th.shots++;
      th.nextShot = this.t + tc.interval * this.rng.uniform(0.8, 1.2);
      this.shots.push({ from: gun, to: { ...target.truePos }, hit, t: this.t, threat: th.id, target: target.id });
      if (hit) {
        th.kills++;
        const role = target.isLeader ? 'leader ' : '';
        target.crash(`${role}shot down by threat T${th.id}`, true);
      }
      // Muzzle flash / tracer seen by the target (if it survives) and drones near it.
      for (const o of this.drones) {
        if (!o.active || !o.flying() || o.status === 'crashed') continue;
        const near = o === target || dist(o.truePos, target.truePos) < 220;
        if (!near || this.rng.next() > 0.9) continue;
        const errM = 15 + 0.06 * dist(o.truePos, gun);
        const est = { x: th.x + this.rng.gauss(0, errM), z: th.z + this.rng.gauss(0, errM) };
        o.onFiredUpon(est, o === target);
      }
    }
    if (this.tick % 10 === 0) {
      this.shots = this.shots.filter((s) => this.t - s.t < 1);
      this.explosions = this.explosions.filter((e) => this.t - e.t < 2);
    }
  }

  addExplosion(pos, big = false) {
    this.explosions.push({ pos: { ...pos }, t: this.t, big });
  }

  // ---------------------------------------------------------------- callbacks from drones
  onLeaderChange(d, reason) {
    this.stats.leaderChanges++;
    this.log('leader', `D${d.id} is now leader - ${reason}`);
  }
  onArrival(d) {
    if (this.arrivalTime !== null) return;
    this.arrivalTime = this.t;
    this.phase = 'complete';
    const alive = this.drones.filter((x) => x.inSwarm()).length;
    this.log('mission', `Destination reached at t=${this.t.toFixed(1)} s with ${alive}/${this.drones.length} drones`);
  }

  /** Short-range proximity sensor (radar / ToF): relative position and velocity of nearby drones. */
  proximity(d, radius) {
    const out = [];
    for (const o of this.drones) {
      if (o === d || !o.flying()) continue;
      const rel = { x: o.truePos.x - d.truePos.x, y: o.truePos.y - d.truePos.y, z: o.truePos.z - d.truePos.z };
      if (Math.abs(rel.x) > radius || Math.abs(rel.z) > radius || Math.hypot(rel.x, rel.y, rel.z) > radius) continue;
      const n = 0.3;
      out.push({
        id: o.id,
        rel: { x: rel.x + this.rng.gauss(0, n), y: rel.y + this.rng.gauss(0, n), z: rel.z + this.rng.gauss(0, n) },
        relVel: { x: o.trueVel.x - d.trueVel.x, y: o.trueVel.y - d.trueVel.y, z: o.trueVel.z - d.trueVel.z },
      });
    }
    return out;
  }

  detectBeacons(d, dt) {
    if (!d.flying() || d.status === 'takeoff') return;
    const c = this.cfg.nav, w = this.weather;
    const range = Math.min(c.cameraRange, w.visibility());
    const p = c.beaconDetectRate * w.cameraFactor() * dt;
    for (const b of this.beacons) {
      if (d.truePos.y <= b.y + 5) continue;
      const r = dist(d.truePos, b);
      if (r > range || this.rng.next() > p) continue;
      // The camera measures the landmark's position relative to the drone; with the
      // landmark's known geolocation this yields the drone's absolute position.
      const sm = (1 + 0.008 * r) * w.sensorNoiseFactor();
      const meas = { x: d.truePos.x + this.rng.gauss(0, sm), z: d.truePos.z + this.rng.gauss(0, sm) };
      d.loc.absoluteFix(meas, sm);
      this.stats.beaconFixes++;
      this.recentFixes.push({ drone: d.id, beacon: b.id, t: this.t });
    }
  }

  // ---------------------------------------------------------------- user actions
  setWeather(partial) {
    Object.assign(this.cfg.weather, partial);
    this.weather.set(partial);
  }

  setDestination(x, z) {
    return this.order('new destination', () => {
      this.cfg.destination = { x, z };
      const L = this.leader;
      if (this.phase !== 'ready' && L) {
        if (this.phase === 'complete') this.phase = 'running';
        this.arrivalTime = null;
        L.replan('new destination');
      }
      return true;
    });
  }

  requestReplan() {
    return this.order('replan', () => {
      const L = this.leader;
      if (L) L.replan('operator request');
      return true;
    });
  }

  forceHandover() {
    return this.order('handover', () => {
      const L = this.leader;
      if (!L) return false;
      const s = L.bestSuccessor();
      if (!s) return false;
      L.handover(s.id, 'operator request');
      return true;
    });
  }

  injectFailure(target, type) {
    let d;
    const candidates = this.drones.filter((x) => x.active && x.flying() && x.status !== 'landing');
    if (target === 'leader') d = this.leader;
    else if (target === 'random') d = candidates.length ? this.rng.pick(candidates) : null;
    else d = this.drones[target];
    if (!d || !d.active || !d.flying()) return null;
    this.stats.failures++;
    const role = d.isLeader ? 'leader ' : '';
    switch (type) {
      case 'crash':
        d.crash(`${role}motor failure (injected)`);
        break;
      case 'shot':
        d.crash(`${role}shot down by operator (injected)`, true);
        break;
      case 'radio':
        d.radioOk = false;
        d.failure = 'radio';
        this.log('failure', `${role}D${d.id} radio failure (injected) - continues autonomously`);
        break;
      case 'battery':
        d.batteryJ = Math.min(d.batteryJ, d.batteryCapJ * 0.34);
        d.batteryLeak = 0.004;
        d.failure = 'battery';
        this.log('failure', `${role}D${d.id} battery fault (injected) - draining fast`);
        break;
      default:
        return null;
    }
    return d;
  }

  // ---------------------------------------------------------------- main loop
  start() {
    if (this.phase !== 'ready') return;
    this.phase = 'running';
    for (const d of this.drones) d.startTakeoff();
    this.log('mission', `Mission start: ${this.drones.length} drones, ${this.cfg.terrain.preset} terrain, formation ${this.cfg.swarm.formation}`);
  }

  step(dt = this.cfg.dt) {
    if (this.phase === 'ready') this.start();
    this.t += dt;
    this.tick++;

    while (this.failureQueue.length && this.failureQueue[0].t <= this.t) {
      const f = this.failureQueue.shift();
      this.injectFailure(f.target, f.type);
    }
    if (this.t >= this.nextChaos) {
      this.nextChaos = this.t + Math.max(5, this.cfg.chaosInterval);
      if (this.activeDrones.length > 2) {
        const r = this.rng.next();
        this.injectFailure('random', r < 0.55 ? 'crash' : r < 0.8 ? 'radio' : 'battery');
      }
    }

    if (this.threats.length) this.stepThreats();
    this.stepEW(dt);
    if (this.pendingOrders.length && this.leader?.c2Ok) {
      const orders = this.pendingOrders;
      this.pendingOrders = [];
      for (const o of orders) {
        this.log('ew', `Order "${o.kind}" delivered: leader D${this.leader.id} is back in contact`);
        o.fn();
      }
    }

    for (const { to, env } of this.radio.deliver()) {
      if (to.active && to.radioOk) to.receive(env);
    }
    for (const d of this.drones) d.update(dt);

    // Mid-air collisions (true positions).
    const fl = this.drones.filter((d) => d.flying());
    for (let i = 0; i < fl.length; i++) {
      for (let j = i + 1; j < fl.length; j++) {
        if (dist(fl[i].truePos, fl[j].truePos) < 1.2) {
          this.stats.collisions++;
          fl[i].crash(`mid-air collision with D${fl[j].id}`, true);
          fl[j].crash(`mid-air collision with D${fl[i].id}`, true);
        }
      }
    }

    const L = this.leader;
    if (L && L.id !== this.mainLeaderId) this.mainLeaderId = L.id;
    if (this.recentFixes.length && this.tick % 10 === 0) this.recentFixes = this.recentFixes.filter((f) => this.t - f.t < 1.5);
    if (this.tick % Math.round(1 / dt) === 0) this.record();
  }

  run(seconds) {
    const n = Math.round(seconds / this.cfg.dt);
    for (let i = 0; i < n; i++) this.step();
  }

  // ---------------------------------------------------------------- metrics
  metrics() {
    const fl = this.drones.filter((d) => d.flying() && d.status !== 'takeoff');
    let sum = 0, max = 0;
    for (const d of fl) {
      const e = distH(d.loc.est, d.truePos);
      sum += e;
      max = Math.max(max, e);
    }
    // True formation error: how far each follower is from its slot around the real leader.
    const L = this.leader;
    let fsum = 0, fn = 0;
    if (L) {
      for (const [id, s] of L.formation.slots) {
        const d = this.drones[id];
        const off = L.slotTable[s];
        if (id === L.id || !d?.inSwarm() || !off) continue;
        const w = offsetToWorld(off, L.heading);
        fsum += Math.hypot(L.truePos.x + w.x - d.truePos.x, L.truePos.z + w.z - d.truePos.z);
        fn++;
      }
    }
    const inSwarm = this.drones.filter((d) => d.inSwarm()).length;
    return {
      t: this.t,
      meanErr: fl.length ? sum / fl.length : 0,
      maxErr: max,
      formationErr: fn ? fsum / fn : 0,
      inSwarm,
      leader: L?.id ?? null,
      distToGoal: L ? distH(L.truePos, this.cfg.destination) : null,
    };
  }

  record() {
    this.history.push(this.metrics());
    if (this.history.length > 3600) this.history.shift();
  }
}
