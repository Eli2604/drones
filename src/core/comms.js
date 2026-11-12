// Low-power radio model with adaptive transmit range, multi-hop flooding and ranging.
//
// - Energy per packet scales with (range / baseRange)^2 (free-space path loss), so drones
//   transmit just far enough to reach a few nearest neighbours and rely on relays.
// - Delivery probability falls off near the edge of the effective range, which shrinks
//   in rain/fog. There is also a base packet-loss rate.
// - Every delivered packet carries a range measurement (UWB two-way ranging).
// - Packets are delivered one tick after they are sent.

import { clone, dist } from './vec.js';

const HEADER_BYTES = 10;
export function msgBytes(msg) {
  const p = msg.payload ?? {};
  switch (msg.type) {
    case 'HB': return HEADER_BYTES + 44 + 9 * (p.formation?.slots?.length ?? 0); // id+slot+3x int16 offset
    case 'THREAT': return HEADER_BYTES + 10;
    case 'JAM': return HEADER_BYTES + 10;
    case 'STATUS': return HEADER_BYTES + 32;
    case 'PLAN': return HEADER_BYTES + 12 + 12 * (p.waypoints?.length ?? 0);
    case 'ELECT': return HEADER_BYTES + 12;
    case 'HANDOVER': return HEADER_BYTES + 12;
    case 'LEAVE': return HEADER_BYTES + 4;
    default: return HEADER_BYTES + 16;
  }
}

export class Radio {
  constructor(sim) {
    this.sim = sim;
    this.pending = [];
    this.links = new Map(); // "a-b" -> last time a packet went between them
    this.stats = { sent: 0, delivered: 0, dropped: 0, bytes: 0, energyJ: 0, fullPowerEnergyJ: 0, byType: {} };
  }

  transmit(sender, msg, range) {
    const { cfg, weather, rng, drones, t } = this.sim;
    const c = cfg.comms;
    const bytes = msgBytes(msg);
    const e = c.txOverheadJ + c.txJoulePerByte * bytes * (range / c.baseRange) ** 2;
    const eFull = c.txOverheadJ + c.txJoulePerByte * bytes * (c.maxRange / c.baseRange) ** 2;
    sender.radioEnergyJ += e;
    sender.batteryJ -= e;
    const st = this.stats;
    st.sent++;
    st.bytes += bytes;
    st.energyJ += e;
    st.fullPowerEnergyJ += eFull;
    st.byType[msg.type] = (st.byType[msg.type] ?? 0) + 1;

    const rEff = range * weather.commFactor();
    for (const d of drones) {
      if (d === sender || !d.active || !d.radioOk) continue;
      const dd = dist(sender.truePos, d.truePos);
      if (dd > rEff) continue;
      let p = dd < 0.7 * rEff ? 1 : (rEff - dd) / (0.3 * rEff);
      p *= 1 - c.lossBase;
      // a jammed receiver hears only noise (jamming.js)
      const jam = d.jam?.comms ?? 0;
      if (jam > 0) {
        p *= 1 - jam;
        if (jam >= 0.5) st.jammed = (st.jammed ?? 0) + 1;
      }
      if (rng.next() > p) {
        st.dropped++;
        continue;
      }
      const e2 = c.rxJoulePerByte * bytes;
      d.radioEnergyJ += e2;
      d.batteryJ -= e2;
      st.energyJ += e2;
      st.fullPowerEnergyJ += e2;
      st.delivered++;
      this.pending.push({ to: d, from: sender, msg });
      const key = sender.id < d.id ? `${sender.id}-${d.id}` : `${d.id}-${sender.id}`;
      this.links.set(key, t);
    }
  }

  /**
   * Take everything sent during the previous tick. The two-way range and the sender's
   * position estimate are sampled together here, at the same instant for all drones,
   * so range and estimates are time-consistent (otherwise a moving swarm gets a
   * systematic along-track bias).
   */
  deliver() {
    const { cfg, weather, rng } = this.sim;
    const rangeNoise = cfg.nav.rangeNoise * weather.sensorNoiseFactor();
    const out = this.pending.map(({ to, from, msg }) => ({
      to,
      env: {
        msg,
        tx: from.id,
        txEst: clone(from.loc.est),
        txSigma: from.loc.sigma,
        range: Math.max(0, dist(from.truePos, to.truePos) + rng.gauss(0, rangeNoise)),
      },
    }));
    this.pending = [];
    return out;
  }
}
