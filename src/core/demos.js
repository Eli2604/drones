// Built-in demo scenarios (config overrides on top of DEFAULT_CONFIG).
// Load from the UI or with ?demo=<key> in the URL.

export const DEMOS = {
  jammed: {
    title: 'Jammed corridor',
    description: 'GNSS is available, but a GNSS jammer and a radio jammer sit near the direct line. Drones that fly into them lose their fixes or their links; the swarm marks the areas, shares them and routes around. Orders sent while the leader is out of contact with the central wait until it is back.',
    config: {
      seed: 9,
      terrain: { preset: 'hills' },
      swarm: { count: 8, formation: 'v' },
      nav: { gnss: true },
      jammers: { custom: [{ x: -300, z: 300, type: 'gnss', r: 380 }, { x: 320, z: -260, type: 'comms', r: 320 }] },
    },
  },
  'leader-loss': {
    title: 'Leader loss & re-election',
    description: 'Clear weather over hills. The leader crashes at 45 s, a follower loses its radio at 95 s.',
    config: {
      seed: 7,
      terrain: { preset: 'hills' },
      swarm: { count: 7, formation: 'v' },
      failures: [
        { t: 45, target: 'leader', type: 'crash' },
        { t: 95, target: 'random', type: 'radio' },
      ],
    },
  },
  storm: {
    title: 'Storm crossing',
    description: 'Strong gusty wind and heavy rain along a valley. Radio range shrinks, landmarks are harder to see; the leader gets a battery fault at 60 s and hands over.',
    config: {
      seed: 12,
      terrain: { preset: 'valley' },
      swarm: { count: 9, formation: 'grid', spacing: 28 },
      weather: { windSpeed: 13, windDir: 300, gustiness: 0.6, turbulence: 0.65, precipitation: 0.85, fog: 0.35 },
      failures: [{ t: 60, target: 'leader', type: 'battery' }],
    },
  },
  'mountain-pass': {
    title: 'Mountain pass + no-fly zone',
    description: 'Ridged mountains under a 520 m ceiling with a no-fly zone on the direct line. Chaos mode drops a random drone every 45 s.',
    config: {
      seed: 4,
      terrain: { preset: 'mountains' },
      swarm: { count: 10, formation: 'column', spacing: 22, maxAltitude: 520 },
      noFly: [{ x: 0, z: 0, r: 260 }],
      chaosInterval: 45,
    },
  },
  ambush: {
    title: 'Ambush: anti-air on the route',
    description: 'Three hidden anti-air sites engage the swarm, shooting at the commander first. Drones that are shot at jink; the swarm shares where the fire came from, spreads out, reroutes around located sites, and the commander hands over to a drone out of range.',
    config: {
      seed: 5,
      terrain: { preset: 'hills' },
      swarm: { count: 9, formation: 'diamond', spacing: 26 },
      threats: { count: 0, custom: [{ x: -300, z: 280 }, { x: 250, z: -180 }, { x: 520, z: -620 }], targeting: 'leader', hitProb: 0.35 },
    },
  },
  'formation-3d': {
    title: '3D formations showcase',
    description: 'A 12-drone sphere over rugged ridges. Try switching formation live (star, box, helix…) or open the designer to draw your own.',
    config: {
      seed: 9,
      terrain: { preset: 'mountains', amp: 380, roughness: 0.58 },
      swarm: { count: 12, formation: 'sphere', spacing: 24, vSpread: 1.2 },
    },
  },
  'gnss-denied-fog': {
    title: 'Dense fog, poor odometry',
    description: 'Visibility ~170 m and 2.5x odometry drift: landmarks are rarely recognised, so the swarm leans on ranging between drones. Watch the nav error grow between fixes, then clear the fog.',
    config: {
      seed: 21,
      terrain: { preset: 'flat' },
      swarm: { count: 12, formation: 'circle', spacing: 30 },
      weather: { windSpeed: 2, gustiness: 0.1, turbulence: 0.1, precipitation: 0.1, fog: 1 },
      nav: { driftLevel: 2.5, beaconCount: 8 },
    },
  },
};
