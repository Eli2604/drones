// Three.js rendering of the simulation. Read-only view of the Simulation state.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { offsetToWorld } from '../core/formation.js';

export const COLORS = {
  leader: 0xffb020,
  follower: 0x3fa9f5,
  radio: 0xb06cff,
  landing: 0x9aa4b2,
  crashed: 0xff4d4f,
  est: 0x7ee0ff,
  path: 0xff8a3d,
  link: 0x46e3b7,
  beacon: 0xffd84d,
  origin: 0x3ddc84,
  dest: 0xff5a5f,
  slot: 0xffffff,
};
const DRONE_SCALE = 7; // drones are drawn ~7x life size so they stay visible at map scale
const MAX_TRAIL = 400;

function makeLabel(text, cls) {
  const el = document.createElement('div');
  el.className = `label ${cls ?? ''}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function droneMesh() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.follower, roughness: 0.5, metalness: 0.2, emissive: 0x000000 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), mat);
  g.add(body);
  const arm = new THREE.BoxGeometry(2.2, 0.08, 0.14);
  const a1 = new THREE.Mesh(arm, dark);
  a1.rotation.y = Math.PI / 4;
  const a2 = new THREE.Mesh(arm, dark);
  a2.rotation.y = -Math.PI / 4;
  g.add(a1, a2);
  const rotors = [];
  const rg = new THREE.CylinderGeometry(0.42, 0.42, 0.04, 16);
  const rm = new THREE.MeshStandardMaterial({ color: 0xdfe7ef, transparent: true, opacity: 0.55 });
  for (const [x, z] of [[0.78, 0.78], [-0.78, 0.78], [0.78, -0.78], [-0.78, -0.78]]) {
    const r = new THREE.Mesh(rg, rm);
    r.position.set(x, 0.12, z);
    g.add(r);
    rotors.push(r);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.5, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0, -0.6);
  g.add(nose);
  // Generous invisible hit proxy for picking.
  const hit = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 8), new THREE.MeshBasicMaterial({ visible: false }));
  g.add(hit);
  g.scale.setScalar(DRONE_SCALE);
  return { group: g, mat, rotors };
}

export class World3D {
  constructor(container, { onPick } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.sky = new THREE.Color(0x8fb8de);
    this.scene.background = this.sky.clone();
    this.scene.fog = new THREE.Fog(this.sky.clone(), 2000, 9000);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 40000);
    this.camera.position.set(-1500, 1300, 1900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-200, 100, 200);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 9000;

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x445533, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-1, 1.4, 0.6);
    this.scene.add(sun);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.time = 0;

    this.raycaster = new THREE.Raycaster();
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.pick(e);
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.buildRain();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.droneObjs.map((o) => o.group), true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && o.userData.droneId === undefined) o = o.parent;
      if (o) return this.onPick?.({ type: 'drone', id: o.userData.droneId });
    }
    const th = this.raycaster.intersectObject(this.terrainMesh);
    if (th.length) this.onPick?.({ type: 'ground', point: th[0].point });
  }

  // ---------------------------------------------------------------- build
  build(sim) {
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      c.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (o.isCSS2DObject) o.element.remove();
      });
    }
    this.buildTerrain(sim.terrain);
    this.buildMarkers(sim.cfg);
    this.buildBeacons(sim.beacons);
    this.buildNoFly(sim.cfg.noFly);
    this.buildDrones(sim);
    this.buildThreats(sim);
    this.buildJammers(sim);
    this.buildEffects();
    this.pathVer = -1;
  }

  /** Jammers (ground truth): a mast with its jamming dome (violet: radio, cyan: GNSS); the central station. */
  buildJammers(sim) {
    if (this.jamGroup) this.root.remove(this.jamGroup);
    this.jamGroup = new THREE.Group();
    this.jamObjs = [];
    for (const j of sim.jammers) {
      const color = j.type === 'gnss' ? 0x32d6ff : j.type === 'comms' ? 0xb36bff : 0xe05cff;
      const g = new THREE.Group();
      g.position.set(j.x, j.y - 6, j.z);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.6, 24, 8), new THREE.MeshStandardMaterial({ color: 0x2b2f36 }));
      mast.position.y = 12;
      const head = new THREE.Mesh(new THREE.OctahedronGeometry(4), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
      head.position.y = 27;
      const domeMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(j.r, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
      const edge = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(j.r, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 }));
      const label = makeLabel(`J${j.id} ${j.type === 'gnss' ? 'GNSS' : j.type === 'comms' ? 'RADIO' : 'RADIO+GNSS'}`, 'threat');
      label.position.y = 40;
      g.add(mast, head, dome, edge, label);
      this.jamGroup.add(g);
      this.jamObjs.push({ head, domeMat });
    }
    const c = sim.central;
    const st = new THREE.Group();
    st.position.set(c.x, c.y - 8, c.z);
    const hut = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 10), new THREE.MeshStandardMaterial({ color: 0x55604a }));
    hut.position.y = 3;
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 22, 6), new THREE.MeshStandardMaterial({ color: 0x9aa3ad }));
    ant.position.set(5, 14, 0);
    const lab = makeLabel('CENTRAL (C2)', 'intel');
    lab.position.y = 30;
    st.add(hut, ant, lab);
    this.jamGroup.add(st);
    this.root.add(this.jamGroup);
  }

  /** Ground-truth anti-air sites with their engagement-range domes. */
  buildThreats(sim) {
    if (this.threatGroup) this.root.remove(this.threatGroup);
    this.threatGroup = new THREE.Group();
    this.threatObjs = [];
    const R = sim.cfg.threats.range;
    for (const th of sim.threats) {
      const g = new THREE.Group();
      g.position.set(th.x, th.y, th.z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 6, 12), new THREE.MeshStandardMaterial({ color: 0x4a1c22 }));
      base.position.y = 3;
      const turret = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), new THREE.MeshStandardMaterial({ color: 0xff2d55, emissive: 0x440010 }));
      turret.position.y = 9;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 16, 8), new THREE.MeshStandardMaterial({ color: 0x222831 }));
      barrel.rotation.x = Math.PI / 3;
      barrel.position.set(0, 13, -5);
      const domeMat = new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.25 });
      const edge = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)), edgeMat);
      const label = makeLabel(`T${th.id}`, 'threat');
      label.position.y = 30;
      g.add(base, turret, barrel, dome, edge, label);
      this.threatGroup.add(g);
      this.threatObjs.push({ g, dome, edge, turret, domeMat, edgeMat, builtR: R });
    }
    // What the swarm believes (leader's threat map): orange rings, pooled.
    this.intel = [];
    for (let i = 0; i < 24; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 6, 96), new THREE.MeshBasicMaterial({ color: 0xff9f0a, transparent: true, opacity: 0.8 }));
      ring.rotation.x = Math.PI / 2;
      ring.visible = false;
      const label = makeLabel('threat?', 'intel');
      label.visible = false;
      label.position.set(0, 0, 0);
      ring.add(label);
      this.threatGroup.add(ring);
      this.intel.push({ ring, label });
    }
    this.root.add(this.threatGroup);
  }

  buildEffects() {
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 6), 3));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(128 * 6), 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.tracers.frustumCulled = false;
    this.booms = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false }));
      m.visible = false;
      this.booms.push(m);
      this.root.add(m);
    }
    this.root.add(this.tracers);
  }

  buildTerrain(terrain) {
    const { size, res, maxH } = terrain;
    const geo = new THREE.PlaneGeometry(size, size, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color(0x3f6b35), mid = new THREE.Color(0x7d9450), high = new THREE.Color(0x8a7558), snow = new THREE.Color(0xecefee);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = terrain.heightAt(x, z);
      pos.setY(i, h);
      const t = h / Math.max(60, maxH);
      if (t < 0.45) c.lerpColors(low, mid, t / 0.45);
      else if (t < 0.8 || maxH < 300) c.lerpColors(mid, high, Math.min(1, (t - 0.45) / 0.35));
      else c.lerpColors(high, snow, Math.min(1, (t - 0.8) / 0.12));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.terrainMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.root.add(this.terrainMesh);
    // Subtle 200 m grid draped slightly above the terrain for scale.
    const lines = [];
    const step = 200, half = size / 2;
    for (let g = -half; g <= half + 1e-6; g += step) {
      for (let s = -half; s < half; s += 20) {
        lines.push(g, terrain.heightAt(g, s) + 1.5, s, g, terrain.heightAt(g, s + 20) + 1.5, s + 20);
        lines.push(s, terrain.heightAt(s, g) + 1.5, g, s + 20, terrain.heightAt(s + 20, g) + 1.5, g);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.root.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 })));
    this.terrain = terrain;
  }

  buildMarkers(cfg) {
    if (this.markers) this.root.remove(this.markers);
    this.markers = new THREE.Group();
    const mk = (p, color, text) => {
      const g = new THREE.Group();
      const y = this.terrain.heightAt(p.x, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 140, 10), new THREE.MeshBasicMaterial({ color }));
      pole.position.y = 70;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(30, 2.5, 8, 48), new THREE.MeshBasicMaterial({ color }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 3;
      const label = makeLabel(text, 'marker');
      label.position.y = 155;
      g.add(pole, ring, label);
      g.position.set(p.x, y, p.z);
      return g;
    };
    this.markers.add(mk(cfg.origin, COLORS.origin, 'ORIGIN'), mk(cfg.destination, COLORS.dest, 'DESTINATION'));
    this.root.add(this.markers);
  }

  buildBeacons(beacons) {
    if (this.beaconGroup) this.root.remove(this.beaconGroup);
    this.beaconGroup = new THREE.Group();
    const geo = new THREE.ConeGeometry(7, 22, 4);
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.beacon, emissive: 0x664400 });
    for (const b of beacons) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(b.x, b.y + 11, b.z);
      const l = makeLabel(`B${b.id}`, 'beacon');
      l.position.y = 20;
      m.add(l);
      this.beaconGroup.add(m);
    }
    this.beaconPos = beacons.map((b) => new THREE.Vector3(b.x, b.y + 22, b.z));
    this.root.add(this.beaconGroup);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 6), 3));
    this.fixLines = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: COLORS.beacon, transparent: true, opacity: 0.9 }));
    this.fixLines.frustumCulled = false;
    this.beaconGroup.add(this.fixLines);
  }

  buildNoFly(zones) {
    if (this.noFlyGroup) this.root.remove(this.noFlyGroup);
    this.noFlyGroup = new THREE.Group();
    for (const z of zones) {
      const y = this.terrain.heightAt(z.x, z.z);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(z.r, z.r, 1400, 48, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }),
      );
      cyl.position.set(z.x, y + 500, z.z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(z.r, 2, 6, 64), new THREE.MeshBasicMaterial({ color: 0xff3344 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(z.x, y + 40, z.z);
      this.noFlyGroup.add(cyl, ring);
    }
    this.root.add(this.noFlyGroup);
  }

  buildDrones(sim) {
    const n = sim.drones.length;
    this.droneObjs = sim.drones.map((d) => {
      const m = droneMesh();
      m.group.userData.droneId = d.id;
      const label = makeLabel(`D${d.id}`, 'drone');
      label.position.y = 2.2;
      m.group.add(label);
      m.label = label;
      m.labelText = '';
      const ghost = new THREE.Mesh(
        new THREE.SphereGeometry(3.5, 10, 8),
        new THREE.MeshBasicMaterial({ color: COLORS.est, wireframe: true, transparent: true, opacity: 0.7 }),
      );
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const errLine = new THREE.Line(eg, new THREE.LineBasicMaterial({ color: COLORS.est }));
      errLine.frustumCulled = false;
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
      const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: COLORS.follower, transparent: true, opacity: 0.45 }));
      trail.frustumCulled = false;
      this.root.add(m.group, ghost, errLine, trail);
      return { ...m, ghost, errLine, trail };
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * n * 6), 3));
    this.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLORS.link, transparent: true, opacity: 0.35 }));
    this.links.frustumCulled = false;
    this.root.add(this.links);

    this.crown = new THREE.Mesh(new THREE.TorusGeometry(14, 1.6, 8, 40), new THREE.MeshBasicMaterial({ color: COLORS.leader }));
    this.crown.rotation.x = Math.PI / 2;
    this.selRing = new THREE.Mesh(new THREE.TorusGeometry(18, 1.2, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.selRing.rotation.x = Math.PI / 2;
    this.root.add(this.crown, this.selRing);

    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.slots = new THREE.Points(sg, new THREE.PointsMaterial({ color: COLORS.slot, size: 9, transparent: true, opacity: 0.8 }));
    this.slots.frustumCulled = false;
    this.root.add(this.slots);

    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.path }));
    this.pathDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: COLORS.path, size: 7 }));
    this.pathDrops = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.25 }));
    this.root.add(this.pathLine, this.pathDots, this.pathDrops);
  }

  buildRain() {
    // Rain as short streaks (two vertices per drop), slanted by the wind.
    const N = 5000;
    this.rainDrops = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) this.rainDrops.set([(Math.random() - 0.5) * 1600, Math.random() * 700, (Math.random() - 0.5) * 1600], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc4d8f5, transparent: true, opacity: 0.0, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  // ---------------------------------------------------------------- per frame
  setWeather(w) {
    const clear = new THREE.Color(0x8fb8de), grey = new THREE.Color(0x66727e), fogc = new THREE.Color(0xc4ccd3);
    const sky = clear.clone().lerp(grey, Math.min(1, w.precipitation * 0.9)).lerp(fogc, w.fog * 0.85);
    this.scene.background.copy(sky);
    this.scene.fog.color.copy(sky);
    const vis = w.visibility();
    this.scene.fog.near = Math.min(2000, vis * 0.08);
    this.scene.fog.far = Math.max(250, vis * 1.4);
    this.rain.material.opacity = Math.min(0.85, w.precipitation * 1.1);
    this.rainWind = w.baseWind();
  }

  sync(sim, view, selected, dtReal) {
    this.time += dtReal;
    const t = sim.t;
    const L = sim.leader;

    sim.drones.forEach((d, i) => {
      const o = this.droneObjs[i];
      if (!o) return;
      o.group.position.set(d.truePos.x, d.truePos.y + 0.6 * DRONE_SCALE * 0.3, d.truePos.z);
      o.group.rotation.y = -d.heading;
      o.group.rotation.z = d.status === 'crashed' ? 0.6 : 0;
      let color = COLORS.follower;
      if (d.status === 'crashed') color = COLORS.crashed;
      else if (d.status === 'landing' || d.status === 'landed') color = COLORS.landing;
      else if (!d.radioOk) color = COLORS.radio;
      else if (d.isLeader) color = COLORS.leader;
      o.mat.color.setHex(color);
      o.mat.emissive.setHex(d.isLeader && d.radioOk ? 0x553300 : 0x000000);
      if (d.flying()) for (const r of o.rotors) r.rotation.y += dtReal * 40;
      const text = `${d.isLeader && d.radioOk ? '★ ' : ''}D${d.id}${d.status === 'crashed' ? ' ✖' : !d.radioOk ? ' (no radio)' : ''}`;
      if (text !== o.labelText) {
        o.label.element.textContent = text;
        o.label.element.classList.toggle('lead', d.isLeader && d.radioOk);
        o.labelText = text;
      }
      o.label.visible = view.labels;

      const showEst = view.estimates && d.flying();
      o.ghost.visible = showEst;
      o.errLine.visible = showEst;
      if (showEst) {
        o.ghost.position.set(d.loc.est.x, d.loc.est.y, d.loc.est.z);
        const a = o.errLine.geometry.attributes.position;
        a.setXYZ(0, d.truePos.x, d.truePos.y, d.truePos.z);
        a.setXYZ(1, d.loc.est.x, d.loc.est.y, d.loc.est.z);
        a.needsUpdate = true;
      }
      o.trail.visible = view.trails;
      if (view.trails) {
        const a = o.trail.geometry.attributes.position;
        const tr = d.trail;
        for (let k = 0; k < tr.length; k++) a.setXYZ(k, tr[k].x, tr[k].y, tr[k].z);
        a.needsUpdate = true;
        o.trail.geometry.setDrawRange(0, tr.length);
        o.trail.material.color.setHex(color);
      }
    });

    // Leader crown & selection ring
    this.crown.visible = !!L;
    if (L) this.crown.position.set(L.truePos.x, L.truePos.y + 16, L.truePos.z);
    const sel = selected !== null ? sim.drones[selected] : null;
    this.selRing.visible = !!sel;
    if (sel) {
      this.selRing.position.set(sel.truePos.x, sel.truePos.y, sel.truePos.z);
      this.selRing.rotation.z = this.time * 2;
    }

    // Radio links active in the last second
    {
      const a = this.links.geometry.attributes.position;
      let k = 0;
      if (view.links) {
        for (const [key, ts] of sim.radio.links) {
          if (t - ts > 1) continue;
          const [i, j] = key.split('-').map(Number);
          const p = sim.drones[i]?.truePos, q = sim.drones[j]?.truePos;
          if (!p || !q || k * 2 + 1 >= a.count) continue;
          a.setXYZ(k * 2, p.x, p.y, p.z);
          a.setXYZ(k * 2 + 1, q.x, q.y, q.z);
          k++;
        }
      }
      a.needsUpdate = true;
      this.links.geometry.setDrawRange(0, k * 2);
    }

    // Beacon recognitions
    {
      const a = this.fixLines.geometry.attributes.position;
      let k = 0;
      for (const f of sim.recentFixes) {
        if (t - f.t > 0.6 || k >= 128) continue;
        const p = sim.drones[f.drone].truePos, b = this.beaconPos[f.beacon];
        if (!b) continue;
        a.setXYZ(k * 2, p.x, p.y, p.z);
        a.setXYZ(k * 2 + 1, b.x, b.y, b.z);
        k++;
      }
      a.needsUpdate = true;
      this.fixLines.geometry.setDrawRange(0, k * 2);
    }

    // Jammers pulse; rebuilt when one is added
    if (this.jamObjs?.length !== sim.jammers.length) this.buildJammers(sim);
    this.jamObjs?.forEach((o, i) => (o.domeMat.opacity = 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(t * 3 + i))));
    // Threats: dome size follows the live range setting; turret flashes when firing.
    if (this.threatObjs?.length !== sim.threats.length) this.buildThreats(sim);
    const R = sim.cfg.threats.range;
    sim.threats.forEach((th, i) => {
      const o = this.threatObjs[i];
      const k = R / o.builtR;
      o.dome.scale.setScalar(k);
      o.edge.scale.setScalar(k);
      const recentShot = sim.shots.some((s) => s.threat === th.id && t - s.t < 0.3);
      o.domeMat.opacity = recentShot ? 0.14 : 0.06;
      o.turret.material.emissive.setHex(recentShot ? 0xff6020 : 0x440010);
    });
    {
      const L = sim.leader;
      const known = L ? [...L.threats.values()] : [];
      this.intel.forEach((it, i) => {
        const th = known[i];
        it.ring.visible = !!th && view.threats !== false;
        it.label.visible = it.ring.visible; // CSS2D labels don't inherit parent visibility
        if (!th) return;
        const y = this.terrain.heightAt(th.x, th.z) + 6;
        it.ring.position.set(th.x, y, th.z);
        it.ring.scale.setScalar(th.r);
        it.label.position.set(0, 0, 0);
      });
    }
    // Tracers (hit = red, miss = orange; misses pass beside the target)
    {
      const a = this.tracers.geometry.attributes.position, col = this.tracers.geometry.attributes.color;
      let k = 0;
      for (const s of sim.shots) {
        const age = t - s.t;
        if (age > 0.35 || k >= 128) continue;
        const miss = s.hit ? 0 : 6;
        const to = { x: s.to.x + miss * Math.sin(s.t * 7), y: s.to.y + miss * 0.5, z: s.to.z + miss * Math.cos(s.t * 7) };
        // Draw a short streak travelling from the gun to the target.
        const f0 = Math.min(1, age / 0.25), f1 = Math.max(0, f0 - 0.35);
        const p = (f) => [s.from.x + (to.x - s.from.x) * f, s.from.y + (to.y - s.from.y) * f, s.from.z + (to.z - s.from.z) * f];
        a.setXYZ(k * 2, ...p(f1));
        a.setXYZ(k * 2 + 1, ...p(f0));
        const c = s.hit ? [1, 0.25, 0.2] : [1, 0.75, 0.3];
        col.setXYZ(k * 2, ...c);
        col.setXYZ(k * 2 + 1, ...c);
        k++;
      }
      a.needsUpdate = true;
      col.needsUpdate = true;
      this.tracers.geometry.setDrawRange(0, k * 2);
    }
    // Explosions
    this.booms.forEach((m, i) => {
      const e = sim.explosions[sim.explosions.length - 1 - i];
      const age = e ? t - e.t : 99;
      m.visible = age < 1.2;
      if (!m.visible) return;
      const size = (e.big ? 16 : 8) * (0.4 + age * 1.6);
      m.position.set(e.pos.x, e.pos.y, e.pos.z);
      m.scale.setScalar(size);
      m.material.opacity = Math.max(0, 0.9 * (1 - age / 1.2));
      m.material.color.setHex(age < 0.25 ? 0xfff0a0 : 0xff7a30);
    });

    // Formation slots as the leader currently sees them
    {
      const a = this.slots.geometry.attributes.position;
      let k = 0;
      if (view.slots && L) {
        for (const [, s] of L.formation.slots) {
          const off = L.slotTable[s];
          if (!off || k >= a.count) continue;
          const w = offsetToWorld(off, L.heading);
          a.setXYZ(k++, L.loc.est.x + w.x, L.loc.est.y + w.y, L.loc.est.z + w.z);
        }
      }
      a.needsUpdate = true;
      this.slots.geometry.setDrawRange(0, k);
    }

    // Planned route
    const plan = L?.plan ?? sim.drones.find((d) => d.plan)?.plan;
    const ver = plan?.ver ?? -1;
    if (ver !== this.pathVer) {
      this.pathVer = ver;
      const wps = plan?.waypoints ?? [];
      const pts = wps.map((w) => new THREE.Vector3(w.x, w.y, w.z));
      this.pathLine.geometry.dispose();
      this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.pathDots.geometry.dispose();
      this.pathDots.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const drops = [];
      for (const w of wps) drops.push(new THREE.Vector3(w.x, w.y, w.z), new THREE.Vector3(w.x, this.terrain.heightAt(w.x, w.z), w.z));
      this.pathDrops.geometry.dispose();
      this.pathDrops.geometry = new THREE.BufferGeometry().setFromPoints(drops);
    }
    this.pathLine.visible = this.pathDots.visible = this.pathDrops.visible = view.path;

    // Camera follow: keep the camera's offset, glide the target to the swarm centre.
    if (view.follow) {
      const fl = sim.drones.filter((d) => d.inSwarm());
      if (fl.length) {
        const c = new THREE.Vector3();
        for (const d of fl) c.add(new THREE.Vector3(d.truePos.x, d.truePos.y, d.truePos.z));
        c.divideScalar(fl.length);
        const delta = c.sub(this.controls.target).multiplyScalar(Math.min(1, dtReal * 2.5));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }

    // Rain follows the camera target and drifts with the wind.
    if (this.rain.material.opacity > 0.01) {
      const a = this.rain.geometry.attributes.position;
      const p = this.rainDrops;
      const w = this.rainWind ?? { x: 0, z: 0 };
      const fall = 60, streak = 0.12; // m/s fall speed, streak length in seconds of motion
      const c = this.controls.target;
      for (let i = 0; i < p.length / 3; i++) {
        let x = p[i * 3] + w.x * dtReal, y = p[i * 3 + 1] - fall * dtReal, z = p[i * 3 + 2] + w.z * dtReal;
        if (y < 0) y += 700;
        if (x < -800) x += 1600; else if (x > 800) x -= 1600;
        if (z < -800) z += 1600; else if (z > 800) z -= 1600;
        p[i * 3] = x, p[i * 3 + 1] = y, p[i * 3 + 2] = z;
        a.setXYZ(i * 2, x, y, z);
        a.setXYZ(i * 2 + 1, x - w.x * streak, y + fall * streak, z - w.z * streak);
      }
      a.needsUpdate = true;
      this.rain.position.set(c.x, c.y - 250, c.z);
    }
    this.controls.update();
  }

  focusOn(p) {
    const delta = new THREE.Vector3(p.x, p.y, p.z).sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  /** Move the camera to look at p from `distance` metres, keeping the viewing direction. */
  zoomTo(p, distance) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(p.x, p.y, p.z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
  }

  overview() {
    this.controls.target.set(0, 100, 0);
    this.camera.position.set(-1500, 1500, 1900);
  }

  azimuthDeg() {
    return (this.controls.getAzimuthalAngle() * 180) / Math.PI;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
