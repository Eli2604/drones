// Default scenario. Every value can be overridden by the UI or by an imported scenario JSON.
import { WEATHER_DEFAULTS } from './weather.js';

export const DEFAULT_CONFIG = {
  seed: 7,
  dt: 0.1, // simulation step (s)
  terrain: { preset: 'hills', size: 2400, res: 129 },
  origin: { x: -850, z: 850 },
  destination: { x: 850, z: -850 },
  swarm: {
    count: 7,
    formation: 'v',
    spacing: 25, // m between neighbouring slots
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
