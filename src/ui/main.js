// UI controller: builds the settings panel, runs the simulation loop, wires interactions.
import { Simulation } from '../core/sim.js';
import { DEFAULT_CONFIG, cloneConfig, mergeConfig, getPath, setPath } from '../core/config.js';
import { FORMATIONS, FORMATION_LABELS, shapeUnits } from '../core/formation.js';
import { TERRAIN_PRESETS, terrainParams } from '../core/terrain.js';
import { FormationDesigner } from './designer.js';
import { DEMOS } from '../core/demos.js';
import { World3D } from './scene.js';
import { Chart } from './chart.js';

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ settings schema
// live: applied immediately to the running simulation; otherwise needs a reset.
const SCHEMA = [
  {
    title: 'Scenario',
    items: [
      { path: 'seed', label: 'Random seed', type: 'number', min: 1, max: 99999 },
      { path: 'nav.beaconCount', label: 'Landmarks (known geolocation)', type: 'range', min: 0, max: 40, step: 1 },
    ],
  },
  {
    title: 'Terrain',
    items: [
      { path: 'terrain.preset', label: 'Preset', type: 'select', options: Object.keys(TERRAIN_PRESETS) },
      { path: 'terrain.amp', label: 'Max height', type: 'range', min: 0, max: 900, step: 10, unit: 'm' },
      { path: 'terrain.roughness', label: 'Roughness', type: 'range', min: 0.25, max: 0.8, step: 0.01 },
      { path: 'terrain.freq', label: 'Hill density', type: 'range', min: 0.5, max: 8, step: 0.1 },
      { path: 'terrain.ridged', label: 'Sharp ridges', type: 'checkbox' },
      { path: 'terrain.valley', label: 'Carve valley (SW→NE)', type: 'checkbox' },
    ],
  },
  {
    title: 'Swarm',
    items: [
      { path: 'swarm.count', label: 'Drones', type: 'range', min: 2, max: 20, step: 1 },
      { path: 'swarm.formation', label: 'Formation', type: 'select', options: FORMATIONS, labels: FORMATION_LABELS, live: true },
      { type: 'button', label: '✎ Design custom formation…', action: () => openDesigner() },
      { path: 'swarm.spacing', label: 'Spacing', type: 'range', min: 10, max: 60, step: 1, unit: 'm', live: true },
      { path: 'swarm.vSpread', label: 'Vertical spread', type: 'range', min: 0, max: 2, step: 0.05, unit: '×', live: true },
      { path: 'swarm.cruiseSpeed', label: 'Cruise speed', type: 'range', min: 4, max: 18, step: 0.5, unit: 'm/s', live: true },
      { path: 'swarm.cruiseAGL', label: 'Cruise height above terrain', type: 'range', min: 20, max: 150, step: 5, unit: 'm' },
      { path: 'swarm.maxAltitude', label: 'Altitude ceiling', type: 'range', min: 150, max: 900, step: 10, unit: 'm' },
    ],
  },
  {
    title: 'Weather',
    live: true,
    presets: {
      Clear: { windSpeed: 2, gustiness: 0.1, turbulence: 0.05, precipitation: 0, fog: 0 },
      Breezy: { windSpeed: 7, gustiness: 0.35, turbulence: 0.25, precipitation: 0, fog: 0 },
      Storm: { windSpeed: 14, gustiness: 0.6, turbulence: 0.7, precipitation: 0.85, fog: 0.3 },
      Fog: { windSpeed: 1.5, gustiness: 0.1, turbulence: 0.05, precipitation: 0.1, fog: 0.85 },
    },
    items: [
      { path: 'weather.windSpeed', label: 'Wind speed', type: 'range', min: 0, max: 20, step: 0.5, unit: 'm/s' },
      { path: 'weather.windDir', label: 'Wind from', type: 'range', min: 0, max: 355, step: 5, unit: '°' },
      { path: 'weather.gustiness', label: 'Gusts', type: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'weather.turbulence', label: 'Turbulence', type: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'weather.precipitation', label: 'Rain', type: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'weather.fog', label: 'Fog', type: 'range', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'Enemy fire',
    items: [
      { path: 'threats.count', label: 'Random anti-air sites', type: 'range', min: 0, max: 12, step: 1 },
      { path: 'threats.range', label: 'Engagement range', type: 'range', min: 100, max: 800, step: 10, unit: 'm', live: true },
      { path: 'threats.interval', label: 'Time between shots', type: 'range', min: 0.5, max: 10, step: 0.5, unit: 's', live: true },
      { path: 'threats.hitProb', label: 'Hit probability', type: 'range', min: 0, max: 1, step: 0.05, live: true },
      { path: 'threats.targeting', label: 'Enemy targets', type: 'select', options: ['leader', 'nearest', 'random'], labels: { leader: 'Commander first', nearest: 'Nearest drone', random: 'Random drone' }, live: true },
      { path: 'threats.reaction', label: 'Swarm reacts (evade, disperse, share, reroute)', type: 'checkbox', live: true },
      { path: 'threats.protectCommander', label: 'Commander hands over when under fire', type: 'checkbox', live: true },
    ],
  },
  {
    title: 'Jamming & C2',
    open: false,
    items: [
      { path: 'nav.gnss', label: 'GNSS available (until jammed)', type: 'checkbox' },
      { path: 'jammers.count', label: 'Random jammers', type: 'range', min: 0, max: 8, step: 1 },
      { path: 'jammers.radius', label: 'Jammer radius', type: 'range', min: 100, max: 900, step: 10, unit: 'm' },
      { path: 'jammers.type', label: 'Jammer type', type: 'select', options: ['both', 'comms', 'gnss'], labels: { both: 'Radio + GNSS', comms: 'Radio (swarm + central)', gnss: 'GNSS only' } },
      { path: 'jammers.reaction', label: 'Swarm marks, shares and avoids jamming', type: 'checkbox', live: true },
      { path: 'central.range', label: 'Central C2 link range', type: 'range', min: 500, max: 5000, step: 100, unit: 'm', live: true },
    ],
  },
  {
    title: 'Navigation & radio',
    open: false,
    items: [
      { path: 'nav.driftLevel', label: 'Odometry drift', type: 'range', min: 0, max: 3, step: 0.1, unit: '×' },
      { path: 'nav.rangeNoise', label: 'Ranging noise', type: 'range', min: 0.05, max: 3, step: 0.05, unit: 'm' },
      { path: 'nav.cameraRange', label: 'Camera landmark range', type: 'range', min: 50, max: 500, step: 10, unit: 'm' },
      { path: 'comms.hbInterval', label: 'Heartbeat interval', type: 'range', min: 0.2, max: 2, step: 0.1, unit: 's' },
      { path: 'comms.maxRange', label: 'Max radio range', type: 'range', min: 200, max: 1500, step: 50, unit: 'm' },
      { path: 'comms.ttl', label: 'Relay hops (TTL)', type: 'range', min: 1, max: 6, step: 1 },
    ],
  },
];

// ------------------------------------------------------------------ state
const STORAGE_KEY = 'swarm-sim-config';
function loadConfig() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return mergeConfig(DEFAULT_CONFIG, JSON.parse(s));
  } catch {}
  return cloneConfig(DEFAULT_CONFIG);
}
function saveConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cfg));
  } catch {}
}

const state = {
  cfg: loadConfig(),
  running: false,
  speed: 1,
  mode: 'orbit',
  selected: null,
  dirty: false,
  view: { follow: false, estimates: true, links: true, slots: false, trails: true, path: true, labels: true },
};

const sim = new Simulation(state.cfg);
const world = new World3D($('#viewport'), { onPick });
const chart = new Chart($('#chart'));
world.build(sim);
world.setWeather(sim.weather);

// ------------------------------------------------------------------ formation designer
const designer = new FormationDesigner($('#viewport'));
function openDesigner() {
  const sw = state.cfg.swarm;
  // Start from what is flying now, so a preset can be tweaked into a custom shape.
  const slots = sw.formation === 'custom' ? sw.customSlots : shapeUnits(sw.formation, sw.count).slice(1);
  designer.open({
    slots,
    count: sw.count,
    spacing: sw.spacing,
    vSpread: sw.vSpread,
    onApply: (s) => {
      state.cfg.swarm.customSlots = s;
      state.cfg.swarm.formation = 'custom';
      sim.cfg.swarm.customSlots = s;
      sim.cfg.swarm.formation = 'custom';
      syncControlValues();
      saveConfig();
      if (!state.view.slots) {
        state.view.slots = true;
        document.querySelector('[data-view="slots"]').checked = true;
      }
      flash('Custom formation applied - the leader reorganises the swarm');
    },
  });
}

// ------------------------------------------------------------------ settings panel
function fmt(v, item) {
  const n = Number(v);
  const s = item.step && item.step < 1 ? n.toFixed(item.step < 0.1 ? 2 : 1) : String(n);
  return item.unit ? `${s} ${item.unit}` : s;
}

function buildControls() {
  const root = $('#controls');
  root.innerHTML = '';
  for (const sec of SCHEMA) {
    const det = document.createElement('details');
    det.open = sec.open !== false;
    det.innerHTML = `<summary>${sec.title}${sec.live ? '<span class="live">● live</span>' : ''}</summary>`;
    if (sec.presets) {
      const p = document.createElement('div');
      p.className = 'presets';
      for (const [name, values] of Object.entries(sec.presets)) {
        const b = document.createElement('button');
        b.textContent = name;
        b.onclick = () => {
          for (const [k, v] of Object.entries(values)) setPath(state.cfg, `weather.${k}`, v);
          sim.setWeather(values);
          world.setWeather(sim.weather);
          syncControlValues();
          saveConfig();
        };
        p.appendChild(b);
      }
      det.appendChild(p);
    }
    for (const item of sec.items) {
      const live = sec.live || item.live;
      const row = document.createElement('div');
      if (item.type === 'button') {
        row.className = 'btns';
        const b = document.createElement('button');
        b.textContent = item.label;
        b.onclick = item.action;
        row.appendChild(b);
        det.appendChild(row);
        continue;
      }
      const val = displayValue(item.path);
      let input;
      if (item.type === 'select') {
        row.className = 'row';
        input = document.createElement('select');
        for (const o of item.options) input.add(new Option(item.labels?.[o] ?? o, o));
        input.value = val;
        row.innerHTML = `<label>${item.label}</label>`;
        row.appendChild(input);
      } else if (item.type === 'checkbox') {
        row.className = 'row check';
        const lab = document.createElement('label');
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!val;
        lab.append(input, ` ${item.label}`);
        row.appendChild(lab);
      } else if (item.type === 'number') {
        row.className = 'row';
        input = document.createElement('input');
        Object.assign(input, { type: 'number', min: item.min, max: item.max, value: val });
        row.innerHTML = `<label>${item.label}</label>`;
        row.appendChild(input);
      } else {
        row.className = 'row slider';
        input = document.createElement('input');
        Object.assign(input, { type: 'range', min: item.min, max: item.max, step: item.step, value: val });
        const lab = document.createElement('label');
        lab.innerHTML = `<span>${item.label}${live ? '' : ''}</span><output>${fmt(val, item)}</output>`;
        row.appendChild(lab);
        row.appendChild(input);
      }
      input.dataset.path = item.path;
      input.addEventListener('input', () => {
        const v = item.type === 'select' ? input.value : item.type === 'checkbox' ? input.checked : Number(input.value);
        setPath(state.cfg, item.path, v);
        const out = row.querySelector('output');
        if (out) out.textContent = fmt(v, item);
        if (item.path === 'terrain.preset') {
          // A preset loads its shape parameters into the sliders.
          Object.assign(state.cfg.terrain, { ...TERRAIN_PRESETS[v] });
          syncControlValues();
        }
        if (live) {
          setPath(sim.cfg, item.path, v);
          if (item.path.startsWith('weather.')) {
            sim.setWeather({ [item.path.split('.')[1]]: v });
            world.setWeather(sim.weather);
          }
        } else if (sim.phase === 'ready') {
          resetSim();
        } else {
          setDirty(true);
        }
        saveConfig();
      });
      det.appendChild(row);
    }
    root.appendChild(det);
  }
}

/** Config value as shown in the panel (terrain shape falls back to the preset's value). */
function displayValue(path) {
  const v = getPath(state.cfg, path);
  if ((v === null || v === undefined) && path.startsWith('terrain.')) return terrainParams(state.cfg.terrain)[path.split('.')[1]];
  return v;
}

function syncControlValues() {
  for (const input of document.querySelectorAll('#controls [data-path]')) {
    const v = displayValue(input.dataset.path);
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v;
    const out = input.parentElement.querySelector('output');
    const item = SCHEMA.flatMap((s) => s.items).find((i) => i.path === input.dataset.path);
    if (out && item) out.textContent = fmt(v, item);
  }
  $('#chaos').value = state.cfg.chaosInterval;
  $('#chaos-out').textContent = state.cfg.chaosInterval ? `${state.cfg.chaosInterval} s` : 'off';
  renderSchedule();
}

function setDirty(d) {
  state.dirty = d;
  $('#dirty').hidden = !d;
}

// ------------------------------------------------------------------ sim control
function resetSim() {
  state.running = false;
  sim.reset(state.cfg);
  world.build(sim);
  world.setWeather(sim.weather);
  $('#log').innerHTML = '';
  setDirty(false);
  if (state.selected !== null && state.selected >= sim.drones.length) state.selected = null;
  renderSchedule();
  updateRunButton();
  updatePanels();
}

function updateRunButton() {
  const b = $('#btn-run');
  b.textContent = state.running ? '❚❚ Pause' : sim.phase === 'ready' ? '▶ Start' : '▶ Resume';
}

function toggleRun() {
  state.running = !state.running;
  updateRunButton();
}

$('#btn-run').onclick = toggleRun;
$('#btn-step').onclick = () => {
  sim.run(1);
  updateRunButton();
};
$('#btn-reset').onclick = resetSim;
$('#btn-apply').onclick = resetSim;
$('#speed').onchange = (e) => (state.speed = Number(e.target.value));

// ------------------------------------------------------------------ modes & picking
const HINTS = {
  origin: 'Click the terrain to set the ORIGIN (resets the mission)',
  destination: 'Click the terrain to set the DESTINATION (the leader replans in flight)',
  beacon: 'Click the terrain to place a landmark with known geolocation',
  nofly: 'Click the terrain to place a no-fly zone (r = 150 m); the leader replans',
  threat: 'Click the terrain to place an anti-air site (the swarm does not know where it is)',
  jammer: 'Click the terrain to place a jammer (type and radius from Jamming & C2; the swarm does not know where it is)',
  shoot: 'Click a drone to shoot it down',
};
function setMode(m) {
  state.mode = m;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === m);
  const hint = $('#mode-hint');
  hint.hidden = m === 'orbit';
  hint.textContent = (HINTS[m] ?? '') + ' · Esc to exit';
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);

function onPick(hit) {
  if (hit.type === 'drone') {
    if (state.mode === 'shoot') {
      shootDrone(hit.id);
      return;
    }
    state.selected = state.selected === hit.id ? null : hit.id;
    updatePanels();
    return;
  }
  if (state.mode === 'shoot') return;
  const p = { x: Math.round(hit.point.x), z: Math.round(hit.point.z) };
  switch (state.mode) {
    case 'origin':
      state.cfg.origin = p;
      resetSim();
      break;
    case 'destination':
      state.cfg.destination = p;
      sim.setDestination(p.x, p.z);
      world.buildMarkers(sim.cfg);
      break;
    case 'beacon':
      state.cfg.customBeacons.push(p);
      sim.cfg.customBeacons.push(p);
      sim.beacons.push({ id: sim.beacons.length, x: p.x, z: p.z, y: sim.terrain.heightAt(p.x, p.z), custom: true });
      world.buildBeacons(sim.beacons);
      break;
    case 'nofly': {
      const z = { ...p, r: 150 };
      state.cfg.noFly.push(z);
      sim.cfg.noFly.push({ ...z });
      world.buildNoFly(sim.cfg.noFly);
      if (sim.phase !== 'ready') sim.requestReplan();
      break;
    }
    case 'jammer': {
      const j = { ...p, type: state.cfg.jammers.type, r: state.cfg.jammers.radius };
      state.cfg.jammers.custom.push(j);
      sim.cfg.jammers.custom.push({ ...j });
      sim.addJammer(p.x, p.z, j.type, j.r, true);
      world.buildJammers(sim);
      break;
    }
    case 'threat':
      state.cfg.threats.custom.push(p);
      sim.cfg.threats.custom.push({ ...p });
      sim.addThreat(p.x, p.z, true);
      world.buildThreats(sim);
      break;
    default:
      state.selected = null;
  }
  saveConfig();
}

// ------------------------------------------------------------------ operator kills
function shootDrone(id) {
  if (sim.phase === 'ready') return flash('Start the mission first');
  const d = sim.injectFailure(id, 'shot');
  if (!d) flash(`D${id} is not flying`);
  updatePanels();
}
function failSelected(type) {
  if (state.selected === null) return;
  if (sim.phase === 'ready') return flash('Start the mission first');
  if (!sim.injectFailure(state.selected, type)) flash(`D${state.selected} is not flying`);
  updatePanels();
}
$('#sel-shoot').onclick = () => failSelected('shot');
$('#sel-radio').onclick = () => failSelected('radio');
$('#sel-battery').onclick = () => failSelected('battery');
$('#sel-focus').onclick = () => state.selected !== null && world.zoomTo(sim.drones[state.selected].truePos, 220);
$('#sel-close').onclick = () => {
  state.selected = null;
  updatePanels();
};

// ------------------------------------------------------------------ failures & operator
function failTarget() {
  const v = $('#fail-target').value;
  if (v === 'selected') return state.selected;
  return v;
}
$('#btn-inject').onclick = () => {
  if (sim.phase === 'ready') return flash('Start the mission first');
  const target = failTarget();
  if (target === null) return flash('Select a drone first (click it in the 3D view or the table)');
  if (!sim.injectFailure(target, $('#fail-type').value)) flash('That drone is not flying');
};
$('#btn-kill-leader').onclick = () => {
  if (!sim.injectFailure('leader', 'crash')) flash('No leader to kill yet');
};
$('#btn-handover').onclick = () => {
  if (!sim.forceHandover()) flash('No leader / successor available');
};
$('#btn-replan').onclick = () => sim.requestReplan();

$('#btn-schedule').onclick = () => {
  const t = Number($('#fail-at').value);
  const target = $('#fail-target').value === 'selected' ? state.selected ?? 'random' : $('#fail-target').value;
  const f = { t, target, type: $('#fail-type').value };
  state.cfg.failures.push(f);
  state.cfg.failures.sort((a, b) => a.t - b.t);
  if (t > sim.t) {
    sim.failureQueue.push({ ...f });
    sim.failureQueue.sort((a, b) => a.t - b.t);
  }
  renderSchedule();
  saveConfig();
};
function renderSchedule() {
  const ul = $('#schedule');
  ul.innerHTML = '';
  state.cfg.failures.forEach((f, i) => {
    const li = document.createElement('li');
    if (sim.t >= f.t && sim.phase !== 'ready') li.className = 'done';
    const who = typeof f.target === 'number' ? `D${f.target}` : f.target;
    li.innerHTML = `<span>t=${f.t}s · ${who} · ${f.type}</span>`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove';
    del.onclick = () => {
      state.cfg.failures.splice(i, 1);
      const qi = sim.failureQueue.findIndex((q) => q.t === f.t && q.type === f.type && q.target === f.target);
      if (qi >= 0) sim.failureQueue.splice(qi, 1);
      renderSchedule();
      saveConfig();
    };
    li.appendChild(del);
    ul.appendChild(li);
  });
}
$('#chaos').oninput = (e) => {
  const v = Number(e.target.value);
  state.cfg.chaosInterval = v;
  sim.cfg.chaosInterval = v;
  sim.nextChaos = v > 0 ? sim.t + v : Infinity;
  $('#chaos-out').textContent = v ? `${v} s` : 'off';
  saveConfig();
};

// ------------------------------------------------------------------ view toggles
for (const cb of document.querySelectorAll('[data-view]')) {
  cb.checked = state.view[cb.dataset.view];
  cb.onchange = () => (state.view[cb.dataset.view] = cb.checked);
}

// ------------------------------------------------------------------ scenario file
$('#btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `swarm-scenario-${state.cfg.terrain.preset}-${state.cfg.seed}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    state.cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(await f.text()));
    buildControls();
    syncControlValues();
    resetSim();
    saveConfig();
    flash(`Loaded ${f.name}`);
  } catch (err) {
    flash(`Could not read scenario: ${err.message}`);
  }
  e.target.value = '';
};
$('#btn-clear-zones').onclick = () => {
  state.cfg.noFly = [];
  state.cfg.customBeacons = [];
  state.cfg.threats.custom = [];
  state.cfg.jammers.custom = [];
  saveConfig();
  resetSim();
};
$('#btn-defaults').onclick = () => {
  state.cfg = cloneConfig(DEFAULT_CONFIG);
  buildControls();
  syncControlValues();
  saveConfig();
  resetSim();
};

// ------------------------------------------------------------------ demos & camera
for (const [key, d] of Object.entries(DEMOS)) $('#demo').add(new Option(d.title, key));
function loadDemo(key) {
  const d = DEMOS[key];
  $('#demo').value = d ? key : '';
  $('#demo-desc').hidden = !d;
  if (!d) return;
  $('#demo-desc').textContent = d.description;
  state.cfg = mergeConfig(DEFAULT_CONFIG, d.config);
  buildControls();
  syncControlValues();
  saveConfig();
  resetSim();
}
$('#demo').onchange = (e) => loadDemo(e.target.value);

function swarmCenter() {
  const fl = sim.drones.filter((d) => d.inSwarm());
  const list = fl.length ? fl : sim.drones;
  const c = { x: 0, y: 0, z: 0 };
  for (const d of list) (c.x += d.truePos.x / list.length), (c.y += d.truePos.y / list.length), (c.z += d.truePos.z / list.length);
  return c;
}
function zoomToSwarm() {
  world.zoomTo(swarmCenter(), 260 + sim.formationRadius() * 2.5);
}
$('#btn-zoom').onclick = zoomToSwarm;
$('#btn-overview').onclick = () => world.overview();

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleRun();
  } else if (e.key === 'Escape') setMode('orbit');
  else if (e.key === 'k' || e.key === 'K') $('#btn-kill-leader').click();
  else if (e.key === 'z' || e.key === 'Z') zoomToSwarm();
  else if (e.key === 'o' || e.key === 'O') world.overview();
  else if (e.key === 'f' || e.key === 'F') {
    state.view.follow = !state.view.follow;
    document.querySelector('[data-view="follow"]').checked = state.view.follow;
  }
});

// ------------------------------------------------------------------ panels
let flashTimer;
function flash(msg) {
  const h = $('#mode-hint');
  h.hidden = false;
  h.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setMode(state.mode), 2500);
}

sim.on((type, e) => {
  if (type === 'reset') return;
  if (type !== 'event') return;
  const li = document.createElement('li');
  li.innerHTML = `<time>${e.t.toFixed(1)}s</time><span class="${e.type}"></span>`;
  li.lastChild.textContent = e.text;
  const log = $('#log');
  log.prepend(li);
  while (log.children.length > 300) log.lastChild.remove();
});

function updatePanels() {
  const m = sim.metrics();
  const L = sim.leader;
  const rs = sim.radio.stats;
  const saving = rs.fullPowerEnergyJ > 0 ? (1 - rs.energyJ / rs.fullPowerEnergyJ) * 100 : 0;
  const rows = [
    ['Leader', L ? `D${L.id} (term ${L.term})` : sim.phase === 'ready' ? '-' : 'electing…'],
    ['Drones in swarm', `${m.inSwarm} / ${sim.drones.length}`],
    ['Distance to goal', m.distToGoal !== null ? `${m.distToGoal.toFixed(0)} m` : '-'],
    ['Route', L?.plan ? `${(L.plan.length / 1000).toFixed(2)} km, wp ${Math.min(L.wpIdx, L.plan.waypoints.length - 1)}/${L.plan.waypoints.length - 1}` : '-'],
    ['Nav error mean / max', `${m.meanErr.toFixed(1)} / ${m.maxErr.toFixed(1)} m`],
    ['Formation error', `${m.formationErr.toFixed(1)} m`],
    ['Elections / leader changes', `${sim.stats.elections} / ${sim.stats.leaderChanges}`],
    ['Landmark fixes', `${sim.stats.beaconFixes}`],
    ['Radio packets sent', `${rs.sent} (${(rs.bytes / 1024).toFixed(1)} kB)`],
    ['Radio energy', `${rs.energyJ.toFixed(2)} J · ${saving.toFixed(0)}% below full power`],
    ['Visibility', `${sim.weather.visibility().toFixed(0)} m`],
    ['Collisions', `${sim.stats.collisions}`],
  ];
  if (sim.threats.length) {
    const shots = sim.threats.reduce((a, t) => a + t.shots, 0), kills = sim.threats.reduce((a, t) => a + t.kills, 0);
    rows.splice(6, 0, ['Enemy shots / kills', `${shots} / ${kills}`], ['Threats located by swarm', L ? `${L.threats.size} / ${sim.threats.length}` : '-']);
  }
  if (sim.jammers.length || sim.cfg.nav.gnss) {
    const fl = sim.drones.filter((d) => d.flying());
    rows.splice(6, 0, ['GNSS fixes', `${sim.stats.gnssFixes}${sim.cfg.nav.gnss ? '' : ' (GNSS off)'}`],
      ['In contact with central', `${fl.filter((d) => d.c2Ok).length} / ${fl.length}${sim.pendingOrders.length ? ` · ${sim.pendingOrders.length} order(s) waiting` : ''}`],
      ['Jammed now (radio / GNSS)', `${fl.filter((d) => d.jam.comms >= 0.5).length} / ${fl.filter((d) => d.jam.gnss >= 0.5).length}`],
      ['Jamming found by swarm', L ? `${L.jamZones.size} / ${sim.jammers.length}` : '-']);
  }
  if (sim.arrivalTime !== null) rows.unshift(['Arrived', `t = ${sim.arrivalTime.toFixed(1)} s`]);
  $('#status').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  // Selected-drone action panel
  const sd = state.selected !== null ? sim.drones[state.selected] : null;
  $('#sel-hud').hidden = !sd;
  if (sd) {
    const role = sd.isLeader && sd.radioOk ? '★ leader' : 'follower';
    $('#sel-title').textContent = `D${sd.id} · ${role} · ${sd.status}${!sd.radioOk ? ' · no radio' : ''} · battery ${(sd.batteryFrac() * 100).toFixed(0)}%`;
    const can = sd.flying() && sd.status !== 'landing' && sim.phase !== 'ready';
    for (const id of ['#sel-shoot', '#sel-radio', '#sel-battery']) $(id).disabled = !can;
  }

  const tb = $('#drones tbody');
  tb.innerHTML = sim.drones
    .map((d) => {
      const bf = d.batteryFrac();
      const err = Math.hypot(d.loc.est.x - d.truePos.x, d.loc.est.z - d.truePos.z);
      let st = d.status, cls = '';
      if (d.status === 'crashed') cls = 'bad';
      else if (!d.radioOk) (st += ' · no radio'), (cls = 'warn');
      else if (d.status === 'landing' || d.status === 'landed') cls = 'dim';
      const slot = L && L.formation.slots.has(d.id) ? L.formation.slots.get(d.id) : '-';
      const color = bf > 0.4 ? '#3ddc84' : bf > 0.2 ? '#ffb020' : '#ff4d4f';
      return `<tr data-id="${d.id}" class="${state.selected === d.id ? 'sel' : ''}">
        <td class="${d.isLeader && d.radioOk ? 'lead' : ''}">${d.isLeader && d.radioOk ? '★' : ''}D${d.id}</td>
        <td class="${cls}">${st}</td>
        <td><span class="bar"><i style="width:${(bf * 100).toFixed(0)}%;background:${color}"></i></span>${(bf * 100).toFixed(0)}%</td>
        <td>${d.flying() ? err.toFixed(1) : '-'}</td>
        <td>${d.flying() ? d.loc.sigma.toFixed(1) : '-'}</td>
        <td>${slot}</td>
        <td>${d.flying() && d.status !== 'landing' ? `<button class="kill" data-kill="${d.id}" title="Shoot down D${d.id}">✖</button>` : ''}</td></tr>`;
    })
    .join('');

  const ph = $('#phase');
  ph.textContent = sim.phase;
  ph.className = `badge ${sim.phase}`;
  $('#clock').textContent = `t = ${sim.t.toFixed(1)} s`;
  const w = sim.weather;
  $('#wind-text').textContent = `wind ${w.windSpeed.toFixed(1)} m/s from ${w.windDir}°`;
  chart.draw(sim.history, sim.events, sim.drones.length);
  if (sim.tick % 10 === 0) renderSchedule();
  updateRunButton();
}
// pointerdown, not click: the table re-renders 4x per second, which can swallow clicks.
$('#drones tbody').addEventListener('pointerdown', (e) => {
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    shootDrone(Number(kill.dataset.kill));
    return;
  }
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  state.selected = state.selected === id ? null : id;
  const d = sim.drones[id];
  if (state.selected !== null && d) world.focusOn(d.truePos);
  updatePanels();
});

// ------------------------------------------------------------------ loop
let last = performance.now(), acc = 0, lastUi = 0;
function frame(now) {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.running) {
    acc += real * state.speed;
    const dt = sim.cfg.dt;
    let n = 0;
    while (acc >= dt && n < 400) {
      sim.step(dt);
      acc -= dt;
      n++;
    }
    if (n >= 400) acc = 0;
  }
  world.sync(sim, state.view, state.selected, real);
  const az = world.azimuthDeg();
  $('#rose').style.transform = `rotate(${az}deg)`;
  $('#wind-arrow').style.transform = `rotate(${sim.weather.windDir + 180}deg)`;
  world.render();
  if (now - lastUi > 250) {
    updatePanels();
    lastUi = now;
  }
  requestAnimationFrame(frame);
}

// URL options for unattended demos:
//   ?demo=storm&autorun=1&speed=4&follow=1&zoom=1&skip=60 (fast-forward seconds)
const params = new URLSearchParams(location.search);
if (params.has('demo')) loadDemo(params.get('demo'));
if (params.has('speed')) {
  state.speed = Number(params.get('speed')) || 1;
  $('#speed').value = String(state.speed);
}
if (params.has('follow')) state.view.follow = true;
document.querySelector('[data-view="follow"]').checked = state.view.follow;
if (params.has('skip')) sim.run(Number(params.get('skip')) || 0);
if (params.has('zoom')) zoomToSwarm();
if (params.has('select')) state.selected = Number(params.get('select'));
if (params.get('autorun') === '1') state.running = true;

buildControls();
syncControlValues();
updatePanels();
if (params.has('designer')) openDesigner();
requestAnimationFrame(frame);

// Debug / test handle (used by tools/ui-check.mjs and handy in the browser console).
window.__swarm = { sim, state, world, designer };
