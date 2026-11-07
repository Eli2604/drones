// End-to-end UI check: drives headless Chrome via the DevTools protocol and verifies the
// interactive features (kill from table / 3D click / selection panel, formation designer,
// terrain sliders). Requires `npm start` running and Chrome installed.
// Usage: node tools/ui-check.mjs [chromePath]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5173/';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'swarm-ui-'))}`,
  '--disable-extensions', '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expr}\n${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
const click = async (x, y, button = 'left') => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  await sleep(150);
};
const drag = async (x0, y0, x1, y1) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 5; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * k) / 5, y: y0 + ((y1 - y0) * k) / 5, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
};
const centerOf = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const droneScreen = (i) =>
  evaluate(`(() => { const { sim, world } = window.__swarm; const p = sim.drones[${i}].truePos; const v = world.camera.position.clone(); v.set(p.x, p.y + 2, p.z).project(world.camera);
    const r = world.renderer.domElement.getBoundingClientRect(); return { x: r.x + (v.x + 1) / 2 * r.width, y: r.y + (1 - v.y) / 2 * r.height }; })()`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

try {
  let targets;
  for (let k = 0; k < 40; k++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).res(msg.result ?? msg);
      pending.delete(msg.id);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${URL}?demo=leader-loss&skip=40&zoom=1` });
  for (let k = 0; k < 40 && !(await evaluate('!!window.__swarm').catch(() => false)); k++) await sleep(250);
  await sleep(800);

  // 1. Kill from the drones table
  let p = await centerOf('[data-kill="2"]');
  await click(p.x, p.y);
  check('table ✖ shoots down D2', await evaluate(`window.__swarm.sim.drones[2].status === 'crashed'`));

  // 2. Select a drone by clicking it in 3D, then shoot it from the selection panel
  p = await droneScreen(4);
  await click(p.x, p.y);
  check('click in 3D selects D4', (await evaluate('window.__swarm.state.selected')) === 4, `selected=${await evaluate('window.__swarm.state.selected')}`);
  await sleep(400);
  check('selection panel visible', await evaluate(`!document.querySelector('#sel-hud').hidden`));
  p = await centerOf('#sel-shoot');
  await click(p.x, p.y);
  check('selection panel "Shoot down" kills D4', await evaluate(`window.__swarm.sim.drones[4].status === 'crashed'`));

  // 3. Shoot mode: click a drone in the 3D view
  p = await centerOf('[data-mode="shoot"]');
  await click(p.x, p.y);
  p = await droneScreen(6);
  await click(p.x, p.y);
  check('🎯 shoot mode: clicking D6 shoots it down', await evaluate(`window.__swarm.sim.drones[6].status === 'crashed'`));
  check('explosion effect spawned', (await evaluate('window.__swarm.sim.explosions.length')) >= 3);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // 4. Formation designer: open, add a slot, drag it, apply
  await evaluate(`[...document.querySelectorAll('#controls button')].find(b => b.textContent.includes('Design')).click()`);
  await sleep(300);
  const before = await evaluate('window.__swarm.designer.slots.length');
  const top = await evaluate(`(() => { const r = document.querySelector('.designer canvas[data-view="top"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  // empty spot: 3 units right, 3 units forward of centre
  const s = Math.min(top.w, top.h) / 9;
  await click(top.x + top.w / 2 + 3 * s, top.y + top.h / 2 - 3 * s);
  const after = await evaluate('window.__swarm.designer.slots.length');
  check('designer: click adds a slot', after === before + 1, `${before} -> ${after}`);
  const added = await evaluate('window.__swarm.designer.slots.at(-1)');
  check('designer: slot placed at clicked position', Math.abs(added.r - 3) < 0.3 && Math.abs(added.f - 3) < 0.3, JSON.stringify(added));
  const side = await evaluate(`(() => { const r = document.querySelector('.designer canvas[data-view="side"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const sx = side.x + side.w / 2 + added.f * s, sy = side.y + side.h / 2 - added.u * s;
  await drag(sx, sy, sx, sy - 2 * s);
  const lifted = await evaluate('window.__swarm.designer.slots.at(-1)');
  check('designer: dragging in side view sets height', Math.abs(lifted.u - 2) < 0.3, JSON.stringify(lifted));
  p = await centerOf('.designer [data-act="apply"]');
  await click(p.x, p.y);
  const sw = await evaluate('({ f: window.__swarm.sim.cfg.swarm.formation, n: window.__swarm.sim.cfg.swarm.customSlots.length })');
  check('designer: Apply switches the live swarm to the custom formation', sw.f === 'custom' && sw.n === after, JSON.stringify(sw));
  await evaluate('window.__swarm.sim.run(20)');
  const sig = await evaluate('window.__swarm.sim.leader.formation.sig');
  check('leader is flying the custom formation', JSON.parse(sig)[0] === 'custom');

  // 5. Terrain sliders regenerate the terrain
  await evaluate(`document.querySelector('#btn-reset').click()`);
  const h0 = await evaluate('window.__swarm.sim.terrain.maxH');
  await evaluate(`(() => { const i = document.querySelector('[data-path="terrain.amp"]'); i.value = 600; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  const h1 = await evaluate('window.__swarm.sim.terrain.maxH');
  check('terrain "Max height" slider rebuilds terrain', h1 > h0 * 2, `${h0.toFixed(0)} m -> ${h1.toFixed(0)} m`);
  await evaluate(`(() => { const i = document.querySelector('[data-path="terrain.ridged"]'); i.checked = true; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  check('terrain "Sharp ridges" toggles ridged noise', await evaluate('window.__swarm.sim.terrain.params.ridged === true'));

  // 6. Place an anti-air site by clicking the terrain
  p = await centerOf('[data-mode="threat"]');
  await click(p.x, p.y);
  const n0 = await evaluate('window.__swarm.sim.threats.length');
  const vp = await evaluate(`(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 }; })()`);
  await click(vp.x, vp.y);
  check('AA site mode: clicking terrain places a threat', (await evaluate('window.__swarm.sim.threats.length')) === n0 + 1);
  const errs = await evaluate('window.__errors ?? []');
  check('no uncaught page errors', errs.length === 0, errs.join('; '));
} catch (e) {
  console.error(e);
  results.push({ ok: false });
} finally {
  ws?.close();
  chrome.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nAll ${results.length} UI checks passed`);
process.exitCode = failed ? 1 : 0;
