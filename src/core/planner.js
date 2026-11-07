// Swarm path planner: energy- and wind-aware A* over a 2D grid, followed by
// line-of-sight smoothing and terrain-following altitude assignment.
//
// The leader runs this on board with its own map (DEM), the no-fly zones and the
// current wind estimate, then shares the resulting waypoints with the swarm.

import { clamp } from './vec.js';

class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(item, pri) {
    const a = this.a;
    a.push({ item, pri });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].pri <= a[i].pri) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.item;
  }
}

/**
 * @param {object} p
 * @param {import('./terrain.js').Terrain} p.terrain
 * @param {{x:number,z:number}} p.start
 * @param {{x:number,z:number}} p.goal
 * @param {{x:number,z:number}} [p.wind]  mean wind vector (towards)
 * @param {Array<{x:number,z:number,r:number}>} [p.noFly]
 * @param {object} p.opts  { gridN, clearance, maxAltitude, corridor, cruiseSpeed, maxLeg }
 */
export function planPath({ terrain, start, goal, wind = { x: 0, z: 0 }, noFly = [], opts }) {
  const { gridN = 96, clearance = 40, maxAltitude = 600, corridor = 40, cruiseSpeed = 12, maxLeg = 120 } = opts;
  const size = terrain.size;
  const cs = size / gridN;
  const toCell = (x, z) => [
    clamp(Math.floor((x + size / 2) / cs), 0, gridN - 1),
    clamp(Math.floor((z + size / 2) / cs), 0, gridN - 1),
  ];
  const center = (i, j) => ({ x: -size / 2 + (i + 0.5) * cs, z: -size / 2 + (j + 0.5) * cs });

  // Cell model: highest ground in the cell (+ swarm corridor), blocked if the swarm
  // would exceed the altitude ceiling or the cell touches a no-fly zone.
  const N = gridN * gridN;
  const cellH = new Float32Array(N);
  const blocked = new Uint8Array(N);
  let hMin = Infinity, hMax = -Infinity;
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const c = center(i, j);
      const h = terrain.maxHeightAround(c.x, c.z, cs * 0.6);
      cellH[j * gridN + i] = h;
      hMin = Math.min(hMin, h);
      hMax = Math.max(hMax, h);
      if (h + clearance > maxAltitude) blocked[j * gridN + i] = 1;
      for (const z of noFly) {
        if (Math.hypot(c.x - z.x, c.z - z.z) < z.r + corridor + cs * 0.5) blocked[j * gridN + i] = 1;
      }
    }
  }
  const hRange = Math.max(1, hMax - hMin);

  const nearestFree = (i0, j0) => {
    if (!blocked[j0 * gridN + i0]) return [i0, j0];
    for (let r = 1; r < gridN; r++) {
      let best = null, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= gridN || j >= gridN || blocked[j * gridN + i]) continue;
          const d = di * di + dj * dj;
          if (d < bd) (bd = d), (best = [i, j]);
        }
      }
      if (best) return best;
    }
    return null;
  };

  const s0 = nearestFree(...toCell(start.x, start.z));
  const g0 = nearestFree(...toCell(goal.x, goal.z));
  if (!s0 || !g0) return { ok: false, reason: 'start or goal unreachable (altitude ceiling / no-fly)' };

  const windSpeed = Math.hypot(wind.x, wind.z);
  const wx = windSpeed > 0 ? wind.x / windSpeed : 0, wz = windSpeed > 0 ? wind.z / windSpeed : 0;

  const startIdx = s0[1] * gridN + s0[0];
  const goalIdx = g0[1] * gridN + g0[0];
  const gScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const gc = center(g0[0], g0[1]);
  const hfun = (idx) => {
    const c = center(idx % gridN, (idx / gridN) | 0);
    return Math.hypot(c.x - gc.x, c.z - gc.z);
  };
  gScore[startIdx] = 0;
  heap.push(startIdx, hfun(startIdx));
  let expanded = 0;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goalIdx) break;
    const ci = cur % gridN, cj = (cur / gridN) | 0;
    for (const [di, dj] of DIRS) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
      const nIdx = nj * gridN + ni;
      if (blocked[nIdx] || closed[nIdx]) continue;
      if (di && dj && (blocked[cj * gridN + ni] || blocked[nj * gridN + ci])) continue; // no corner cutting
      const d = cs * Math.hypot(di, dj);
      // Energy-aware cost: distance, preference for low altitude (less climbing, more
      // terrain shelter), explicit climb penalty, and a headwind penalty.
      const climb = Math.max(0, cellH[nIdx] - cellH[cur]);
      const alt = (cellH[nIdx] - hMin) / hRange;
      const ux = di / Math.hypot(di, dj), uz = dj / Math.hypot(di, dj);
      const head = Math.max(0, -(ux * wx + uz * wz)) * (windSpeed / Math.max(1, cruiseSpeed));
      const cost = d * (1 + 0.5 * alt + 0.6 * head) + 3 * climb;
      const g = gScore[cur] + cost;
      if (g < gScore[nIdx]) {
        gScore[nIdx] = g;
        came[nIdx] = cur;
        heap.push(nIdx, g + hfun(nIdx));
      }
    }
  }
  if (!closed[goalIdx]) return { ok: false, reason: 'no route found', expanded };

  const cells = [];
  for (let c = goalIdx; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  let pts = cells.map((c) => center(c % gridN, (c / gridN) | 0));
  pts[0] = { x: start.x, z: start.z };
  pts[pts.length - 1] = { x: goal.x, z: goal.z };

  // Line-of-sight smoothing ("string pulling"), but never over blocked cells and never
  // across a big terrain bump that the grid path deliberately went around.
  const segClear = (a, b) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(L / (cs * 0.4)));
    const top = Math.max(terrain.heightAt(a.x, a.z), terrain.heightAt(b.x, b.z));
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
      const [i, j] = toCell(x, z);
      if (blocked[j * gridN + i]) return false;
      if (terrain.heightAt(x, z) > top + 25) return false;
    }
    return true;
  };
  const smoothPts = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segClear(pts[i], pts[j])) j--;
    smoothPts.push(pts[j]);
    i = j;
  }

  // Subdivide long legs so altitude can follow the terrain.
  const dense = [smoothPts[0]];
  for (let k = 1; k < smoothPts.length; k++) {
    const a = smoothPts[k - 1], b = smoothPts[k];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / maxLeg));
    for (let s = 1; s <= n; s++) dense.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
  }

  // Altitude per waypoint: clear the highest ground along both adjoining legs within the
  // swarm corridor, so holding max(prev, next) altitude on a leg is always safe.
  const legMax = (a, b) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(L / 20));
    let m = -Infinity;
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
      m = Math.max(m, terrain.maxHeightAround(x, z, corridor));
    }
    return m;
  };
  const legs = [];
  for (let k = 1; k < dense.length; k++) legs.push(legMax(dense[k - 1], dense[k]));
  const waypoints = dense.map((p, k) => {
    const g = Math.max(legs[k - 1] ?? -Infinity, legs[k] ?? -Infinity, terrain.heightAt(p.x, p.z));
    return { x: p.x, y: Math.min(maxAltitude, g + clearance), z: p.z };
  });

  let length = 0;
  for (let k = 1; k < waypoints.length; k++) {
    length += Math.hypot(waypoints[k].x - waypoints[k - 1].x, waypoints[k].z - waypoints[k - 1].z);
  }
  return { ok: true, waypoints, length, expanded, gridPath: pts };
}
