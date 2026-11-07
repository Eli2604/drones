// Seeded PRNG so every scenario is reproducible (important for demos and tests).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1) {
    this.next = mulberry32(seed);
  }
  uniform(a = 0, b = 1) {
    return a + (b - a) * this.next();
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  gauss(mu = 0, sigma = 1) {
    if (sigma === 0) return mu;
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
}
