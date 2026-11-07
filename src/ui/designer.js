// Formation designer: edit a custom 3D formation in a top view (forward/right) and a
// side view (forward/up). Units are "spacing units": 1 = the Spacing slider in metres.
import { FORMATIONS, FORMATION_LABELS, shapeUnits } from '../core/formation.js';

const EXTENT = 4.5; // view half-size in spacing units
const SNAP = 0.25;

export class FormationDesigner {
  constructor(host) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'designer';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="designer-card" role="dialog" aria-label="Formation designer">
        <header>
          <h2>Formation designer</h2>
          <span class="muted" data-ref="info"></span>
          <button data-act="close" title="Close (Esc)">✕</button>
        </header>
        <div class="designer-tools">
          <label>Start from
            <select data-ref="preset"><option value="">—</option></select>
          </label>
          <label class="inline"><input type="checkbox" data-ref="snap" checked /> Snap to ¼</label>
          <button data-act="mirror" title="Add left/right mirror images of off-centre slots">Mirror L↔R</button>
          <button data-act="clear">Clear</button>
        </div>
        <div class="designer-views">
          <figure><figcaption>Top view <span class="muted">↑ forward · → right · click empty space to add</span></figcaption><canvas data-view="top"></canvas></figure>
          <figure><figcaption>Side view <span class="muted">→ forward · ↑ up · drag to set height</span></figcaption><canvas data-view="side"></canvas></figure>
        </div>
        <div class="designer-sel" data-ref="sel"></div>
        <p class="muted small">Slots fill in order (1, 2, 3…). If the swarm has more drones than slots, the extra drones queue in a column behind. The leader (★) is always at the centre. Right-click or Delete removes the selected slot.</p>
        <footer>
          <button data-act="cancel">Cancel</button>
          <button data-act="apply" class="primary">Apply &amp; fly this formation</button>
        </footer>
      </div>`;
    host.appendChild(this.el);
    this.ref = (n) => this.el.querySelector(`[data-ref="${n}"]`);
    for (const f of FORMATIONS) if (f !== 'custom') this.ref('preset').add(new Option(FORMATION_LABELS[f], f));
    this.views = [...this.el.querySelectorAll('canvas')].map((c) => ({ canvas: c, kind: c.dataset.view }));
    this.el.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'close' || act === 'cancel') this.close();
      else if (act === 'apply') this.apply();
      else if (act === 'mirror') this.mirror();
      else if (act === 'clear') (this.slots = []), (this.sel = -1), this.draw();
    });
    this.ref('preset').onchange = (e) => {
      if (!e.target.value) return;
      this.slots = shapeUnits(e.target.value, this.count).slice(1).map((p) => ({ f: r4(p.f), r: r4(p.r), u: r4(p.u) }));
      this.sel = -1;
      e.target.value = '';
      this.draw();
    };
    for (const v of this.views) this.bindView(v);
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') this.close();
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel >= 0 && !e.target.matches('input')) this.remove(this.sel);
    });
    new ResizeObserver(() => !this.el.hidden && this.draw()).observe(this.el);
  }

  open({ slots, count, spacing, vSpread, onApply }) {
    this.slots = slots.map((s) => ({ ...s }));
    this.count = count;
    this.spacing = spacing;
    this.vSpread = vSpread;
    this.onApply = onApply;
    this.sel = -1;
    this.el.hidden = false;
    this.draw();
  }
  close() {
    this.el.hidden = true;
  }
  apply() {
    this.onApply?.(this.slots.map((s) => ({ ...s })));
    this.close();
  }
  remove(i) {
    this.slots.splice(i, 1);
    this.sel = -1;
    this.draw();
  }
  mirror() {
    const add = [];
    for (const s of this.slots) {
      if (Math.abs(s.r) < 1e-6) continue;
      const exists = this.slots.some((o) => near(o.f, s.f) && near(o.r, -s.r) && near(o.u, s.u));
      if (!exists) add.push({ f: s.f, r: -s.r, u: s.u });
    }
    this.slots.push(...add);
    this.draw();
  }

  // ---------------------------------------------------------------- view mapping
  geom(v) {
    const c = v.canvas;
    const W = c.clientWidth, H = c.clientHeight;
    const s = Math.min(W, H) / (2 * EXTENT);
    return { W, H, s, cx: W / 2, cy: H / 2 };
  }
  /** slot -> canvas px */
  toPx(v, p) {
    const g = this.geom(v);
    return v.kind === 'top' ? { x: g.cx + p.r * g.s, y: g.cy - p.f * g.s } : { x: g.cx + p.f * g.s, y: g.cy - p.u * g.s };
  }
  fromPx(v, x, y) {
    const g = this.geom(v);
    const a = (x - g.cx) / g.s, b = -(y - g.cy) / g.s;
    const sn = (q) => (this.ref('snap').checked ? Math.round(q / SNAP) * SNAP : r4(q));
    return v.kind === 'top' ? { r: sn(a), f: sn(b) } : { f: sn(a), u: sn(b) };
  }
  hit(v, x, y) {
    let best = -1, bd = 12;
    this.slots.forEach((p, i) => {
      const q = this.toPx(v, p);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  }

  bindView(v) {
    const c = v.canvas;
    let drag = -1, moved = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = pos(e);
      const i = this.hit(v, p.x, p.y);
      if (i >= 0) this.remove(i);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = pos(e);
      drag = this.hit(v, p.x, p.y);
      moved = false;
      if (drag >= 0) {
        this.sel = drag;
        c.setPointerCapture(e.pointerId);
        this.draw();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const p = pos(e);
      Object.assign(this.slots[drag], this.fromPx(v, p.x, p.y));
      moved = true;
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      const p = pos(e);
      if (drag < 0 && v.kind === 'top') {
        // Add a slot on empty space (top view).
        const q = this.fromPx(v, p.x, p.y);
        if (Math.hypot(q.f, q.r) > 0.2) {
          this.slots.push({ f: q.f, r: q.r, u: 0 });
          this.sel = this.slots.length - 1;
        }
      } else if (drag < 0) {
        this.sel = -1;
      }
      drag = -1;
      if (!moved) this.draw();
    });
  }

  // ---------------------------------------------------------------- render
  draw() {
    const m = this.count - 1;
    this.ref('info').textContent = `${this.slots.length} slots designed · swarm has ${this.count} drones (${m} followers)${this.slots.length < m ? ` · ${m - this.slots.length} will queue behind` : ''}`;
    for (const v of this.views) this.drawView(v);
    this.drawSel();
  }

  drawView(v) {
    const c = v.canvas, ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr || c.height !== H * dpr) (c.width = W * dpr), (c.height = H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const g = this.geom(v);
    // grid
    for (let k = -Math.floor(EXTENT); k <= EXTENT; k += 0.5) {
      ctx.strokeStyle = k === 0 ? 'rgba(255,255,255,0.28)' : Number.isInteger(k) ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.moveTo(g.cx + k * g.s, 0);
      ctx.lineTo(g.cx + k * g.s, H);
      ctx.moveTo(0, g.cy - k * g.s);
      ctx.lineTo(W, g.cy - k * g.s);
      ctx.stroke();
    }
    ctx.fillStyle = '#8b98a8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`1 unit = ${this.spacing} m${v.kind === 'side' ? ` (height × ${this.vSpread})` : ''}`, 6, H - 6);
    ctx.fillText(v.kind === 'top' ? 'forward ↑' : 'up ↑', g.cx + 4, 12);

    // leader first, so slots stacked directly above/below it stay visible and clickable
    const L = this.toPx(v, { f: 0, r: 0, u: 0 });
    ctx.beginPath();
    ctx.arc(L.x, L.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb020';
    ctx.fill();
    ctx.fillStyle = '#0e141b';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★', L.x, L.y + 4);
    ctx.textAlign = 'left';

    // slots, back-to-front for the side view (by right), top view (by up)
    const order = this.slots.map((p, i) => i).sort((a, b) => (v.kind === 'top' ? this.slots[a].u - this.slots[b].u : this.slots[a].r - this.slots[b].r));
    const depthKey = v.kind === 'top' ? 'u' : 'r';
    for (const i of order) {
      const p = this.slots[i];
      const q = this.toPx(v, p);
      const depth = p[depthKey];
      const rad = 7 + Math.max(-3, Math.min(3, depth * 1.5));
      ctx.beginPath();
      ctx.arc(q.x, q.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = i === this.sel ? '#ffffff' : depth > 0.05 ? '#6cc4ff' : depth < -0.05 ? '#2a6fa8' : '#3fa9f5';
      ctx.fill();
      ctx.fillStyle = i === this.sel ? '#0e141b' : '#ffffff';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), q.x, q.y + 3.5);
      ctx.textAlign = 'left';
    }
  }

  drawSel() {
    const box = this.ref('sel');
    if (this.sel < 0) {
      box.innerHTML = '<span class="muted">Select a slot to edit its exact position.</span>';
      return;
    }
    const p = this.slots[this.sel];
    box.innerHTML = `<b>Slot ${this.sel + 1}</b>
      <label>forward <input type="number" step="0.25" data-k="f" value="${p.f}"></label>
      <label>right <input type="number" step="0.25" data-k="r" value="${p.r}"></label>
      <label>up <input type="number" step="0.25" data-k="u" value="${p.u}"></label>
      <span class="muted">= ${(p.f * this.spacing).toFixed(0)} / ${(p.r * this.spacing).toFixed(0)} / ${(p.u * this.spacing * this.vSpread).toFixed(0)} m</span>
      <button data-del>Delete</button>`;
    for (const inp of box.querySelectorAll('input')) {
      inp.onchange = () => {
        p[inp.dataset.k] = Number(inp.value) || 0;
        for (const v of this.views) this.drawView(v);
        this.drawSel();
      };
    }
    box.querySelector('[data-del]').onclick = () => this.remove(this.sel);
  }
}

const r4 = (x) => Math.round(x * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 1e-3;
