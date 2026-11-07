// Formation geometry and slot assignment.
// Offsets are expressed in the leader's body frame: f = forward, r = right, u = up (metres).
// Slot 0 is always the leader at (0, 0, 0).

import { forwardOf, rightOf } from './vec.js';

export const FORMATIONS = ['v', 'line', 'column', 'circle', 'grid'];

export function slotOffsets(type, n, spacing) {
  const out = [{ f: 0, r: 0, u: 0 }];
  if (n <= 1) return out;
  switch (type) {
    case 'line':
      for (let i = 1; i < n; i++) {
        const rank = Math.ceil(i / 2), side = i % 2 ? -1 : 1;
        out.push({ f: 0, r: side * rank * spacing, u: rank * 1.5 });
      }
      break;
    case 'column':
      for (let i = 1; i < n; i++) out.push({ f: -i * spacing, r: 0, u: i * 1.5 });
      break;
    case 'circle': {
      const R = Math.max(spacing, (spacing * (n - 1)) / (2 * Math.PI));
      for (let i = 1; i < n; i++) {
        const a = (2 * Math.PI * (i - 1)) / (n - 1);
        out.push({ f: R * Math.cos(a), r: R * Math.sin(a), u: (i % 2) * 2 });
      }
      break;
    }
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      const all = [];
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols), col = i % cols;
        all.push({ f: -row * spacing, r: (col - (cols - 1) / 2) * spacing, u: row * 1.5 });
      }
      // Leader in the middle of the front row.
      const li = Math.floor((Math.min(cols, n) - 1) / 2);
      const L = all[li];
      out.length = 0;
      out.push({ f: 0, r: 0, u: 0 });
      all.forEach((s, i) => i !== li && out.push({ f: s.f - L.f, r: s.r - L.r, u: s.u - L.u }));
      break;
    }
    case 'v':
    default:
      for (let i = 1; i < n; i++) {
        const rank = Math.ceil(i / 2), side = i % 2 ? -1 : 1;
        out.push({ f: -rank * spacing * 0.8, r: side * rank * spacing, u: rank * 1.5 });
      }
  }
  return out;
}

export function offsetToWorld(off, heading) {
  const F = forwardOf(heading), R = rightOf(heading);
  return { x: F.x * off.f + R.x * off.r, y: off.u, z: F.z * off.f + R.z * off.r };
}

export function formationRadius(type, n, spacing) {
  return Math.max(0, ...slotOffsets(type, n, spacing).map((o) => Math.hypot(o.f, o.r)));
}

/**
 * Assign members to slots, minimising total movement (greedy on sorted pair distances,
 * which is near-optimal for swarm sizes up to a few dozen and cheap enough for a flight
 * controller). The leader always gets slot 0.
 * @param {Array<{id:number,pos:{x,y,z}}>} members  includes the leader
 * @returns {Map<number, number>} id -> slot index
 */
export function assignSlots(members, leaderId, leaderPos, heading, type, spacing) {
  const offs = slotOffsets(type, members.length, spacing);
  const slots = new Map([[leaderId, 0]]);
  const followers = members.filter((m) => m.id !== leaderId);
  const pairs = [];
  for (const m of followers) {
    for (let s = 1; s < offs.length; s++) {
      const w = offsetToWorld(offs[s], heading);
      const d = Math.hypot(leaderPos.x + w.x - m.pos.x, leaderPos.z + w.z - m.pos.z);
      pairs.push({ id: m.id, s, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.id - b.id);
  const usedSlot = new Set();
  for (const p of pairs) {
    if (slots.has(p.id) || usedSlot.has(p.s)) continue;
    slots.set(p.id, p.s);
    usedSlot.add(p.s);
  }
  return slots;
}
