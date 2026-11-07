// Procedural heightmap terrain (fractal value noise). The map is square, centred on (0, 0).
import { Rng } from './rng.js';

export const TERRAIN_PRESETS = {
  flat: { amp: 25, freq: 2, octaves: 3, ridged: false },
  hills: { amp: 150, freq: 3, octaves: 5, ridged: false },
  valley: { amp: 300, freq: 2.5, octaves: 5, ridged: false, valley: true },
  mountains: { amp: 520, freq: 2.2, octaves: 6, ridged: true },
};

const smooth = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Terrain {
  constructor({ size = 2400, res = 129, seed = 1, preset = 'hills' } = {}) {
    this.size = size;
    this.res = res;
    this.seed = seed;
    this.preset = preset;
    this.cell = size / (res - 1);
    this.heights = new Float32Array(res * res);
    this.generate();
  }

  generate() {
    const p = TERRAIN_PRESETS[this.preset] ?? TERRAIN_PRESETS.hills;
    const rng = new Rng(this.seed * 7919 + 13);
    const lattices = [];
    let f = p.freq;
    for (let o = 0; o < p.octaves; o++, f *= 2) {
      const n = Math.ceil(f) + 2;
      const data = new Float32Array(n * n);
      for (let i = 0; i < data.length; i++) data[i] = rng.next();
      lattices.push({ n, data, f });
    }
    const sample = (lat, x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = smooth(x - ix), fy = smooth(y - iy);
      const g = (i, j) => lat.data[j * lat.n + i];
      const a = g(ix, iy), b = g(ix + 1, iy), c = g(ix, iy + 1), d = g(ix + 1, iy + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    const { res } = this;
    let min = Infinity;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1), v = j / (res - 1);
        let h = 0, a = 1, norm = 0;
        for (const lat of lattices) {
          let n = sample(lat, u * lat.f, v * lat.f);
          if (p.ridged) {
            n = 1 - Math.abs(2 * n - 1);
            n *= n;
          }
          h += a * n;
          norm += a;
          a *= 0.5;
        }
        h /= norm;
        if (p.valley) {
          // Carve a valley along the SW -> NE diagonal (default origin -> destination).
          const dd = Math.abs(u - (1 - v)) / Math.SQRT2;
          h *= 0.12 + 0.88 * smoothstep(0.02, 0.28, dd);
        }
        const height = h * p.amp;
        this.heights[j * res + i] = height;
        if (height < min) min = height;
      }
    }
    let max = -Infinity;
    for (let k = 0; k < this.heights.length; k++) {
      this.heights[k] -= min;
      if (this.heights[k] > max) max = this.heights[k];
    }
    this.minH = 0;
    this.maxH = max;
  }

  inBounds(x, z, margin = 0) {
    const h = this.size / 2 - margin;
    return x >= -h && x <= h && z >= -h && z <= h;
  }

  /** Bilinearly interpolated ground height at world (x, z). */
  heightAt(x, z) {
    const { res, size } = this;
    const gx = Math.min(res - 1, Math.max(0, (x / size + 0.5) * (res - 1)));
    const gz = Math.min(res - 1, Math.max(0, (z / size + 0.5) * (res - 1)));
    const i = Math.min(res - 2, Math.floor(gx)), j = Math.min(res - 2, Math.floor(gz));
    const fx = gx - i, fz = gz - j;
    const H = this.heights;
    const a = H[j * res + i], b = H[j * res + i + 1], c = H[(j + 1) * res + i], d = H[(j + 1) * res + i + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  /** Highest ground within a disc of radius r around (x, z) (coarse sampling). */
  maxHeightAround(x, z, r) {
    let m = this.heightAt(x, z);
    if (r <= 0) return m;
    const step = Math.max(this.cell, r / 3);
    for (let dx = -r; dx <= r + 1e-6; dx += step) {
      for (let dz = -r; dz <= r + 1e-6; dz += step) {
        if (dx * dx + dz * dz <= r * r) m = Math.max(m, this.heightAt(x + dx, z + dz));
      }
    }
    return m;
  }
}
