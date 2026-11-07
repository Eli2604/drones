// Headless algorithm tests: `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/core/sim.js';
import { Terrain } from '../src/core/terrain.js';
import { planPath } from '../src/core/planner.js';
import { assignSlots, slotOffsets, FORMATIONS } from '../src/core/formation.js';

const leaders = (sim) => sim.drones.filter((d) => d.isLeader && d.active && d.radioOk);

test('a single leader is elected after takeoff', () => {
  const sim = new Simulation({ seed: 3 });
  sim.run(10);
  assert.equal(leaders(sim).length, 1);
  const L = leaders(sim)[0];
  for (const d of sim.drones) assert.equal(d.leaderId, L.id, `D${d.id} follows D${d.leaderId}`);
  assert.ok(L.plan, 'leader has a route');
  assert.ok(sim.drones.every((d) => d.plan?.ver === L.plan.ver), 'route shared with the swarm');
});

test('leader crash: new leader within 5 s and formation reorganised', () => {
  const sim = new Simulation({ seed: 5 });
  sim.run(40);
  const old = sim.injectFailure('leader', 'crash');
  assert.ok(old);
  sim.run(5);
  const ls = leaders(sim);
  assert.equal(ls.length, 1, 'exactly one leader');
  assert.notEqual(ls[0].id, old.id);
  sim.run(5);
  const slots = ls[0].formation.slots;
  assert.equal(slots.size, sim.drones.length - 1, 'crashed drone removed from formation');
  assert.ok(!slots.has(old.id));
  assert.equal(new Set(slots.values()).size, slots.size, 'slots are unique');
});

test('battery fault on leader triggers a graceful handover and landing', () => {
  const sim = new Simulation({ seed: 8 });
  sim.run(30);
  const old = sim.injectFailure('leader', 'battery');
  sim.run(60);
  assert.ok(['landing', 'landed'].includes(old.status), `old leader status ${old.status}`);
  const ls = leaders(sim);
  assert.equal(ls.length, 1);
  assert.notEqual(ls[0].id, old.id);
  assert.ok(sim.events.some((e) => e.text.includes(`D${old.id} hands control`)), 'handover logged');
});

test('mission completes despite two failures', () => {
  const sim = new Simulation({
    seed: 11,
    failures: [
      { t: 30, target: 'leader', type: 'crash' },
      { t: 70, target: 'random', type: 'radio' },
    ],
  });
  for (let i = 0; i < 60 && !sim.arrivalTime; i++) sim.run(10);
  assert.ok(sim.arrivalTime, 'destination reached');
  assert.equal(sim.stats.collisions, 0, 'no mid-air collisions');
  assert.ok(sim.drones.filter((d) => d.status === 'crashed').length <= 1, 'only the injected crash');
});

test('localisation layers each do their job (mean over seeds)', () => {
  // Statistical effects: compare means over several seeds rather than a single run.
  //  - ranging tightens the RELATIVE geometry (spread of errors around their mean)
  //  - grouped telemetry anchors the shared frame -> lower absolute error
  //  - landmarks remove the remaining absolute drift
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const run = (mode) => {
    let abs = 0, spread = 0;
    for (const seed of SEEDS) {
      const sim = new Simulation({ seed, nav: { beaconCount: mode === 'landmarks' ? 14 : 0 } });
      for (const d of sim.drones) {
        if (mode === 'dr') d.loc.rangeUpdate = () => {};
        if (mode === 'dr' || mode === 'ranging') d.loc.applyGroupAnchor = () => {};
      }
      for (let i = 0; i < 16; i++) {
        sim.run(10);
        abs += sim.metrics().meanErr;
        const e = sim.drones.map((d) => ({ x: d.loc.est.x - d.truePos.x, z: d.loc.est.z - d.truePos.z }));
        const mx = e.reduce((a, b) => a + b.x, 0) / e.length, mz = e.reduce((a, b) => a + b.z, 0) / e.length;
        spread += e.reduce((a, b) => a + Math.hypot(b.x - mx, b.z - mz), 0) / e.length;
      }
    }
    const n = SEEDS.length * 16;
    return { abs: abs / n, spread: spread / n };
  };
  const dr = run('dr'), ranging = run('ranging'), grouped = run('grouped'), landmarks = run('landmarks');
  assert.ok(ranging.spread < dr.spread / 2, `ranging spread ${ranging.spread.toFixed(1)} << dead-reckoning spread ${dr.spread.toFixed(1)}`);
  assert.ok(grouped.abs < dr.abs * 0.7, `grouped ${grouped.abs.toFixed(1)} < 0.7 x dead reckoning ${dr.abs.toFixed(1)}`);
  assert.ok(landmarks.abs < grouped.abs, `landmarks ${landmarks.abs.toFixed(1)} < grouped ${grouped.abs.toFixed(1)}`);
});

test('estimator is unbiased with perfect sensors (no timing artefacts)', () => {
  const sim = new Simulation({
    seed: 1,
    nav: { beaconCount: 0, scaleErr: 0, biasInit: 0, biasWalk: 0, odomNoise: 0, rangeNoise: 0 },
    weather: { turbulence: 0, gustiness: 0 },
  });
  sim.run(150);
  for (const d of sim.drones) {
    const e = Math.hypot(d.loc.est.x - d.truePos.x, d.loc.est.z - d.truePos.z);
    assert.ok(e < 0.5, `D${d.id} drifted ${e.toFixed(2)} m with perfect sensors`);
  }
});

test('planner avoids no-fly zones and respects the ceiling', () => {
  const terrain = new Terrain({ seed: 2, preset: 'mountains' });
  const noFly = [{ x: 0, z: 0, r: 250 }];
  const res = planPath({
    terrain,
    start: { x: -900, z: 900 },
    goal: { x: 900, z: -900 },
    noFly,
    opts: { clearance: 40, maxAltitude: 480, corridor: 40 },
  });
  assert.ok(res.ok, res.reason);
  const wps = res.waypoints;
  for (let k = 1; k < wps.length; k++) {
    for (let s = 0; s <= 10; s++) {
      const x = wps[k - 1].x + ((wps[k].x - wps[k - 1].x) * s) / 10;
      const z = wps[k - 1].z + ((wps[k].z - wps[k - 1].z) * s) / 10;
      assert.ok(Math.hypot(x, z) > 250, 'route enters no-fly zone');
    }
    assert.ok(wps[k].y <= 480);
  }
});

test('slot assignment is a permutation for every formation', () => {
  for (const type of FORMATIONS) {
    for (let n = 1; n <= 12; n++) {
      const members = Array.from({ length: n }, (_, i) => ({ id: i * 3, pos: { x: i * 7, y: 0, z: -i * 5 } }));
      const slots = assignSlots(members, 0, members[0].pos, 0.3, type, 20);
      assert.equal(slots.get(0), 0);
      assert.equal(slots.size, n);
      assert.equal(new Set(slots.values()).size, n);
      assert.equal(slotOffsets(type, n, 20).length, n);
    }
  }
});
