// Monte-Carlo robustness sweep: many seeds x terrains, each with scripted failures.
// Usage: node tools/sweep.mjs [seeds=40]
import { Simulation } from '../src/core/sim.js';

const SEEDS = Number(process.argv[2] ?? 40);
const PRESETS = ['flat', 'hills', 'valley', 'mountains'];
const FAILURES = [
  { t: 30, target: 'leader', type: 'crash' },
  { t: 70, target: 'random', type: 'radio' },
  { t: 100, target: 'leader', type: 'battery' },
];

const rows = [];
const problems = { notArrived: 0, collision: 0, terrain: 0, depleted: 0, splitBrain: 0 };
const t0 = Date.now();
for (const preset of PRESETS) {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sim = new Simulation({ seed, terrain: { preset }, failures: FAILURES });
    for (let i = 0; i < 70 && !sim.arrivalTime; i++) sim.run(10);
    sim.run(20); // let the swarm settle at the destination
    const unplanned = sim.drones.filter((d) => d.status === 'crashed' && !String(d.failure).includes('injected'));
    const leaders = sim.drones.filter((d) => d.isLeader && d.active && d.radioOk).length;
    const p = [];
    if (!sim.arrivalTime) p.push('notArrived');
    for (const d of unplanned) {
      if (d.failure.includes('collision')) p.push('collision');
      else if (d.failure.includes('terrain')) p.push('terrain');
      else if (d.failure.includes('battery')) p.push('depleted');
    }
    if (leaders !== 1) p.push('splitBrain');
    for (const k of new Set(p)) problems[k]++;
    const errs = sim.history.map((h) => h.meanErr);
    rows.push({ preset, seed, ok: p.length === 0, problems: p, arrival: sim.arrivalTime, meanErr: errs.reduce((a, b) => a + b, 0) / errs.length });
  }
}
const ok = rows.filter((r) => r.ok).length;
console.log(`${ok}/${rows.length} runs clean (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log('problem counts:', problems);
for (const preset of PRESETS) {
  const r = rows.filter((x) => x.preset === preset);
  const arr = r.filter((x) => x.arrival);
  console.log(
    preset.padEnd(10),
    `clean ${r.filter((x) => x.ok).length}/${r.length}`.padEnd(12),
    `mean arrival ${(arr.reduce((a, b) => a + b.arrival, 0) / Math.max(1, arr.length)).toFixed(0)} s`.padEnd(20),
    `mean nav error ${(r.reduce((a, b) => a + b.meanErr, 0) / r.length).toFixed(1)} m`,
  );
}
const bad = rows.filter((r) => !r.ok).slice(0, 10);
if (bad.length) console.log('first failing runs:', bad.map((r) => `${r.preset}#${r.seed}:${r.problems.join('+')}`).join(', '));
process.exitCode = ok === rows.length ? 0 : 1;
