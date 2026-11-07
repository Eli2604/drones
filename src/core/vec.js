// Minimal 3D vector helpers on plain {x, y, z} objects.
// World frame: x = east, y = up, z = south (north = -z). Units: metres, seconds.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const lenH = (a) => Math.hypot(a.x, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distH = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3();
};
export const clampLen = (a, max) => {
  const l = len(a);
  return l > max ? scale(a, max / l) : a;
};
export const clampH = (a, max) => {
  const l = lenH(a);
  return l > max ? { x: (a.x * max) / l, y: a.y, z: (a.z * max) / l } : a;
};
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Heading in radians, clockwise from north. */
export const headingOf = (dx, dz) => Math.atan2(dx, -dz);
export const forwardOf = (h) => ({ x: Math.sin(h), y: 0, z: -Math.cos(h) });
export const rightOf = (h) => ({ x: Math.cos(h), y: 0, z: Math.sin(h) });
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
