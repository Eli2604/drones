// Weather model: wind (mean + gusts + turbulence), precipitation and fog.
// It affects flight dynamics, energy use, sensor noise, radio range and camera visibility.

export const WEATHER_DEFAULTS = {
  windSpeed: 4, // m/s mean wind
  windDir: 225, // degrees, direction the wind blows FROM (meteorological, 0 = north)
  gustiness: 0.3, // 0..1 gust amplitude relative to mean wind
  turbulence: 0.2, // 0..1 random small-scale turbulence
  precipitation: 0, // 0..1 rain intensity
  fog: 0, // 0..1 fog density
};

export class Weather {
  constructor(opts = {}) {
    Object.assign(this, WEATHER_DEFAULTS, opts);
  }

  set(opts) {
    Object.assign(this, opts);
  }

  /** Mean wind vector (direction the air moves towards). */
  baseWind() {
    const d = (this.windDir * Math.PI) / 180;
    return { x: -Math.sin(d) * this.windSpeed, y: 0, z: Math.cos(d) * this.windSpeed };
  }

  windAt(p, t, rng) {
    const b = this.baseWind();
    const g =
      this.gustiness *
      (0.6 * Math.sin(t * 0.31 + p.x * 0.002) + 0.4 * Math.sin(t * 0.83 + p.z * 0.003 + 1.7));
    const k = 1 + g;
    const tu = this.turbulence * 2.2;
    return {
      x: b.x * k + rng.gauss(0, tu),
      y: rng.gauss(0, tu * 0.4),
      z: b.z * k + rng.gauss(0, tu),
    };
  }

  /** Meteorological visibility in metres. */
  visibility() {
    return Math.max(40, 6000 * (1 - 0.97 * this.fog) * (1 - 0.6 * this.precipitation));
  }

  /** Multiplier on effective radio range (rain fade). */
  commFactor() {
    return Math.max(0.35, 1 - 0.4 * this.precipitation - 0.12 * this.fog);
  }

  /** Multiplier on odometry / ranging noise. */
  sensorNoiseFactor() {
    return 1 + 1.5 * this.turbulence + 0.6 * this.precipitation;
  }

  /** Probability multiplier that the camera recognises a landmark. */
  cameraFactor() {
    return Math.max(0.05, (1 - 0.75 * this.fog) * (1 - 0.5 * this.precipitation));
  }

  /** Multiplier on hover power (wet props, heavier air handling). */
  powerFactor() {
    return 1 + 0.2 * this.precipitation;
  }
}
