// Formation geometry and slot assignment.
//
// Offsets are in the leader's body frame: f = forward, r = right, u = up. Preset shapes are
// defined in "spacing units" and scaled to metres: f, r by `spacing`, u by
// `spacing * vSpread`. Slot 0 is always the leader at (0, 0, 0). Many presets are truly
// 3D (diamond = octahedron shells, sphere, box, helix, star with tilted arms).

import { forwardOf, rightOf } from './vec.js';

export const FORMATIONS = ['v', 'line', 'column', 'wedge', 'echelon', 'diamond', 'star', 'circle', 'sphere', 'box', 'helix', 'grid', 'custom'];

export const FORMATION_LABELS = {
  v: 'V',
  line: 'Line abreast',
  column: 'Column',
  wedge: 'Wedge (filled triangle)',
  echelon: 'Echelon',
  diamond: 'Diamond (3D octahedron)',
  star: 'Star (3D arms)',
  circle: 'Circle',
  sphere: 'Sphere (3D)',
  box: 'Box (3D lattice)',
  helix: 'Helix',
  grid: 'Grid (flat)',
  custom: 'Custom (designer)',
};

const sideRank = (i) => [Math.ceil(i / 2), i % 2 ? -1 : 1];

/** Raw shape in spacing units, including the leader at index 0, for n drones. */
export function shapeUnits(type, n, custom = []) {
  const out = [{ f: 0, r: 0, u: 0 }];
  if (n <= 1) return out;
  const m = n - 1;
  switch (type) {
    case 'line':
      for (let i = 1; i <= m; i++) {
        const [k, s] = sideRank(i);
        out.push({ f: 0, r: s * k, u: 0.12 * k });
      }
      break;
    case 'column':
      for (let i = 1; i <= m; i++) out.push({ f: -i, r: 0, u: 0.12 * i });
      break;
    case 'wedge':
      for (let k = 1; out.length < n; k++) {
        for (let j = 0; j <= k && out.length < n; j++) out.push({ f: -0.8 * k, r: j - k / 2, u: -0.25 * k });
      }
      break;
    case 'echelon':
      for (let i = 1; i <= m; i++) out.push({ f: -0.7 * i, r: 0.9 * i, u: 0.2 * i });
      break;
    case 'diamond': {
      // Shells of the octahedron |f| + |r| + |u| = k on the integer lattice.
      for (let k = 1; out.length < n; k++) {
        const shell = [];
        for (let a = -k; a <= k; a++)
          for (let b = -k; b <= k; b++) {
            const c = k - Math.abs(a) - Math.abs(b);
            if (c < 0) continue;
            shell.push({ f: a, r: b, u: c });
            if (c > 0) shell.push({ f: a, r: b, u: -c });
          }
        shell.sort((p, q) => Math.abs(p.u) - Math.abs(q.u) || Math.atan2(p.r, p.f) - Math.atan2(q.r, q.f));
        for (const p of shell) if (out.length < n) out.push(p);
      }
      break;
    }
    case 'star': {
      const arms = 5;
      for (let k = 1; out.length < n; k++) {
        for (let a = 0; a < arms && out.length < n; a++) {
          const ang = (2 * Math.PI * a) / arms;
          out.push({ f: k * Math.cos(ang), r: k * Math.sin(ang), u: (a % 2 ? 0.45 : -0.3) * k });
        }
      }
      break;
    }
    case 'circle': {
      const R = Math.max(1, m / (2 * Math.PI));
      for (let i = 0; i < m; i++) {
        const a = (2 * Math.PI * i) / m;
        out.push({ f: R * Math.cos(a), r: R * Math.sin(a), u: i % 2 ? 0.2 : -0.2 });
      }
      break;
    }
    case 'sphere': {
      const R = Math.max(1, 0.32 * Math.sqrt(m));
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < m; i++) {
        const y = 1 - (2 * (i + 0.5)) / m;
        const rad = Math.sqrt(Math.max(0, 1 - y * y));
        out.push({ f: R * rad * Math.cos(i * golden), r: R * rad * Math.sin(i * golden), u: R * y });
      }
      break;
    }
    case 'box': {
      const s = Math.max(2, Math.ceil(Math.cbrt(n)));
      const pts = [];
      for (let a = 0; a < s; a++)
        for (let b = 0; b < s; b++)
          for (let c = 0; c < s; c++) pts.push({ f: -a, r: b - (s - 1) / 2, u: c - (s - 1) / 2 });
      // Leader = front face, nearest the centre.
      pts.sort((p, q) => -p.f - -q.f || Math.hypot(p.r, p.u) - Math.hypot(q.r, q.u));
      const L = pts[0];
      const rel = pts.slice(1).map((p) => ({ f: p.f - L.f, r: p.r - L.r, u: p.u - L.u }));
      rel.sort((p, q) => Math.hypot(p.f, p.r, p.u) - Math.hypot(q.f, q.r, q.u));
      out.push(...rel.slice(0, m));
      break;
    }
    case 'helix':
      for (let i = 1; i <= m; i++) out.push({ f: -0.6 * i, r: Math.cos(i * 1.05), u: Math.sin(i * 1.05) });
      break;
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      const all = [];
      for (let i = 0; i < n; i++) all.push({ f: -Math.floor(i / cols), r: (i % cols) - (cols - 1) / 2, u: 0 });
      const li = Math.floor((Math.min(cols, n) - 1) / 2);
      const L = all[li];
      all.forEach((s, i) => i !== li && out.push({ f: s.f - L.f, r: s.r - L.r, u: 0 }));
      break;
    }
    case 'custom': {
      for (let i = 0; i < Math.min(m, custom.length); i++) out.push({ ...custom[i] });
      // More drones than designed slots: queue the extras in a column behind.
      let minF = Math.min(0, ...out.map((p) => p.f));
      while (out.length < n) out.push({ f: (minF -= 1), r: 0, u: 0 });
      break;
    }
    case 'v':
    default:
      for (let i = 1; i <= m; i++) {
        const [k, s] = sideRank(i);
        out.push({ f: -0.8 * k, r: s * k, u: 0.15 * k });
      }
  }
  return out.slice(0, n);
}

/** Slot table in metres. */
export function slotOffsets(type, n, spacing, { vSpread = 1, custom = [], scaleH = 1 } = {}) {
  return shapeUnits(type, n, custom).map((p) => ({
    f: p.f * spacing * scaleH,
    r: p.r * spacing * scaleH,
    u: p.u * spacing * vSpread,
  }));
}

export function tableExtent(table) {
  let radius = 0, below = 0, above = 0;
  for (const o of table) {
    radius = Math.max(radius, Math.hypot(o.f, o.r));
    below = Math.max(below, -o.u);
    above = Math.max(above, o.u);
  }
  return { radius, below, above };
}

export function offsetToWorld(off, heading) {
  const F = forwardOf(heading), R = rightOf(heading);
  return { x: F.x * off.f + R.x * off.r, y: off.u, z: F.z * off.f + R.z * off.r };
}

export function formationRadius(type, n, spacing, opts) {
  return tableExtent(slotOffsets(type, n, spacing, opts)).radius;
}

/**
 * Assign members to slots of `table`, minimising total movement (greedy on sorted pair
 * distances; near-optimal for swarm sizes up to a few dozen, cheap on a flight computer).
 * The leader always gets slot 0. Distances are 3D.
 * @returns {Map<number, number>} id -> slot index
 */
export function assignSlots(members, leaderId, leaderPos, heading, table) {
  const slots = new Map([[leaderId, 0]]);
  const pairs = [];
  for (const m of members) {
    if (m.id === leaderId) continue;
    for (let s = 1; s < table.length; s++) {
      const w = offsetToWorld(table[s], heading);
      const d = Math.hypot(leaderPos.x + w.x - m.pos.x, leaderPos.y + w.y - m.pos.y, leaderPos.z + w.z - m.pos.z);
      pairs.push({ id: m.id, s, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.id - b.id);
  const used = new Set();
  for (const p of pairs) {
    if (slots.has(p.id) || used.has(p.s)) continue;
    slots.set(p.id, p.s);
    used.add(p.s);
  }
  return slots;
}
