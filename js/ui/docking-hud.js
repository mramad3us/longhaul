// ============================================================
// LONGHAUL — The docking display, and flying a docking by hand
//
// While a dock is under way the main view shows the exterior and this
// panel: the phase and berth, the docking camera (looking down the
// collar's axis: the target collar's rings, our crosshair, where our
// drift is taking us, the roll of the horizon), tapes for range and
// closing speed against the speed the computer would fly, the capture
// envelope of the collar, and the controls: who flies it (AUTO or
// MANUAL), the rate time runs at (hand-flying wants real time), kill
// drift, abort. Docked, it offers undocking (with or without a
// departure clearance).
//
// Hand flying: W/S close and open, A/D left and right, R/F up and down
// (translation on the RCS, accelerating while held); ←/→ yaw, ↑/↓ pitch,
// Q/E roll (the attitude computer holds whatever isn't commanded); X
// kills the drift. The keys are only taken while we fly a docking by
// hand; otherwise they keep their usual meanings.
// ============================================================

import { ui } from './context.js';
import { setHTML, setText, show, toggleClass, fmtMeters, fmtSpeed } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { bus } from '../core/events.js';
import {
  dockStatus, setDockMode, setDockInput, killDrift, abortDocking, undock, beginDocking, setProxRate, PROX_RATES, clearOff,
} from '../sim/docking.js';
import { requestDeparture, requestDocking, clearanceFor } from '../sim/traffic-control.js';

const emit = (t, p) => bus.emit(t, p);
const PHASE = {
  inbound: 'INBOUND TO THE GATE', approach: 'FINAL APPROACH', prox: 'PROXIMITY OPERATIONS', capture: 'SOFT CAPTURE',
  seal: 'HARD DOCK · EQUALIZING', docked: 'DOCKED', undock: 'UNDOCKING', separate: 'SEPARATING', holding: 'HOLDING OFF',
  outbound: 'CLIMBING OUT · RCS TO THE GATE',
};
const KEYS = {
  w: ['tx', 1], s: ['tx', -1], a: ['ty', -1], d: ['ty', 1], r: ['tz', 1], f: ['tz', -1],
  ArrowLeft: ['yaw', 1], ArrowRight: ['yaw', -1], ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1], q: ['roll', -1], e: ['roll', 1],
};

let root = null, cam = null, pressed = new Set();

export function initDockingHud(el) {
  root = el;
  root.innerHTML = `<div class="dh-head"><span class="dh-phase"></span><span class="dh-berth"></span></div>
    <div class="dh-body">
      <div class="dh-cam"><canvas width="220" height="220"></canvas></div>
      <div class="dh-read"></div>
    </div>
    <div class="dh-env"></div>
    <div class="dh-ctl"></div>
    <div class="dh-keys">W/S close · open &nbsp; A/D left · right &nbsp; R/F up · down<br>←/→ yaw &nbsp; ↑/↓ pitch &nbsp; Q/E roll &nbsp; X kill drift</div>`;
  cam = root.querySelector('canvas');
  root.addEventListener('click', onClick);
  // Hand-flying keys, taken before the game's own shortcuts
  document.addEventListener('keydown', (e) => {
    if (!manual()) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'x') { killDrift(ui.state); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (KEYS[k]) { pressed.add(k); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keyup', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    pressed.delete(k);
  }, true);
  window.addEventListener('blur', () => pressed.clear());
}

const manual = () => ui.state?.dock?.mode === 'manual' && ['prox'].includes(ui.state.dock.phase);

/** Per frame: the stick from the keys held, the panel, the camera. */
export function updateDockingHud(state) {
  if (!root) return;
  const st = dockStatus(state);
  // (on the way in, or waiting at the gate for a berth, there is nothing to fly yet: the TC chip says where we stand)
  const idle = !st || st.phase === 'inbound' || st.phase === 'awaiting';
  show(root, !idle);
  if (idle) return;
  if (manual()) {
    const input = {};
    for (const k of pressed) { const [axis, v] = KEYS[k]; input[axis] = (input[axis] || 0) + v; }
    setDockInput(state, input);
  }
  setText(root.querySelector('.dh-phase'), PHASE[st.phase] || st.phase.toUpperCase());
  setText(root.querySelector('.dh-berth'), `${st.target} · ${st.berth} · our ${st.port.size} ${st.port.face === 'x+' ? 'nose' : 'flank'} collar`);
  const docked = st.phase === 'docked';
  toggleClass(root, 'dh-docked', docked);
  show(root.querySelector('.dh-body'), !docked && st.phase !== 'holding');
  show(root.querySelector('.dh-keys'), manual());
  // readouts
  const col = st.collar;
  const ok = (v, lim) => v <= lim ? 'dh-ok' : v <= lim * 2 ? 'dh-warn' : 'dh-bad';
  const r = (k, v, cls = '') => `<div class="dh-r"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const approach = st.phase === 'approach';
  const rd = st.phase === 'outbound'
    ? r('TO THE GATE', fmtMeters(st.toGo))
      + r('SPEED', fmtSpeed(Math.hypot(state.dock.rel.vx, state.dock.rel.vy, state.dock.rel.vz)))
      + r('DRIVE', 'COLD')
      + r('RCS / FUEL', `${state.dock.fuel.toFixed(2)} kg`)
    : approach
    ? r('TO CORRIDOR', fmtMeters(st.toGo))
      + r('SPEED', fmtSpeed(Math.hypot(state.dock.rel.vx, state.dock.rel.vy, state.dock.rel.vz)))
      + r('DRIVE', `${(state.$dockThrust || 0).toFixed(2)} G`)
      + r('RCS / FUEL', `${state.dock.fuel.toFixed(2)} kg`)
    : r('RANGE', st.range < 10 ? `${st.range.toFixed(2)} m` : fmtMeters(st.range))
      + r('CLOSING', `${st.closing.toFixed(2)} m/s`, st.range < 30 ? ok(st.closing, col.captureMS) : '')
      + r('LATERAL', `${st.lateral.toFixed(2)} m`, st.range < 30 ? ok(st.lateral, col.missM) : '')
      + r('YAW · PITCH', `${st.yaw.toFixed(1)}° · ${st.pitch.toFixed(1)}°`, ok(Math.max(Math.abs(st.yaw), Math.abs(st.pitch)), col.angleDeg))
      + r('ROLL', `${st.roll.toFixed(1)}°`, ok(Math.abs(st.roll), col.rollDeg))
      + r('RCS USED', `${st.fuel.toFixed(3)} kg`)
      + (st.bumps ? r('CONTACTS', `${st.bumps}`, 'dh-bad') : '')
      + (st.timer != null ? r('TIME', `${st.timer} min`) : '');
  setHTML(root.querySelector('.dh-read'), rd);
  setHTML(root.querySelector('.dh-env'), docked || st.phase === 'outbound' ? '' : `<span>CAPTURE</span> ≤ ${col.captureMS} m/s · ≤ ${col.missM} m off axis · ≤ ${col.angleDeg}° · roll ≤ ${col.rollDeg}°`);
  setHTML(root.querySelector('.dh-ctl'), controls(state, st));
  if (!docked && st.phase !== 'holding') drawCamera(cam, state, st);
}

function controls(state, st) {
  const b = (act, label, cls = '', extra = '') => `<button class="dh-btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;
  if (st.phase === 'docked') {
    const cl = st.kind === 'station' ? clearanceFor(state, state.dock.target.id) : { depart: true };
    return `${st.kind === 'station' && !cl.depart ? b('depart', 'REQUEST DEPARTURE') : ''}${b('undock', 'UNDOCK', cl.depart ? 'dh-primary' : 'dh-warnbtn')}`;
  }
  if (st.phase === 'holding') {
    // (back in needs a docking clearance: the one we came in on was used)
    const cleared = st.kind !== 'station' || clearanceFor(state, state.dock.target.id).dock;
    return `${cleared ? b('redock', 'DOCK', 'dh-primary') : b('request', 'REQUEST DOCKING', 'dh-primary')}${b('release', 'CLEAR OFF')}`;
  }
  if (st.phase === 'capture' || st.phase === 'seal') return b('abort', 'ABORT');
  if (st.phase === 'undock') return '';
  if (st.phase === 'outbound') return `<span class="dh-group">${PROX_RATES.map((v, i) => b('rate', `×${v}`, (state.dock.rate ?? 3) === i ? 'active' : '', `data-i="${i}" title="${v} s a second"`)).join('')}</span>`;
  // (only what acts in this phase: the computer flies the final approach and the backing out; ABORT has
  // nothing to stop while backing out; KILL DRIFT is the hand-flying pilot's)
  const handFlyable = st.phase === 'prox' && !state.dock.backingOut;
  const mode = handFlyable ? `${b('auto', 'AUTO', st.mode === 'auto' ? 'active' : '')}${b('manual', 'MANUAL', st.mode === 'manual' ? 'active' : '')}` : '';
  const rate = PROX_RATES.map((v, i) => b('rate', `×${v}`, (state.dock.rate ?? 3) === i ? 'active' : '', `data-i="${i}" title="${v} s a second"`)).join('');
  return `${mode ? `<span class="dh-group">${mode}</span>` : ''}<span class="dh-group">${rate}</span>${handFlyable && st.mode === 'manual' ? b('kill', 'KILL DRIFT') : ''}${st.phase === 'separate' || state.dock.backingOut ? '' : b('abort', 'ABORT')}`;
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  const s = ui.state;
  if (!btn || !s?.dock) return;
  switch (btn.dataset.act) {
    case 'auto': setDockMode(s, 'auto'); logEntry('Docking computer has it', 'nav'); break;
    case 'manual': setDockMode(s, 'manual'); setProxRate(s, 1); logEntry('Hand-flying the docking', 'nav'); toast('MANUAL DOCKING — W/S A/D R/F, arrows, Q/E', 'nav'); break;
    case 'rate': setProxRate(s, +btn.dataset.i); break;
    case 'kill': killDrift(s); break;
    case 'abort': abortDocking(s, emit, 'the captain called it off'); break;
    case 'depart': { const r = requestDeparture(s, s.dock.target.id); toast(r.text, r.ok ? 'ok' : 'warn'); logEntry(r.text, 'comms'); break; }
    case 'undock': { const r = undock(s, emit); toast(r.text, r.ok ? 'nav' : 'warn'); break; }
    case 'redock': { const r = beginDocking(s, s.dock.target, { mode: s.dock.mode }, emit); toast(r.text, r.ok ? 'nav' : 'warn'); break; }
    case 'request': {
      const r = requestDocking(s, s.dock.target.id);
      toast(r.text, r.ok ? 'ok' : 'warn'); logEntry(r.text, 'comms');
      if (r.ok) { const d = beginDocking(s, s.dock.target, { mode: s.dock.mode }, emit); if (!d.ok) toast(d.text, 'warn'); }
      break;
    }
    case 'release': { const r = clearOff(s, emit); toast(r.text, r.ok ? 'nav' : 'warn'); break; }
  }
}

/**
 * The docking camera: we look out along our collar. The target collar's
 * rings grow as the range closes; where they sit off our crosshair is our
 * lateral error, the small diamond is where our drift takes us in five
 * seconds, and the horizon line rolls with the roll error.
 */
function drawCamera(canvas, state, st) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
  ctx.fillStyle = '#02060A';
  ctx.fillRect(0, 0, W, H);
  if (st.phase === 'approach' || st.phase === 'outbound') {
    ctx.fillStyle = 'rgba(110,234,224,0.7)';
    ctx.font = '11px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(st.phase === 'outbound' ? 'GATE AHEAD' : 'CORRIDOR AHEAD', cx, cy - 6);
    ctx.fillText(fmtMeters(st.toGo), cx, cy + 10);
    ctx.textAlign = 'left';
    return;
  }
  const col = st.collar;
  const range = Math.max(0.05, st.range);
  // perspective: a collar of diameter D at range r spans D / (r + D) of the frame
  const span = (m) => m / (range + col.diaM * 0.8) * W * 0.9;
  const lat = (m) => m / (range * 0.35 + 2) * W * 0.25;
  const tx = cx - lat(st.y) - st.yaw * 3, ty = cy + lat(st.z) + st.pitch * 3;
  // roll: the horizon through the target
  const roll = st.roll * Math.PI / 180;
  ctx.strokeStyle = 'rgba(79,209,197,0.25)';
  ctx.beginPath(); ctx.moveTo(tx - Math.cos(roll) * W, ty - Math.sin(roll) * W); ctx.lineTo(tx + Math.cos(roll) * W, ty + Math.sin(roll) * W); ctx.stroke();
  // the target collar: its rings and the latch marks
  const good = st.lateral <= col.missM && st.closing <= col.captureMS && Math.abs(st.roll) <= col.rollDeg && Math.abs(st.yaw) <= col.angleDeg && Math.abs(st.pitch) <= col.angleDeg;
  ctx.strokeStyle = good ? '#6BCB77' : '#E2A355';
  ctx.lineWidth = 2;
  for (const k of [1, 0.62]) { ctx.beginPath(); ctx.arc(tx, ty, Math.max(3, span(col.diaM / 2 * k)), 0, Math.PI * 2); ctx.stroke(); }
  for (let i = 0; i < 3; i++) {
    const a = roll + i * Math.PI * 2 / 3, r0 = Math.max(4, span(col.diaM / 2)), r1 = r0 * 1.25;
    ctx.beginPath(); ctx.moveTo(tx + Math.cos(a) * r0, ty + Math.sin(a) * r0); ctx.lineTo(tx + Math.cos(a) * r1, ty + Math.sin(a) * r1); ctx.stroke();
  }
  ctx.lineWidth = 1;
  // where the drift takes us in 5 s
  const px = cx + lat(st.vy * 5), py = cy - lat(st.vz * 5);
  ctx.strokeStyle = '#C084FC';
  ctx.beginPath(); ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py); ctx.closePath(); ctx.stroke();
  // our crosshair
  ctx.strokeStyle = '#6EEAE0';
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 14);
  ctx.stroke();
  // tapes: range (log) on the left, closing speed against the computer's on the right
  const tape = (x, frac, color) => { ctx.fillStyle = 'rgba(79,209,197,0.12)'; ctx.fillRect(x, 10, 6, H - 20); ctx.fillStyle = color; const h = Math.max(2, (H - 20) * Math.max(0, Math.min(1, frac))); ctx.fillRect(x, H - 10 - h, 6, h); };
  tape(6, Math.log10(range + 1) / 3, '#4FD1C5');
  const ideal = Math.min(3, Math.max(col.captureMS * 0.4, 0.02 * range));
  tape(W - 12, st.closing / Math.max(0.1, ideal * 2), st.closing > ideal * 1.5 ? '#E25555' : '#6BCB77');
  ctx.fillStyle = 'rgba(230,240,250,0.85)';
  ctx.fillRect(W - 15, H - 10 - (H - 20) * 0.5, 12, 1);
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.fillText(range < 10 ? `${range.toFixed(2)} m` : `${Math.round(range)} m`, 16, 18);
  ctx.textAlign = 'right';
  ctx.fillText(`${st.closing.toFixed(2)} m/s`, W - 16, 18);
  ctx.textAlign = 'left';
}
