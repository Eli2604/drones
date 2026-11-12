import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/core/sim.js';
import { jamAt } from '../src/core/jamming.js';

test('jamming strength: full inside 0.8 R, fading to nothing at R, by kind', () => {
  const J = [{ x: 0, z: 0, y: 0, r: 100, type: 'gnss' }, { x: 500, z: 0, y: 0, r: 100, type: 'comms' }];
  assert.deepEqual(jamAt(J, { x: 10, y: 0, z: 0 }), { comms: 0, gnss: 1 });
  assert.equal(jamAt(J, { x: 90, y: 0, z: 0 }).gnss.toFixed(2), '0.50');
  assert.deepEqual(jamAt(J, { x: 500, y: 0, z: 50 }), { comms: 1, gnss: 0 });
  assert.deepEqual(jamAt(J, { x: 250, y: 0, z: 0 }), { comms: 0, gnss: 0 });
});

test('a GNSS jammer cuts the fixes; the swarm notices, shares it and still navigates', () => {
  const sim = new Simulation({ seed: 3, nav: { gnss: true }, swarm: { count: 6 }, jammers: { custom: [{ x: -600, z: 600, type: 'gnss', r: 400 }] } });
  sim.run(25);
  const fixesOutside = sim.stats.gnssFixes;
  assert.ok(fixesOutside > 0, 'fixes outside the jammer');
  // everyone near the origin is inside 400 m of (-600, 600)? origin (-850, 850) is 354 m away: jammed
  const fl = sim.drones.filter((d) => d.flying());
  assert.ok(fl.some((d) => d.jam.gnss >= 0.5 || !d.gnssOk) || sim.events.some((e) => /GNSS lost/.test(e.text)), 'GNSS jammed near the jammer');
  sim.run(60);
  const L = sim.leader;
  assert.ok(L && L.jamZones.size > 0, 'the leader knows where the jamming is');
  assert.ok(sim.events.some((e) => e.type === 'ew' && /rerouting/.test(e.text)), 'rerouted around it');
  const m = sim.metrics();
  assert.ok(m.meanErr < 40, `localisation still holds without GNSS (mean error ${m.meanErr.toFixed(1)} m)`);
});

test('a radio jammer drops packets to drones inside and cuts the link to the central; orders wait', () => {
  const sim = new Simulation({ seed: 5, swarm: { count: 6 }, jammers: { custom: [{ x: -520, z: 520, type: 'comms', r: 300 }] } });
  // fly until the leader is in the jammer
  for (let k = 0; k < 900 && sim.leader?.c2Ok !== false; k++) sim.step();
  sim.run(3);
  assert.ok((sim.radio.stats.jammed ?? 0) > 0, 'packets lost to jamming');
  const L = sim.leader;
  assert.ok(L, 'there is still a leader');
  if (!L.c2Ok) {
    assert.equal(sim.setDestination(0, 0), null, 'the order is queued');
    assert.equal(sim.pendingOrders.length, 1);
    assert.ok(sim.events.some((e) => /queued/.test(e.text)));
  }
  sim.run(120);
  assert.ok(sim.events.some((e) => /lost the link to the central/.test(e.text)), 'C2 loss logged');
  if (sim.events.some((e) => /queued/.test(e.text))) assert.ok(sim.events.some((e) => /delivered/.test(e.text)), 'the order arrives once back in contact');
});

test('without jammers nothing changes: everyone in contact, no jamming', () => {
  const sim = new Simulation({ seed: 7, swarm: { count: 5 } });
  sim.run(30);
  assert.equal(sim.jammers.length, 0);
  assert.ok(sim.drones.filter((d) => d.flying()).every((d) => d.c2Ok && d.jam.comms === 0));
  assert.equal(sim.stats.gnssFixes, 0, 'GNSS is off by default (GNSS-denied design)');
});
