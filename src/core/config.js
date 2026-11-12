// Default scenario. Every value can be overridden by the UI or by an imported scenario JSON.
import { WEATHER_DEFAULTS } from './weather.js';

export const DEFAULT_CONFIG = {
  seed: 7,
  dt: 0.1, // simulation step (s)
  // amp / roughness / freq / ridged / valley override the preset's values (null = preset).
  terrain: { preset: 'hills', size: 2400, res: 129, amp: null, roughness: null, freq: null, ridged: null, valley: null },
  origin: { x: -850, z: 850 },
  destination: { x: 850, z: -850 },
  swarm: {
    count: 7,
    formation: 'v',
    spacing: 25, // m between neighbouring slots
    vSpread: 1, // vertical scale of the formation relative to its horizontal spacing
    customSlots: [ // designer formation, spacing units, leader implied at (0,0,0)
      { f: 1, r: 0, u: 0.5 }, { f: 0, r: -1, u: 0 }, { f: 0, r: 1, u: 0 }, { f: -1, r: 0, u: -0.5 },
      { f: 0, r: 0, u: 1 }, { f: 0, r: 0, u: -1 },
    ],
    cruiseSpeed: 12, // m/s
    maxSpeed: 18, // m/s
    cruiseAGL: 40, // m above terrain the route is planned at
    minAGL: 12, // m, hard floor enforced with the downward rangefinder
    maxAltitude: 600, // m, absolute ceiling (regulatory / airspace)
  },
  drone: {
    massKg: 1.6,
    batteryWh: 90,
    hoverPowerW: 170,
    aeroCoeff: 0.045, // W per (m/s)^3 of airspeed
    dragCoeff: 0.012, // 1/m, quadratic drag acceleration per (m/s)^2
    maxAccel: 5, // m/s^2 horizontal thrust authority
    maxClimb: 5,
    maxDescent: 3,
    handoverBattery: 0.3, // leader hands over control below this battery fraction
    landBattery: 0.15, // drone leaves the swarm and lands below this
  },
  weather: { ...WEATHER_DEFAULTS },
  comms: {
    hbInterval: 0.5, // s between leader heartbeats; followers report every 2x this
    baseRange: 400, // m, reference range for energy normalisation
    minRange: 60, // m
    maxRange: 900, // m, "shout" range used when isolated
    ttl: 3, // flood hops
    lossBase: 0.02,
    txOverheadJ: 0.0004,
    txJoulePerByte: 0.00006,
    rxJoulePerByte: 0.00001,
  },
  nav: {
    driftLevel: 1, // multiplier on all odometry errors
    scaleErr: 0.012, // 1-sigma velocity scale-factor error
    biasInit: 0.04, // m/s 1-sigma initial velocity bias
    biasWalk: 0.004, // m/s/sqrt(s) bias random walk
    odomNoise: 0.15, // m/s white noise
    baroNoise: 0.8, // m
    rangeNoise: 0.3, // m, UWB ranging noise
    cameraRange: 250, // m, max slant range to recognise a landmark
    beaconDetectRate: 0.8, // recognitions per second while in view (clear weather)
    beaconCount: 14,
    gnss: false, // satellite navigation available (until jammed); off = GNSS-denied by design
    gnssSigma: 2.5, // m, 1-sigma horizontal error of a GNSS fix
    gnssRate: 1, // fixes per second
  },
  threats: {
    count: 0, // randomly placed anti-air sites (away from origin/destination)
    custom: [], // [{x, z}] placed by the operator
    range: 350, // m engagement range (needs line of sight; terrain masks)
    interval: 2.5, // s between shots per site
    hitProb: 0.35, // base hit probability at point-blank on a non-evading drone
    targeting: 'leader', // 'leader' (commander first) | 'nearest' | 'random'
    protectCommander: true, // a leader under fire hands command to a drone far from the threat
    reaction: true, // swarm reacts: evasion, dispersal, threat sharing, rerouting
  },
  // The central ground station (command and control). Operator orders reach the swarm only
  // while the leader has a C2 link to it (in range, not jammed); otherwise they wait.
  central: { x: null, z: null, range: 3000 }, // null: at the origin
  jammers: {
    count: 0, // randomly placed jammers (away from origin/destination)
    custom: [], // [{x, z, type?, r?}] placed by the operator
    radius: 350, // m
    type: 'both', // 'comms' | 'gnss' | 'both'
    reaction: true, // swarm marks jammed areas, shares them and routes around them
  },
  noFly: [], // [{x, z, r}]
  customBeacons: [], // [{x, z}]
  failures: [], // scheduled: [{t, target: 'leader'|'random'|<id>, type: 'crash'|'radio'|'battery'}]
  chaosInterval: 0, // s; when > 0, a random drone fails at this interval
};

export function cloneConfig(c) {
  return JSON.parse(JSON.stringify(c));
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function mergeConfig(base, over) {
  const out = cloneConfig(base);
  if (!over) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeConfig(out[k], v) : JSON.parse(JSON.stringify(v));
  }
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}
