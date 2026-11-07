// Small canvas time-series chart: navigation error, formation error and swarm size,
// with markers for failures and leader changes.

const C = {
  grid: 'rgba(255,255,255,0.08)',
  text: '#8b98a8',
  err: '#7ee0ff',
  maxErr: 'rgba(126,224,255,0.35)',
  form: '#ff8a3d',
  count: '#3ddc84',
  failure: '#ff4d4f',
  leader: '#ffb020',
};

export class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  draw(history, events, total) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 30, r: 22, t: 8, b: 16 };
    const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
    if (!history.length) {
      ctx.fillStyle = C.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('Start the mission to see metrics', pad.l, pad.t + h / 2);
      return;
    }
    const t1 = history[history.length - 1].t;
    const t0 = Math.max(0, t1 - 300);
    const hs = history.filter((p) => p.t >= t0);
    const yMax = Math.max(10, ...hs.map((p) => Math.max(p.maxErr, p.formationErr))) * 1.1;
    const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * w;
    const Y = (v) => pad.t + h - (v / yMax) * h;
    const Yc = (n) => pad.t + h - (n / Math.max(1, total)) * h;

    ctx.font = '10px system-ui, sans-serif';
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.lineWidth = 1;
    const step = yMax > 100 ? 50 : yMax > 40 ? 20 : yMax > 20 ? 10 : 5;
    for (let v = 0; v <= yMax; v += step) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(v));
      ctx.lineTo(pad.l + w, Y(v));
      ctx.stroke();
      ctx.fillText(`${v}`, 4, Y(v) + 3);
    }
    ctx.fillText(`${total}`, pad.l + w + 6, Yc(total) + 8);
    ctx.fillText(`t=${t0.toFixed(0)}s`, pad.l, H - 3);
    ctx.fillText(`${t1.toFixed(0)}s`, pad.l + w - 24, H - 3);

    for (const e of events) {
      if (e.t < t0 || (e.type !== 'failure' && e.type !== 'leader')) continue;
      ctx.strokeStyle = e.type === 'failure' ? C.failure : C.leader;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(X(e.t), pad.t);
      ctx.lineTo(X(e.t), pad.t + h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const line = (key, color, yf, dash = [], width = 1.6) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      hs.forEach((p, i) => (i ? ctx.lineTo(X(p.t), yf(p[key])) : ctx.moveTo(X(p.t), yf(p[key]))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line('inSwarm', C.count, Yc, [], 1.2);
    line('maxErr', C.maxErr, Y, [3, 3], 1);
    line('formationErr', C.form, Y);
    line('meanErr', C.err, Y, [], 2);
  }
}
