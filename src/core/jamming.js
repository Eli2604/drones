// Electronic warfare: jammers.
//
// A jammer drowns out radio signals around it. Two kinds (or both):
//  - comms: the swarm's radio and the command link (C2) to the central ground station.
//           A drone inside cannot hear its peers or the central (receiver-side jamming:
//           what it sends still reaches drones outside).
//  - gnss:  satellite navigation (GPS/Galileo). A drone inside gets no position fixes and
//           falls back on odometry, landmarks and cooperative ranging (localization.js).
// The effect is full inside 0.8 R and fades out to nothing at R.
//
// The swarm notices jamming (its noise floor jumps, the fixes stop), marks the area where
// it happened and shares it (JAM message); the leader routes around it like a threat.

export const JAMMER_TYPES = {
  comms: 'radio links (swarm and central)',
  gnss: 'satellite navigation',
  both: 'radio links and satellite navigation',
};

/** How strongly each kind is jammed at p (0..1). */
export function jamAt(jammers, p) {
  let comms = 0, gnss = 0;
  for (const j of jammers) {
    if (j.off) continue;
    const d = Math.hypot(p.x - j.x, p.z - j.z, (p.y ?? j.y) - j.y);
    if (d >= j.r) continue;
    const k = d < 0.8 * j.r ? 1 : (j.r - d) / (0.2 * j.r);
    if (j.type !== 'gnss') comms = Math.max(comms, k);
    if (j.type !== 'comms') gnss = Math.max(gnss, k);
  }
  return { comms, gnss };
}
