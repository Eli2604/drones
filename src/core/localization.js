// Per-drone position estimate in a GNSS-denied setting.
//
// 1. Dead reckoning: integrate measured ground velocity (optical flow / IMU). The
//    measurement has a per-drone scale-factor error, an offset bias doing a random walk,
//    and white noise, so the estimate drifts over time. Altitude comes from a barometer.
// 2. Cooperative ranging: every received radio packet gives a range to the sender
//    (UWB-style two-way ranging) plus the sender's own estimate. Each drone nudges its
//    estimate to agree with the measured range. Because every drone drifts independently,
//    this pulls the swarm into a shared consensus frame that drifts ~1/sqrt(N) as fast as
//    a single drone ("grouped telemetry").
//    Ranging alone only fixes the swarm's *relative* geometry; the shared frame can still
//    wander as a lopsided average of the members' drifts (message rates are asymmetric).
// 2b. Grouped telemetry: each drone also keeps a pure odometry track `odo` that ranging
//    never touches. The leader broadcasts the mean of (odo - est) over the group and every
//    member nudges its estimate by it, anchoring the shared frame to the unweighted average
//    of N independent odometers (drift ~ 1/sqrt(N) of a single drone).
// 3. Beacon fixes: when the camera recognises a landmark with a known geolocation, the
//    drone gets an absolute position measurement and applies a Kalman-style correction.
//    Ranging then propagates that correction to the rest of the swarm.
//
// `sigma` is a scalar 1-sigma horizontal uncertainty used to weight corrections.

import { clone, v3, lenH } from './vec.js';

export class Localizer {
  constructor(pos, rng, cfg) {
    this.rng = rng;
    this.cfg = cfg;
    this.est = clone(pos);
    this.odo = clone(pos); // pure dead reckoning (+ landmark fixes), no ranging
    this.sigma = 0.5;
    this.odoSigma = 0.5; // uncertainty of the odometry track alone (prior for ranging)
    const dl = cfg.driftLevel;
    this.scaleErr = rng.gauss(0, cfg.scaleErr * dl);
    this.bias = { x: rng.gauss(0, cfg.biasInit * dl), z: rng.gauss(0, cfg.biasInit * dl) };
    this.measVel = v3();
    this.rangeUpdates = 0;
    this.fixes = 0;
  }

  predict(trueVel, trueY, dt, noiseFactor) {
    const { cfg, rng } = this;
    const dl = cfg.driftLevel;
    const walk = cfg.biasWalk * dl * Math.sqrt(dt);
    this.bias.x += rng.gauss(0, walk);
    this.bias.z += rng.gauss(0, walk);
    const n = cfg.odomNoise * dl * noiseFactor;
    const k = 1 + this.scaleErr;
    this.measVel = {
      x: trueVel.x * k + this.bias.x + rng.gauss(0, n),
      y: trueVel.y + rng.gauss(0, 0.05),
      z: trueVel.z * k + this.bias.z + rng.gauss(0, n),
    };
    this.est.x += this.measVel.x * dt;
    this.est.z += this.measVel.z * dt;
    this.odo.x += this.measVel.x * dt;
    this.odo.z += this.measVel.z * dt;
    // Barometric altitude, complementary-filtered with vertical speed.
    this.est.y += this.measVel.y * dt;
    this.est.y += 0.1 * (trueY + rng.gauss(0, cfg.baroNoise) - this.est.y);
    // Uncertainty growth: scale-factor and bias errors accumulate linearly in time;
    // white velocity noise only as a random walk (variance ~ n^2 * dt per step).
    const speed = lenH(trueVel);
    const lin = (cfg.scaleErr * speed + cfg.biasInit) * dl * dt;
    const grow = (s) => Math.min(500, Math.sqrt((s + lin) ** 2 + n * n * dt * dt));
    this.sigma = grow(this.sigma);
    this.odoSigma = grow(this.odoSigma);
  }

  /**
   * Odometry acts as a prior: a relative correction (ranging, group anchor) may not move
   * the estimate further from the odometry track than odometry's own uncertainty allows.
   * Without this, geometry that cannot observe some direction (e.g. drones in a line
   * abreast can't see along-track error) lets the estimate run away, and the formation
   * controller then flies the drone after it.
   */
  priorLimit() {
    return 1.5 * this.odoSigma + 5;
  }
  clampToPrior(nx, nz) {
    const gx = nx - this.odo.x, gz = nz - this.odo.z;
    const gap = Math.hypot(gx, gz), lim = this.priorLimit();
    if (gap <= lim) return { x: nx, z: nz };
    const oldGap = Math.hypot(this.est.x - this.odo.x, this.est.z - this.odo.z);
    const keep = Math.max(lim, Math.min(gap, oldGap)); // never push further out
    return { x: this.odo.x + (gx * keep) / gap, z: this.odo.z + (gz * keep) / gap };
  }

  /** Range measurement to a neighbour whose estimate and uncertainty were in the packet. */
  rangeUpdate(nEst, nSigma, range, rangeNoise) {
    const dx = this.est.x - nEst.x, dy = this.est.y - nEst.y, dz = this.est.z - nEst.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return;
    const res = range - d;
    const s2 = this.sigma ** 2, n2 = nSigma ** 2 + rangeNoise ** 2;
    if (Math.abs(res) > 4 * Math.sqrt(s2 + n2) + 3) return; // outlier gate
    const k = (0.5 * s2) / (s2 + n2);
    const p = this.clampToPrior(this.est.x + (k * res * dx) / d, this.est.z + (k * res * dz) / d);
    this.est.x = p.x;
    this.est.z = p.z;
    if (nSigma < this.sigma) {
      // A range only constrains one direction, so shrink uncertainty conservatively.
      const w = 0.15 * k;
      this.sigma = Math.sqrt((1 - w) * s2 + w * n2);
    }
    this.rangeUpdates++;
  }

  /** Shift the estimate towards the group-odometry anchor broadcast by the leader. */
  applyGroupAnchor(offset, gain = 0.3) {
    const p = this.clampToPrior(this.est.x + gain * offset.x, this.est.z + gain * offset.z);
    this.est.x = p.x;
    this.est.z = p.z;
  }

  /** Absolute position fix (e.g. a recognised landmark). */
  absoluteFix(meas, sigmaMeas) {
    const s2 = this.sigma ** 2;
    const k = s2 / (s2 + sigmaMeas ** 2);
    this.est.x += k * (meas.x - this.est.x);
    this.est.z += k * (meas.z - this.est.z);
    this.sigma = Math.max(0.3, Math.sqrt((1 - k) * s2));
    // Landmarks are absolute truth for the odometry track too (with its own gain).
    const o2 = this.odoSigma ** 2, ko = o2 / (o2 + sigmaMeas ** 2);
    this.odo.x += ko * (meas.x - this.odo.x);
    this.odo.z += ko * (meas.z - this.odo.z);
    this.odoSigma = Math.max(0.3, Math.sqrt((1 - ko) * o2));
    this.fixes++;
  }
}
