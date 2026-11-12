// A single swarm member: protocol (leader election / handover / membership),
// guidance (leader path following, follower formation keeping), control and physics.
//
// Everything a drone decides is based on its OWN estimated state (loc.est) and on what
// it heard over the radio. `truePos`/`trueVel` are only used by the simulator for physics,
// sensors and scoring, never for decisions (except the downward rangefinder, which
// genuinely measures height above ground).

import { v3, clone, add, sub, scale, lenH, distH, clamp, clampH, headingOf, wrapAngle, norm } from './vec.js';
import { Localizer } from './localization.js';
import { offsetToWorld, assignSlots, formationRadius, tableExtent } from './formation.js';

const G = 9.81;
const FLYING = new Set(['takeoff', 'enroute', 'arrived', 'landing']);
const IN_SWARM = new Set(['takeoff', 'enroute', 'arrived']);

export class Drone {
  constructor(id, pos, sim) {
    this.id = id;
    this.sim = sim;
    const c = sim.cfg;
    this.truePos = clone(pos);
    this.trueVel = v3();
    this.status = 'ground'; // ground | takeoff | enroute | arrived | landing | landed | crashed
    this.active = true; // radio on and participating in the swarm
    this.radioOk = true;
    this.jam = { comms: 0, gnss: 0 }; // how strongly it is jammed now (sim.stepEW)
    this.c2Ok = true; // link to the central ground station
    this.gnssOk = false;
    this.jamZones = new Map(); // where the group found jamming
    this.lastJamMsg = -1e9;
    this.failure = null;
    this.batteryCapJ = c.drone.batteryWh * 3600;
    this.batteryJ = this.batteryCapJ;
    this.batteryLeak = 0; // fraction of capacity per second (injected fault)
    this.propEnergyJ = 0;
    this.radioEnergyJ = 0;
    this.loc = new Localizer(pos, sim.rng, c.nav);
    this.vInt = v3();
    this.heading = headingOf(c.destination.x - c.origin.x, c.destination.z - c.origin.z);
    this.groundY = pos.y;

    // Protocol state
    this.term = 0;
    this.leaderId = null;
    this.isLeader = false;
    this.leaderSince = 0;
    this.lastLeaderHeard = 0;
    this.leaderTimeout = c.comms.hbInterval * (4 + sim.rng.uniform(0, 3));
    this.election = null;
    this.leaderState = null;
    this.plan = null;
    this.wpIdx = 1;
    this.departed = false;
    this.arrived = false;
    this.formation = { type: c.swarm.formation, spacing: c.swarm.spacing, ver: 0, slots: new Map() };
    this.slotTable = [];
    this.peers = new Map(); // id -> last STATUS/HB info
    this.neighbors = new Map(); // id -> { range, est, sigma, t } (direct radio contact)
    this.seen = new Map(); // message id -> time
    this.pendingRelays = new Map();
    this.msgSeq = 0;
    this.nextHb = 0;
    this.nextStatus = sim.rng.uniform(0, 2 * c.comms.hbInterval);
    this.lastRx = 0;
    this.lastPlanSent = -10;
    this.handoverDone = false;
    this.trail = [];

    // Threat awareness
    this.threats = new Map(); // key -> { x, z, r, n, t } estimated anti-air sites
    this.threatSeq = 0;
    this.underFireUntil = -1; // individual evasive manoeuvring
    this.jink = null;
    this.dispersalUntil = -1; // leader: spread the formation out
    this.lastThreatReplan = -100;
    this.lastCommandShift = -100;
    this.lastThreatMsg = -100;
  }

  isEvading() {
    return this.sim.t < this.underFireUntil;
  }

  // ---------------------------------------------------------------- threats
  /** Called by the sensors when a shot is seen (muzzle flash / tracer), with an estimated origin. */
  onFiredUpon(est, targeted) {
    const t = this.sim.t;
    const tc = this.cfg.threats;
    if (!tc.reaction) return;
    if (targeted) {
      this.underFireUntil = t + 4;
      this.sim.logOnce(`evade-${this.id}-${Math.floor(t / 10)}`, 'threat', `D${this.id} under fire - evasive manoeuvres`);
    }
    const isNew = this.learnThreat(est.x, est.z, tc.range * 1.1);
    this.dispersalUntil = t + 20; // every member remembers the alarm (a new leader inherits it)
    // Share what we saw (rate-limited); this is also the group's "under fire" alarm.
    if (isNew || t - this.lastThreatMsg > 3) {
      this.lastThreatMsg = t;
      this.send('THREAT', { x: est.x, z: est.z, r: tc.range * 1.1, targeted, leaderTargeted: targeted && this.isLeader }, this.cfg.comms.ttl + 1);
    }
    if (this.isLeader) this.onThreatAlarm(isNew, est);
    // Commander protection: a leader that is being shot at hands command to a healthy
    // member OUTSIDE the threat's estimated range. (Handing over to someone still in range
    // only moves the target and costs a formation reshuffle - measured to be worse.)
    if (targeted && this.isLeader && tc.protectCommander && t - this.lastCommandShift > 15) {
      let best = null, bestD = tc.range * 1.15;
      for (const id of this.memberIds()) {
        const p = this.peers.get(id);
        if (id === this.id || !p || t - p.t > 3 || p.battery < 0.35) continue;
        const d = Math.hypot(p.est.x - est.x, p.est.z - est.z);
        if (d > bestD) (bestD = d), (best = id);
      }
      if (best !== null) {
        this.lastCommandShift = t;
        this.handover(best, 'commander under fire');
      }
    }
  }

  /** Merge an estimated threat position into the map. Returns true when it is new. */
  learnThreat(x, z, r) {
    for (const th of this.threats.values()) {
      if (Math.hypot(th.x - x, th.z - z) < 180) {
        th.x = (th.x * th.n + x) / (th.n + 1);
        th.z = (th.z * th.n + z) / (th.n + 1);
        th.n = Math.min(th.n + 1, 20);
        th.t = this.sim.t;
        return false;
      }
    }
    this.threats.set(`${this.id}-${++this.threatSeq}`, { x, z, r, n: 1, t: this.sim.t });
    return true;
  }

  /** Leader: the group is being engaged. Disperse, and reroute around newly found threats. */
  onThreatAlarm(isNew, where) {
    const t = this.sim.t;
    this.reassign(); // picks up the dispersal state (no-op if already dispersed)
    if (isNew && t - this.lastThreatReplan > 3) {
      this.lastThreatReplan = t;
      this.sim.log('threat', `Leader D${this.id}: threat located near (${where.x.toFixed(0)}, ${where.z.toFixed(0)}) - rerouting`);
      this.replan('avoid threat');
    }
  }

  threatZones() {
    return [...this.threats.values(), ...this.jamZones.values()].map((th) => ({ x: th.x, z: th.z, r: th.r }));
  }

  // ---------------------------------------------------------------- jamming
  /**
   * The drone noticed it is being jammed ('comms': the noise floor jumped; 'gnss': the fixes
   * stopped). It marks the area round its estimated position, tells the group (what it sends
   * still reaches drones outside the jammer) and the leader routes around it.
   */
  onJammed(kind) {
    const jc = this.cfg.jammers;
    const t = this.sim.t;
    this.sim.logOnce(`jam-${kind}-${this.id}-${Math.floor(t / 15)}`, 'ew', `D${this.id} jammed: ${kind === 'gnss' ? 'GNSS lost, navigating on odometry, landmarks and ranging' : 'radio jammed'}`);
    if (!jc.reaction) return;
    const est = this.loc.est;
    const isNew = this.learnJam(est.x, est.z, jc.radius * 1.15, kind);
    if (isNew || t - this.lastJamMsg > 4) {
      this.lastJamMsg = t;
      this.send('JAM', { x: est.x, z: est.z, r: jc.radius * 1.15, kind }, this.cfg.comms.ttl + 1);
    }
    if (this.isLeader) this.onJamFound(isNew, est, kind);
  }
  learnJam(x, z, r, kind) {
    for (const j of this.jamZones.values()) {
      if (Math.hypot(j.x - x, j.z - z) < r * 0.6) {
        j.n = Math.min(j.n + 1, 20);
        j.t = this.sim.t;
        return false;
      }
    }
    this.jamZones.set(`${this.id}-j${this.jamZones.size}`, { x, z, r, kind, n: 1, t: this.sim.t });
    return true;
  }
  onJamFound(isNew, where, kind) {
    const t = this.sim.t;
    if (isNew && t - (this.lastJamReplan ?? -1e9) > 3) {
      this.lastJamReplan = t;
      this.sim.log('ew', `Leader D${this.id}: ${kind === 'gnss' ? 'GNSS' : 'radio'} jamming near (${where.x.toFixed(0)}, ${where.z.toFixed(0)}) - rerouting around it`);
      this.replan('avoid jammer');
    }
  }

  // ---------------------------------------------------------------- helpers
  get cfg() {
    return this.sim.cfg;
  }
  batteryFrac() {
    return Math.max(0, this.batteryJ / this.batteryCapJ);
  }
  flying() {
    return FLYING.has(this.status);
  }
  inSwarm() {
    return this.active && IN_SWARM.has(this.status);
  }
  /** Fitness to lead: battery, connectivity, position confidence, incumbency. */
  score() {
    if (!this.inSwarm()) return -1;
    const t = this.sim.t;
    let nb = 0;
    for (const n of this.neighbors.values()) if (t - n.t < 2) nb++;
    return (
      100 * this.batteryFrac() +
      2 * Math.min(nb, 6) +
      (this.loc.sigma < 10 ? 5 : 0) +
      (this.isLeader ? 10 : 0) -
      this.id * 0.001
    );
  }
  memberIds() {
    const t = this.sim.t;
    const timeout = 6 * this.cfg.comms.hbInterval + 1;
    const ids = [this.id];
    for (const [id, p] of this.peers) {
      if (id !== this.id && t - p.t < timeout && IN_SWARM.has(p.status)) ids.push(id);
    }
    return ids.sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- radio
  /**
   * @param {number} [reach] distance (m) this message should reach directly; the radio
   *   picks max(neighbour range, reach / fade). Relays still cover anything beyond.
   */
  send(type, payload, ttl = this.cfg.comms.ttl, reach = 0) {
    const mid = `${this.id}:${++this.msgSeq}`;
    const msg = { mid, ttl, origin: this.id, type, payload };
    this.seen.set(mid, this.sim.t);
    this.transmit(msg, reach);
  }

  transmit(msg, reach = 0) {
    if (!this.active || !this.radioOk) return;
    const c = this.cfg.comms;
    const direct = reach > 0 ? (reach * 1.25) / this.sim.weather.commFactor() : 0;
    this.sim.radio.transmit(this, msg, clamp(Math.max(this.txRange(), direct), c.minRange, c.maxRange));
  }

  /** Distance to the farthest current member (leader) or to the leader (follower), from estimates. */
  reachForLeader() {
    let m = 0;
    for (const id of this.memberIds()) {
      const p = this.peers.get(id);
      if (p && id !== this.id) m = Math.max(m, Math.hypot(p.est.x - this.loc.est.x, p.est.z - this.loc.est.z));
    }
    return m;
  }
  reachForFollower() {
    const L = this.leaderState;
    if (!L || this.sim.t - L.t > 4) return 0;
    return Math.hypot(L.est.x - this.loc.est.x, L.est.z - this.loc.est.z);
  }

  /**
   * Adaptive transmit power: reach the 3rd-nearest neighbour with margin, or shout if
   * isolated. The margin grows with signal attenuation (rain/fog fade), the way a real
   * radio raises power when received signal strength drops.
   */
  txRange() {
    const c = this.cfg.comms, t = this.sim.t;
    if (t - this.lastRx > 3 * c.hbInterval) return c.maxRange;
    const ds = [];
    for (const n of this.neighbors.values()) if (t - n.t < 2) ds.push(n.range);
    if (ds.length < 2) return c.maxRange;
    ds.sort((a, b) => a - b);
    const k = Math.min(ds.length - 1, 2);
    const fade = this.sim.weather.commFactor();
    return clamp((ds[k] * 1.4) / fade, c.minRange, c.maxRange);
  }

  receive(env) {
    const t = this.sim.t;
    this.lastRx = t;
    this.neighbors.set(env.tx, { range: env.range, est: env.txEst, sigma: env.txSigma, t });
    if (this.flying() && this.status !== 'takeoff') {
      this.loc.rangeUpdate(env.txEst, env.txSigma, env.range, this.cfg.nav.rangeNoise);
    }
    const msg = env.msg;
    if (this.seen.has(msg.mid)) {
      const p = this.pendingRelays.get(msg.mid);
      if (p) {
        p.count++;
        p.minRange = Math.min(p.minRange, env.range);
      }
      return;
    }
    this.seen.set(msg.mid, t);
    // Distance-based relay suppression: rebroadcast after a short random delay, unless a
    // drone very close to us already transmitted it (our extra coverage would be small).
    if (msg.ttl > 0) {
      this.pendingRelays.set(msg.mid, {
        msg: { ...msg, ttl: msg.ttl - 1 },
        count: 1,
        minRange: env.range,
        at: t + this.cfg.dt * (1 + this.sim.rng.int(3)),
      });
    }
    if (msg.origin !== this.id) this.handle(msg);
  }

  flushRelays() {
    const t = this.sim.t;
    for (const [mid, p] of this.pendingRelays) {
      if (t < p.at) continue;
      if (p.count < 2 || p.minRange > 0.35 * this.txRange()) this.transmit(p.msg);
      this.pendingRelays.delete(mid);
    }
  }

  handle(msg) {
    const t = this.sim.t;
    const p = msg.payload;
    switch (msg.type) {
      case 'STATUS':
        this.peers.set(msg.origin, { ...p, id: msg.origin, t });
        if (this.isLeader && this.plan && p.planVer < this.plan.ver && t - this.lastPlanSent > 2) this.broadcastPlan();
        break;
      case 'LEAVE':
        this.peers.delete(msg.origin);
        this.neighbors.delete(msg.origin);
        break;
      case 'PLAN':
        if (!this.plan || p.ver > this.plan.ver) this.plan = p;
        break;
      case 'HB':
        this.onHeartbeat(msg.origin, p);
        break;
      case 'ELECT':
        this.onElect(p);
        break;
      case 'HANDOVER':
        this.onHandover(p);
        break;
      case 'JAM': {
        if (!this.cfg.jammers.reaction) break;
        const isNew = this.learnJam(p.x, p.z, p.r, p.kind);
        if (this.isLeader) this.onJamFound(isNew, p, p.kind);
        break;
      }
      case 'THREAT': {
        if (!this.cfg.threats.reaction) break;
        const isNew = this.learnThreat(p.x, p.z, p.r);
        this.dispersalUntil = this.sim.t + 20;
        if (this.isLeader) this.onThreatAlarm(isNew, p);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- protocol
  onHeartbeat(from, p) {
    const t = this.sim.t;
    this.peers.set(from, { id: from, est: p.est, sigma: p.sigma, battery: p.battery, score: p.score, status: p.status, planVer: p.planVer, t });

    if (this.isLeader) {
      // Two leaders (e.g. after a partition heals): the one leading more drones wins,
      // ties broken by score. The winner bumps the term so everyone converges on it.
      const mineN = this.memberIds().length;
      const theirs = p.memberCount > mineN || (p.memberCount === mineN && p.score > this.score());
      if (!theirs) {
        this.term = Math.max(this.term, p.term) + 1;
        this.sendHeartbeat();
        return;
      }
      this.isLeader = false;
      this.term = p.term;
      this.sim.log('leader', `D${this.id} meets leader D${from} (larger group) and steps down`);
    }
    if (p.term < this.term) return;
    if (this.leaderId !== from && this.leaderId !== null && p.term === this.term && this.lastLeaderHeard > t - 1) {
      // Same term, different leader than the one we follow: keep the current one; the
      // leaders resolve it between themselves.
      return;
    }
    this.term = p.term;
    this.leaderId = from;
    this.election = null;
    this.lastLeaderHeard = t;
    this.leaderState = { est: p.est, vel: p.vel, heading: p.heading, t };
    if (p.anchor && this.flying()) this.loc.applyGroupAnchor(p.anchor);
    this.wpIdx = p.wpIdx;
    this.arrived = p.arrived;
    this.departed = p.departed;
    if (p.formation.ver !== this.formation.ver) {
      // The leader ships the slot geometry itself, so any (custom) shape works.
      this.formation = { ver: p.formation.ver, sig: p.formation.sig, slots: new Map(p.formation.slots) };
      this.slotTable = p.formation.table;
    }
  }

  startElection() {
    const t = this.sim.t;
    this.term += 1;
    this.leaderId = null;
    this.isLeader = false;
    const s = this.score();
    this.election = { term: this.term, best: { id: this.id, score: s }, end: t + 3 * this.cfg.comms.hbInterval };
    if (this.sim.logOnce(`elect-${this.term}`, 'election', `D${this.id} lost contact with the leader, starts election (term ${this.term})`)) {
      this.sim.stats.elections++;
    }
    this.send('ELECT', { term: this.term, cand: this.id, score: s });
  }

  onElect({ term, cand, score }) {
    const t = this.sim.t;
    if (term < this.term) {
      if (this.isLeader) this.sendHeartbeat(); // tell the stale candidate who leads
      return;
    }
    if (this.isLeader) {
      // An incumbent that is still healthy defends its position by bumping the term.
      if (this.score() > score) {
        this.term = term + 1;
        this.sendHeartbeat();
        return;
      }
      this.isLeader = false;
    }
    if (term > this.term || !this.election) {
      this.term = term;
      this.leaderId = null;
      this.election = { term, best: { id: cand, score }, end: t + 3 * this.cfg.comms.hbInterval };
    } else if (score > this.election.best.score) {
      this.election.best = { id: cand, score };
    }
    const my = this.score();
    if (my > this.election.best.score) {
      this.election.best = { id: this.id, score: my };
      this.send('ELECT', { term: this.term, cand: this.id, score: my });
    }
  }

  onHandover({ term, newLeader, from, reason }) {
    if (term < this.term) return;
    this.term = term;
    this.election = null;
    this.lastLeaderHeard = this.sim.t;
    if (newLeader === this.id) this.becomeLeader(`handover from D${from} (${reason})`);
    else {
      this.isLeader = false;
      this.leaderId = newLeader;
    }
  }

  becomeLeader(reason) {
    const t = this.sim.t;
    this.isLeader = true;
    this.leaderId = this.id;
    this.election = null;
    this.leaderSince = t;
    this.lastLeaderHeard = t;
    this.handoverDone = false;
    if (this.leaderState) this.heading = this.leaderState.heading;
    this.sim.onLeaderChange(this, reason);
    if (!this.plan) this.replan('initial route');
    this.reassign(true);
    this.sendHeartbeat();
  }

  handover(to, reason) {
    this.term += 1;
    this.isLeader = false;
    this.leaderId = to;
    this.lastLeaderHeard = this.sim.t;
    this.handoverDone = true;
    this.sim.log('leader', `D${this.id} hands control to D${to} (${reason})`);
    this.send('HANDOVER', { term: this.term, newLeader: to, from: this.id, reason });
  }

  bestSuccessor() {
    const t = this.sim.t;
    let best = null;
    for (const id of this.memberIds()) {
      if (id === this.id) continue;
      const p = this.peers.get(id);
      if (!p || t - p.t > 3) continue;
      if (!best || p.score > best.score) best = p;
    }
    return best;
  }

  /** Mean (odo - est) over the group: how far the shared frame sits from the fair average. */
  groupAnchor() {
    const t = this.sim.t;
    let sx = this.loc.odo.x - this.loc.est.x, sz = this.loc.odo.z - this.loc.est.z, n = 1;
    for (const id of this.memberIds()) {
      const p = this.peers.get(id);
      if (id === this.id || !p?.odo || t - p.t > 2) continue;
      sx += p.odo.x - p.est.x;
      sz += p.odo.z - p.est.z;
      n++;
    }
    return n >= 2 ? { x: sx / n, z: sz / n } : null;
  }

  sendHeartbeat() {
    const t = this.sim.t;
    this.nextHb = t + this.cfg.comms.hbInterval;
    const anchor = this.departed ? this.groupAnchor() : null;
    if (anchor) this.loc.applyGroupAnchor(anchor);
    this.send('HB', {
      anchor,
      term: this.term,
      est: clone(this.loc.est),
      sigma: this.loc.sigma,
      vel: { x: this.loc.measVel.x, y: 0, z: this.loc.measVel.z },
      heading: this.heading,
      wpIdx: this.wpIdx,
      planVer: this.plan?.ver ?? 0,
      arrived: this.arrived,
      departed: this.departed,
      status: this.status,
      battery: this.batteryFrac(),
      score: this.score(),
      memberCount: this.memberIds().length,
      formation: {
        sig: this.formation.sig,
        table: this.slotTable,
        ver: this.formation.ver,
        slots: [...this.formation.slots.entries()],
      },
    }, this.cfg.comms.ttl, this.reachForLeader());
  }

  sendStatus() {
    this.nextStatus = this.sim.t + 2 * this.cfg.comms.hbInterval;
    this.send('STATUS', {
      term: this.term,
      est: clone(this.loc.est),
      odo: { x: this.loc.odo.x, z: this.loc.odo.z },
      sigma: this.loc.sigma,
      battery: this.batteryFrac(),
      score: this.score(),
      status: this.status,
      planVer: this.plan?.ver ?? 0,
    }, this.cfg.comms.ttl, this.reachForFollower());
  }

  broadcastPlan() {
    this.lastPlanSent = this.sim.t;
    this.send('PLAN', this.plan, this.cfg.comms.ttl + 1);
  }

  replan(reason) {
    // Avoid known threats (+ margin); if that leaves no route, accept the risk.
    const zones = this.threatZones().map((z) => ({ ...z, r: z.r + 60 }));
    let res = this.sim.planRoute(this.loc.est, zones);
    if (!res.ok && zones.length) {
      this.sim.log('warn', `D${this.id}: no route around known threats - accepting exposure`);
      res = this.sim.planRoute(this.loc.est);
    }
    if (!res.ok) {
      this.sim.log('warn', `D${this.id} could not plan a route: ${res.reason}`);
      return false;
    }
    this.plan = { ver: this.sim.nextVer(), waypoints: res.waypoints, length: res.length };
    this.wpIdx = 1;
    this.arrived = false;
    this.sim.log('plan', `D${this.id} planned route (${reason}): ${res.waypoints.length} waypoints, ${(res.length / 1000).toFixed(2)} km`);
    this.broadcastPlan();
    return true;
  }

  /** Leader: recompute slots when membership (or formation settings) change. */
  reassign(force = false) {
    const ids = this.memberIds();
    const cur = [...this.formation.slots.keys()].sort((a, b) => a - b);
    const sw = this.cfg.swarm;
    const dispersed = this.sim.t < this.dispersalUntil;
    const sig = this.sim.formationSig(dispersed);
    const changedSettings = this.formation.sig !== sig;
    const same = ids.length === cur.length && ids.every((v, i) => v === cur[i]);
    if (same && !force && !changedSettings) return;
    const lost = cur.filter((id) => !ids.includes(id));
    const joined = cur.length ? ids.filter((id) => !cur.includes(id)) : [];
    const members = ids.map((id) => ({ id, pos: id === this.id ? this.loc.est : this.peers.get(id).est }));
    const table = this.sim.formationTable(ids.length, dispersed);
    const slots = assignSlots(members, this.id, this.loc.est, this.heading, table);
    const wasDispersed = this.formation.sig ? JSON.parse(this.formation.sig)[4] : false;
    this.formation = { ver: this.sim.nextVer(), sig, slots };
    this.slotTable = table;
    if (lost.length) this.sim.log('reorg', `Leader D${this.id} lost contact with ${lost.map((i) => 'D' + i).join(', ')} - reorganising ${ids.length} drones`);
    if (joined.length) this.sim.log('reorg', `Leader D${this.id}: ${joined.map((i) => 'D' + i).join(', ')} joined - reorganising`);
    if (changedSettings && !lost.length && !joined.length && cur.length) {
      if (dispersed !== wasDispersed) this.sim.log('reorg', dispersed ? `Leader D${this.id}: under fire - dispersing formation` : `Leader D${this.id}: threat passed - closing up formation`);
      else this.sim.log('reorg', `Formation changed to ${sw.formation} @ ${sw.spacing} m`);
    }
  }

  protocolTick() {
    const t = this.sim.t;
    const c = this.cfg.comms;
    // Housekeeping
    if (this.sim.tick % 50 === this.id % 50) {
      for (const [mid, ts] of this.seen) if (t - ts > 15) this.seen.delete(mid);
      for (const [id, n] of this.neighbors) if (t - n.t > 5) this.neighbors.delete(id);
    }
    if (!IN_SWARM.has(this.status)) return;

    if (this.isLeader) {
      if (t >= this.nextHb) {
        this.reassign();
        this.sendHeartbeat();
      }
      const bf = this.batteryFrac();
      if (!this.handoverDone && bf < this.cfg.drone.handoverBattery) {
        const s = this.bestSuccessor();
        if (s && s.battery > bf + 0.05) this.handover(s.id, `battery ${(bf * 100).toFixed(0)}%`);
        else this.handoverDone = true; // nobody better; keep leading
      }
    } else {
      if (t >= this.nextStatus) this.sendStatus();
      if (this.election) {
        if (t >= this.election.end) {
          const e = this.election;
          this.election = null;
          if (e.best.id === this.id) this.becomeLeader(`won election (term ${this.term})`);
          else this.lastLeaderHeard = t; // wait for the winner's heartbeat
        }
      } else if (t - this.lastLeaderHeard > this.leaderTimeout) {
        this.startElection();
      }
    }
  }

  // ---------------------------------------------------------------- guidance
  terrainAt(p) {
    return this.sim.terrain.heightAt(p.x, p.z);
  }

  leaderGuidance(t) {
    const sw = this.cfg.swarm;
    const est = this.loc.est;
    if (!this.plan) return this.hover(est);
    const wps = this.plan.waypoints;
    if (!this.departed) {
      const ready = this.memberIds().every((id) => id === this.id || this.peers.get(id)?.status === 'enroute');
      if ((ready && t - this.leaderSince > 1) || t - this.leaderSince > 25) {
        this.departed = true;
        this.sim.log('mission', `Swarm departs (${this.memberIds().length} drones, leader D${this.id})`);
      } else {
        return this.hover(est);
      }
    }
    while (this.wpIdx < wps.length && distH(est, wps[this.wpIdx]) < 20) this.wpIdx++;
    if (this.wpIdx >= wps.length && !this.arrived) {
      this.arrived = true;
      this.sim.onArrival(this);
    }
    const idx = Math.min(this.wpIdx, wps.length - 1);
    const target = wps[idx];
    const prevY = wps[Math.max(0, idx - 1)].y;
    const to = sub(target, est);
    const dH = lenH(to);
    let speed = sw.cruiseSpeed * this.cohesion();
    if (idx === wps.length - 1) speed = Math.min(speed, dH * 0.3);
    const dir = dH > 1e-3 ? { x: to.x / dH, z: to.z / dH } : { x: 0, z: 0 };
    if (dH > 5) {
      const want = headingOf(dir.x, dir.z);
      const maxTurn = (35 * Math.PI) / 180 * this.cfg.dt;
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(want - this.heading), -maxTurn, maxTurn));
    }
    const yT = this.arrived ? target.y : Math.max(target.y, prevY);
    return { x: dir.x * speed, y: (yT - est.y) * 0.8, z: dir.z * speed };
  }

  /** Leader slows down when followers lag behind their slots. */
  cohesion() {
    const t = this.sim.t;
    let sum = 0, n = 0;
    for (const [id, s] of this.formation.slots) {
      if (id === this.id) continue;
      const p = this.peers.get(id);
      const off = this.slotTable[s];
      if (!p || !off || t - p.t > 3) continue;
      const w = offsetToWorld(off, this.heading);
      sum += Math.hypot(this.loc.est.x + w.x - p.est.x, this.loc.est.z + w.z - p.est.z);
      n++;
    }
    if (!n) return 1;
    return clamp(1 - (sum / n - 12) / 50, 0.35, 1);
  }

  followerGuidance(t) {
    const L = this.leaderState;
    const est = this.loc.est;
    const age = t - L.t;
    const lp = { x: L.est.x + L.vel.x * age, y: L.est.y, z: L.est.z + L.vel.z * age };
    const slot = this.formation.slots.get(this.id);
    const sp = this.cfg.swarm.spacing;
    const off = slot !== undefined && this.slotTable[slot]
      ? this.slotTable[slot]
      : { f: -2 * sp, r: ((this.id % 5) - 2) * sp * 0.6, u: 6 }; // parking spot until assigned
    const target = add(lp, offsetToWorld(off, L.heading));
    this.heading = L.heading;
    const err = sub(target, est);
    const v = { x: L.vel.x + err.x * 0.5, y: err.y * 0.8, z: L.vel.z + err.z * 0.5 };
    return clampH(v, this.cfg.swarm.maxSpeed);
  }

  /** Cruise height above the takeoff ground, raised so the lowest slot of a 3D formation clears it. */
  hoverAlt() {
    return this.groundY + this.cfg.swarm.cruiseAGL + this.sim.formationExtent().below;
  }

  hover(est) {
    return { x: 0, y: (this.hoverAlt() - est.y) * 0.5, z: 0 };
  }

  guidance(t) {
    const est = this.loc.est;
    const d = this.cfg.drone;
    let v;
    switch (this.status) {
      case 'takeoff': {
        v = { x: 0, y: this.groundY + this.cfg.swarm.cruiseAGL - est.y, z: 0 };
        if (est.y > this.groundY + this.cfg.swarm.cruiseAGL - 4) this.status = 'enroute';
        break;
      }
      case 'landing': {
        // Emergency descent (6 m/s) when the remaining energy would not cover a normal one.
        const agl = this.agl();
        const pw = d.hoverPowerW * this.sim.weather.powerFactor() + this.batteryLeak * this.batteryCapJ;
        const urgent = this.batteryJ < 1.5 * (agl / d.maxDescent + 10) * pw;
        const rate = agl > 15 ? (urgent ? 6 : d.maxDescent) : agl > 6 ? 2 : 0.8;
        return { x: 0, y: -rate, z: 0 };
      }
      default:
        if (this.isLeader) v = this.leaderGuidance(t);
        else if (this.leaderState && t - this.leaderState.t < 4) v = this.followerGuidance(t);
        else v = { x: 0, y: 0, z: 0 }; // hold position while the swarm elects a leader
    }
    // Evasive manoeuvring when targeted: random lateral/vertical jinks every ~0.8 s.
    if (this.isEvading() && this.status !== 'takeoff') {
      if (!this.jink || t > this.jink.until) {
        const s = lenH(v) > 0.5 ? { x: v.x / lenH(v), z: v.z / lenH(v) } : { x: 1, z: 0 };
        const side = this.sim.rng.next() < 0.5 ? -1 : 1;
        this.jink = { x: -s.z * side * 7, y: this.sim.rng.uniform(-2.5, 3), z: s.x * side * 7, until: t + 0.8 };
      }
      v = { x: v.x + this.jink.x, y: v.y + this.jink.y, z: v.z + this.jink.z };
    }
    // Terrain look-ahead on the onboard elevation map (DEM), from the drone's own estimate:
    // climb early, and slow down horizontally if the climb rate can't clear a slope ahead.
    const hs = lenH(v);
    if (hs > 0.5 && this.status !== 'takeoff') {
      const dx = v.x / hs, dz = v.z / hs;
      const climbMax = d.maxClimb * 0.8;
      let allowed = hs, climb = -Infinity;
      for (let s = 10; s <= 90; s += 10) {
        const req = this.sim.terrain.heightAt(est.x + dx * s, est.z + dz * s) + this.cfg.swarm.minAGL + 6;
        const deficit = req - est.y;
        if (deficit <= 0) continue;
        allowed = Math.min(allowed, (climbMax * s) / deficit);
        climb = Math.max(climb, (deficit * Math.min(hs, allowed)) / s + 0.5);
      }
      if (allowed < hs) {
        const k = Math.max(0.5, allowed) / hs;
        v = { x: v.x * k, y: v.y, z: v.z * k };
      }
      if (climb > v.y) v.y = climb;
    }
    // Collision avoidance from the short-range proximity sensor (relative position and
    // velocity of nearby drones), using closest-point-of-approach prediction. Runs after
    // path/terrain shaping so nothing overrides it; conflicts are also resolved
    // vertically by id so two drones never dodge into each other.
    const sep = Math.max(7, Math.min(12, this.cfg.swarm.spacing * 0.45));
    // Horizon covers the braking distance at max speed (v^2 / 2a ~ 32 m at 18 m/s).
    for (const o of this.sim.proximity(this, 60)) {
      const vv = o.relVel;
      const v2 = vv.x * vv.x + vv.y * vv.y + vv.z * vv.z;
      const tca = v2 > 1e-6 ? clamp(-(o.rel.x * vv.x + o.rel.y * vv.y + o.rel.z * vv.z) / v2, 0, 4) : 0;
      const m = add(o.rel, scale(vv, tca));
      const dm = Math.hypot(m.x, m.y, m.z);
      if (dm >= sep) continue;
      const urgency = clamp((2 * (sep - dm)) / sep, 0, 1) / (1 + 0.5 * tca);
      // Cancel the part of our desired velocity that closes on the other drone...
      const to = norm({ x: o.rel.x, y: 0, z: o.rel.z });
      const closing = v.x * to.x + v.z * to.z;
      if (closing > 0) v = { x: v.x - to.x * closing * urgency, y: v.y, z: v.z - to.z * closing * urgency };
      // ...then push apart, sideways if it's head-on, and vertically by id.
      let away = scale(m, -1);
      if (dm < 0.3) away = { x: -o.rel.z, y: 0, z: o.rel.x };
      const u = norm({ x: away.x, y: 0, z: away.z });
      const strength = 8 * urgency;
      v = add(v, scale(u, strength));
      v.y += (this.id > o.id ? 1 : -1) * strength * 0.6;
    }
    // Hard terrain floor from the downward rangefinder.
    const agl = this.agl();
    if (agl < this.cfg.swarm.minAGL && this.status !== 'takeoff') {
      v.y = Math.max(v.y, (this.cfg.swarm.minAGL - agl) * 1.2 + 1.5);
    }
    if (est.y > this.cfg.swarm.maxAltitude) v.y = Math.min(v.y, -1);
    v = clampH(v, this.cfg.swarm.maxSpeed);
    v.y = clamp(v.y, -d.maxDescent, d.maxClimb);
    return v;
  }

  agl() {
    return this.truePos.y - this.terrainAt(this.truePos) + this.sim.rng.gauss(0, 0.2);
  }

  // ---------------------------------------------------------------- lifecycle
  startTakeoff() {
    this.status = 'takeoff';
    this.groundY = this.terrainAt(this.truePos);
  }

  startLanding(reason) {
    if (!this.flying() || this.status === 'landing') return;
    if (this.isLeader) {
      const s = this.bestSuccessor();
      if (s) this.handover(s.id, reason);
      this.isLeader = false;
    }
    this.send('LEAVE', { reason });
    this.status = 'landing';
    this.sim.log('failure', `D${this.id} leaves the swarm and lands (${reason})`);
  }

  crash(reason, explode = false) {
    if (this.status === 'crashed') return;
    this.status = 'crashed';
    this.active = false;
    this.isLeader = false;
    this.failure = reason;
    this.sim.addExplosion(this.truePos, explode);
    this.sim.log('failure', `D${this.id} down: ${reason}`);
  }

  // ---------------------------------------------------------------- step
  update(dt) {
    const t = this.sim.t;
    const { weather, rng } = this.sim;
    const d = this.cfg.drone;

    if (this.status === 'crashed') {
      const gy = this.terrainAt(this.truePos);
      if (this.truePos.y > gy) {
        this.trueVel.y -= G * dt;
        this.trueVel.x *= 0.98;
        this.trueVel.z *= 0.98;
        this.truePos = add(this.truePos, scale(this.trueVel, dt));
        if (this.truePos.y < gy) {
          this.truePos.y = gy;
          this.trueVel = v3();
        }
      }
      return;
    }
    if (this.status === 'ground' || this.status === 'landed') return;

    if (this.active) {
      this.protocolTick();
      this.flushRelays();
    }
    if (this.status !== 'landing' && this.status !== 'takeoff') {
      // Land when below the fixed reserve, or when the remaining energy only just covers
      // a descent from the current height (+30% and 15 s margin), whichever comes first.
      const tLand = this.agl() / d.maxDescent + 15;
      const need = 1.3 * tLand * (d.hoverPowerW * weather.powerFactor() + this.batteryLeak * this.batteryCapJ);
      const bf = this.batteryFrac();
      if (bf < d.landBattery || this.batteryJ < need) this.startLanding(`battery ${(bf * 100).toFixed(0)}%`);
    }

    // Velocity controller (PI on measured velocity) with drag feed-forward.
    const vDes = this.guidance(t);
    const vm = this.loc.measVel;
    const err = sub(vDes, vm);
    this.vInt = clampH(add(this.vInt, scale(err, dt)), 8);
    this.vInt.y = clamp(this.vInt.y, -3, 3);
    const spdM = lenH(vm);
    let a = {
      x: 1.8 * err.x + 0.5 * this.vInt.x + d.dragCoeff * vm.x * spdM,
      y: 2.0 * err.y + 0.4 * this.vInt.y,
      z: 1.8 * err.z + 0.5 * this.vInt.z + d.dragCoeff * vm.z * spdM,
    };
    a = clampH(a, d.maxAccel);
    a.y = clamp(a.y, -4, 4);

    // Physics: thrust + quadratic drag relative to the air mass.
    const wind = weather.windAt(this.truePos, t, rng);
    const air = sub(this.trueVel, wind);
    const airSpd = Math.hypot(air.x, air.y, air.z);
    this.trueVel.x += (a.x - d.dragCoeff * air.x * airSpd) * dt;
    this.trueVel.y += (a.y - d.dragCoeff * air.y * airSpd) * dt;
    this.trueVel.z += (a.z - d.dragCoeff * air.z * airSpd) * dt;
    this.truePos = add(this.truePos, scale(this.trueVel, dt));

    // Sensing for this tick, after the motion it measures (odometry integrates the same
    // velocity that moved the drone; otherwise the estimate lags truth by v*dt).
    this.loc.predict(this.trueVel, this.truePos.y, dt, weather.sensorNoiseFactor());
    this.sim.detectBeacons(this, dt);

    // Energy
    const P =
      d.hoverPowerW * weather.powerFactor() +
      d.aeroCoeff * airSpd ** 3 +
      (d.massKg * G * Math.max(0, this.trueVel.y)) / 0.7;
    const e = P * dt + this.batteryLeak * this.batteryCapJ * dt;
    this.batteryJ -= e;
    this.propEnergyJ += P * dt;

    const gy = this.terrainAt(this.truePos);
    if (this.truePos.y <= gy) {
      if (this.status === 'landing') {
        this.truePos.y = gy;
        this.trueVel = v3();
        this.status = 'landed';
        this.active = false;
        this.sim.log('info', `D${this.id} landed safely`);
      } else {
        this.truePos.y = gy;
        this.crash('terrain impact');
      }
    } else if (this.batteryJ <= 0) {
      this.crash('battery depleted');
    }

    if (this.sim.tick % 5 === 0) {
      this.trail.push(clone(this.truePos));
      if (this.trail.length > 400) this.trail.shift();
    }
  }
}

export { formationRadius };
