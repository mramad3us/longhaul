// ============================================================
// LONGHAUL — The exterior view: what is outside, at true scale
//
// Close to other things (docking, alongside another ship, and in time a
// world's atmosphere) the ship's surroundings are drawn as they are, in
// metres: the rock a port is built on, the station's structure and its
// berths with the ships lying in them, other hulls nearby, and our own
// hull, posed as the sim has it (mated at a collar, or flying). The
// camera frames what matters and follows it smoothly; near a station
// the view is turned so the station's up is up (the ground below).
//
// Overlays for docking: the corridor down the berth's axis with its
// marks, the berth's collar, ours. The renderer reads sim state and
// never changes it; a click picks a hull (onSelect), as on the tactical
// display.
//
// The sim moves in whole minutes; the view doesn't. Everything is drawn
// at the moment between minutes the frame stands for (`alpha`), where the
// sim itself would put it (world.predictEntity): rails things (stations,
// berths, berthed hulls, the rock) and traffic on its transit exactly;
// things in free flight flown on, under their thrust and the pull. Our own
// ship the same way, or, holding station on something, at its place off
// that thing: so a ship we hold formation with stays put on the screen
// even under thrust (carried on velocity alone, a ship burning at half a
// G drifts nine kilometres off its place in a minute, and snaps back).
// Near a station the view's rotation is locked to the station's own, so
// the ground doesn't swing.
//
// The camera frames what matters and keeps to it: it stays on the thing it
// is framing until something else comes much closer; it eases there over a
// quarter of a second, and its zoom over most of a second (by the clock, not
// the frame rate), so small changes don't make it breathe. Kilometres from a
// berth (the final approach, the climb out) it frames us and marks the
// station at the screen's edge.
// ============================================================

import { AU_M, DAY_MIN } from '../core/constants.js';
import { getWorld, predictEntity, stepFree } from '../sim/world.js';
import { targetStateAt } from '../sim/nav.js';
import { holdOffset } from '../sim/autopilot.js';
import { getBody, bodyPos } from '../sim/ephemeris.js';
import { hullOf } from '../sim/hulls.js';
import { stationModel, berthOf, stationAngle, berthFrame } from '../sim/stations.js';
import { matePose } from '../sim/mating.js';
import { collarFrame, dockPose, facingOf } from '../sim/docking.js';
import { liveKnowledge } from '../sim/intel.js';
import { factionColor } from '../sim/factions.js';
import { PLAYER_CLASS } from '../sim/ship-classes.js';
import { FitCanvas } from './dom.js';
import { drawHull, drawStation } from './hull-art.js';

const _q = [];
const IN_FRAME_PHASES = new Set(['approach', 'prox', 'separate', 'outbound']);
const LOOK_M = 12_000;           // objects this close are candidates for the view
const CAM_TAU_S = 0.25;          // the camera eases toward its framing over this (s)
const ZOOM_TAU_S = 0.8;          // …and its zoom more slowly, so small changes don't make it breathe
const LOCK_EASE_S = 0.8;         // a station come into view: the turn to its up eased over this, then locked
const FAR_FRAME_M = 8_000;       // docking further than this from the berth: we are framed, the station marked
const FAR_SPAN_M = 3_000;
const FOCUS_SWITCH = 0.7;        // another thing takes the frame when it is this much closer than the one framed

export class ExteriorView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'exterior-canvas' });
    this.cam = { x: 0, y: 0, scale: 0.2, rot: 0, ready: false };
    this.t0 = performance.now();
    this._hits = [];
    this.stars = Array.from({ length: 140 }, (_, i) => ({ x: (i * 7919 % 1000) / 1000, y: (i * 104729 % 1000) / 1000, b: 0.2 + (i * 31 % 10) / 14 }));
    if (onSelect) {
      // (a hull clicked is selected; the click goes no further: in the inset it would swap the views too)
      container.addEventListener('click', (e) => { const id = this.hit(container, e); if (id) { e.stopPropagation(); onSelect(id); } });
      container.addEventListener('pointermove', (e) => { container.style.cursor = this.hit(container, e) ? 'pointer' : 'default'; });
    }
  }

  /** A new game, a load: nothing carried over from the last one. */
  reset() {
    this.cam = { x: 0, y: 0, scale: 0.2, rot: 0, ready: false };
    this._sm = null;
    this.focus = null;
  }

  hit(container, e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 24 * 24;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
    return best ? best.id : null;
  }

  /**
   * Our drawn place, against the nearest station: where the sim moves us
   * by a whole minute's worth at once (the first minute of a docking phase
   * is flown inside the minute tick), the step is spread over a third of a
   * second instead of shown as a jump. A step that agrees with how we were
   * moving isn't one; a jump of kilometres (a new game, a long warp) is
   * shown as it is. Shifts `us` and the objects' offsets in place.
   */
  smooth(objects, tm, us) {
    const st = objects.find(o => o.e.type === 'station');
    const sm = this._sm ||= { id: null, tm: 0, x: 0, y: 0, vx: 0, vy: 0, ex: 0, ey: 0, wall: performance.now() };
    const now = performance.now(), wall = Math.min(0.25, (now - sm.wall) / 1000);
    sm.wall = now;
    if (!st || st.e.id !== sm.id) { Object.assign(sm, { id: st?.e.id ?? null, tm, x: st ? -st.dx : 0, y: st ? -st.dy : 0, vx: 0, vy: 0, ex: 0, ey: 0 }); return; }
    const x = -st.dx, y = -st.dy, dS = (tm - sm.tm) * 60;      // us from the station (m); sim seconds since the last frame
    if (dS > 0) {
      const px = sm.x + sm.vx * dS, py = sm.y + sm.vy * dS;
      const jx = x - px, jy = y - py, j = Math.hypot(jx, jy);
      if (j > Math.max(2, 4 * Math.hypot(sm.vx, sm.vy) * dS) && j < 20_000) { sm.ex -= jx; sm.ey -= jy; }
      else { sm.vx = (x - sm.x) / dS; sm.vy = (y - sm.y) / dS; }
      sm.x = x; sm.y = y; sm.tm = tm;
    } else if (dS < 0) Object.assign(sm, { tm, x, y, ex: 0, ey: 0 });
    const k = Math.exp(-wall / 0.12);
    sm.ex *= k; sm.ey *= k;
    if (Math.hypot(sm.ex, sm.ey) < 0.05) { sm.ex = sm.ey = 0; return; }
    us.x += sm.ex / AU_M; us.y += sm.ey / AU_M;
    for (const o of objects) { o.dx -= sm.ex; o.dy -= sm.ey; o.d = Math.hypot(o.dx, o.dy); }
  }

  /** What to look at: the dock's berth and us, or us and the nearest thing close by. */
  frame(state, objects, tm, us) {
    const st = objects.find(o => o.e.type === 'station');
    const d = state.dock;
    let cx = 0, cy = 0, span = 400, rot = 0;
    if (d && (d.phase !== 'inbound' && d.phase !== 'awaiting')) {
      const fr = collarFrame(state, d, tm);
      if (fr) {
        const bx = (fr.pos.x - us.x) * AU_M, by = (fr.pos.y - us.y) * AU_M;
        const ourL = hullOf(state.ship.classId || PLAYER_CLASS).L;
        const r = Math.hypot(bx, by);
        cx = bx / 2; cy = by / 2;
        span = Math.max(ourL * 3, r * 1.4 + ourL * 2);
        // kilometres off (the final approach from the gate, the climb out to it): us, at a scale that
        // shows a hull, and the station off the edge of the screen (drawn as a marker: edgeMarker)
        if (r > FAR_FRAME_M) { cx = 0; cy = 0; span = FAR_SPAN_M; }
        if (d.phase === 'docked' || d.phase === 'capture' || d.phase === 'seal') span = Math.max(ourL * 5, 260);
        rot = Math.atan2(fr.normal.y, fr.normal.x) - Math.PI / 2;
      }
    } else if (objects.length) {
      // the nearest thing, but the one framed keeps the frame until another is much closer
      let n = objects.reduce((a, b) => (a.d < b.d ? a : b));
      const kept = this.focus && objects.find(o => o.e.id === this.focus);
      if (kept && n !== kept && n.d > kept.d * FOCUS_SWITCH) n = kept;
      this.focus = n.e.id;
      cx = n.dx / 2; cy = n.dy / 2;
      span = Math.max(300, n.d * 1.5 + (n.size || 100));
    }
    if (st) {
      // the station's up is the screen's up: the rock (if any) below
      const o = st.e.orbit;
      rot = stationAngle(o, tm) - Math.PI / 2;
    }
    return { cx, cy, span, rot };
  }

  render(state, alpha, opts = {}) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const t = (performance.now() - this.t0) / 1000;
    const f = state.flight;
    const world = getWorld(state);
    // The moment this frame stands for, between two sim minutes
    const a = Math.max(0, Math.min(1, alpha ?? 1));
    const tm = state.clock.minute + a, dtS = a * 60;
    const d = state.dock;
    const held = d && d.phase !== 'inbound' && d.phase !== 'awaiting';
    // Held by a dock, our place is rel in the collar's frame; in the frame
    // phases rel has been flown to dock.t seconds into the minute, and the
    // rest is carried on its rates (a minute flown whole leaves dock.t at 0)
    let ourPose = null;
    if (held) {
      const lead = d.rel && IN_FRAME_PHASES.has(d.phase) ? Math.max(0, dtS - (d.t || 0)) : 0;
      const dd = lead ? { ...d, rel: { ...d.rel, x: d.rel.x + (d.rel.vx || 0) * lead, y: d.rel.y + (d.rel.vy || 0) * lead, yaw: (d.rel.yaw || 0) + (d.rel.wy || 0) * lead } } : d;
      ourPose = dockPose(state, dd, collarFrame(state, d, tm));
    }
    const us = ourPose ? ourPose.pos : ourPlace(state, tm, dtS);
    /** Where an entity is at tm: where the sim would put it (rails and transits exactly, free flight flown on). */
    const at = (e) => predictEntity(e, tm, world).pos;

    // Who is close
    _q.length = 0;
    world.query(f.pos, LOOK_M / AU_M, _q);
    const objects = [];
    for (const e of _q) {
      if (e.type === 'nav' || e.type === 'ordnance') continue;
      if (!liveKnowledge(state, e) && e.type !== 'station') continue;
      const ep = at(e);
      const dx = (ep.x - us.x) * AU_M, dy = (ep.y - us.y) * AU_M;
      const d = Math.hypot(dx, dy);
      if (d > LOOK_M) continue;
      const size = e.type === 'station' ? stationModel(e.id)?.sizeM || 1000 : hullOf(e.cls)?.L || 50;
      objects.push({ e, dx, dy, d, size });
    }
    // the station a dock holds us to is always in the picture, however far (its rock, the frame's turn)
    if (held && d.target.kind === 'station' && !objects.some(o => o.e.id === d.target.id)) {
      const e = world.get(d.target.id);
      if (e) { const ep = at(e); const dx = (ep.x - us.x) * AU_M, dy = (ep.y - us.y) * AU_M; objects.push({ e, dx, dy, d: Math.hypot(dx, dy), size: stationModel(e.id)?.sizeM || 1000 }); }
    }
    this.smooth(objects, tm, us);
    const want = this.frame(state, objects, tm, us);
    const cam = this.cam;
    const wallNow = performance.now(), wall = Math.min(0.25, (wallNow - (cam.wall ?? wallNow)) / 1000);
    cam.wall = wallNow;
    // the span followed slowly (a log-space low-pass): small changes don't make it breathe, a climb or an
    // approach zooms smoothly rather than in steps
    if (!cam.ready || opts.snap || !cam.span) cam.span = want.span;
    else cam.span *= Math.pow(want.span / cam.span, 1 - Math.exp(-wall / ZOOM_TAU_S));
    const scaleWant = Math.min(W, H) / cam.span;
    if (!cam.ready || opts.snap) { Object.assign(cam, { x: want.cx, y: want.cy, scale: scaleWant, rot: want.rot, ready: true }); }
    else {
      const k = 1 - Math.exp(-wall / CAM_TAU_S);
      cam.x += (want.cx - cam.x) * k; cam.y += (want.cy - cam.y) * k;
      cam.scale *= Math.pow(scaleWant / cam.scale, k);
      // near a station the rotation is the station's own, exactly (easing it would make the ground swing),
      // once the view has turned to it: a station come into the picture is eased into, not snapped to
      const stNow = objects.find(o => o.e.type === 'station');
      if (stNow && cam.lockId !== stNow.e.id) { cam.lockId = stNow.e.id; cam.lockEase = LOCK_EASE_S; }
      if (!stNow) cam.lockId = null;
      cam.lockEase = Math.max(0, (cam.lockEase || 0) - wall);
      if (stNow && cam.lockEase <= 0) cam.rot = want.rot;
      else { let dr = want.rot - cam.rot; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); cam.rot += dr * (stNow ? 1 - Math.exp(-wall / 0.2) : k); }
    }
    const sc = cam.scale;
    const cr = Math.cos(-cam.rot), sr = Math.sin(-cam.rot);
    // our-ship-relative metres → screen
    const toS = (mx, my) => { const x = mx - cam.x, y = my - cam.y; return [W / 2 + (x * cr - y * sr) * sc, H / 2 - (x * sr + y * cr) * sc]; };
    const screenAngle = (a) => a - cam.rot;

    // Space
    ctx.fillStyle = '#03060B';
    ctx.fillRect(0, 0, W, H);
    for (const s of this.stars) { ctx.fillStyle = `rgba(200,215,235,${s.b * 0.5})`; ctx.fillRect(s.x * W, s.y * H, 1, 1); }

    // A rock under a surface port
    const st = objects.find(o => o.e.type === 'station');
    if (st) drawBody(ctx, st.e, us, tm, toS, sc, W, H);

    const hits = this._hits;
    hits.length = 0;
    // Stations
    for (const o of objects) {
      if (o.e.type !== 'station') continue;
      const m = stationModel(o.e.id);
      const [sx, sy] = toS(o.dx, o.dy);
      const occ = new Set(Object.keys(o.e.berths || {}));
      drawStation(ctx, m, { x: sx, y: sy, angle: screenAngle(stationAngle(o.e.orbit, tm)), scale: sc, t, tint: factionColor(o.e.faction), occupied: occ, highlight: state.dock?.target.id === o.e.id ? state.dock.berth : null, labels: sc > 0.04 });
      hits.push({ id: o.e.id, x: sx, y: sy });
      if (sc * m.sizeM < 2000) label(ctx, o.e.name, sx, sy + 14, factionColor(o.e.faction));
    }
    // Other ships: in a berth (posed by the berth), or flying
    for (const o of objects) {
      const e = o.e;
      if (e.type !== 'ship') continue;
      const hull = hullOf(e.cls);
      if (!hull) continue;
      let pose = null;
      if (e.tags?.berth && e.tags.at) {
        const host = world.get(e.tags.at);
        const b = host && berthOf(host.id, e.tags.berth);
        const port = b && hull.ports.find(p => b.accepts.includes(p.size));
        if (b && port) {
          const fr = berthFrame(state, host, b, tm);
          const mp = matePose(fr, port);
          pose = { mx: (mp.center.x - us.x) * AU_M, my: (mp.center.y - us.y) * AU_M, facing: mp.facing, view: mp.view };
        }
      }
      if (!pose) pose = { mx: o.dx, my: o.dy, facing: facingOf(e), view: 'top' };
      const [sx, sy] = toS(pose.mx, pose.my);
      drawHull(ctx, hull, { x: sx, y: sy, facing: screenAngle(pose.facing), scale: sc, view: pose.view, tint: factionColor(e.faction), plume: e.thrust || 0, t, ports: true });
      // (kilometres out a hull is a few pixels: a mark in its colour, as ours has)
      if (hull.L * sc < 8) { ctx.fillStyle = factionColor(e.faction); ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3); }
      hits.push({ id: e.id, x: sx, y: sy });
      if (hull.L * sc > 6 && opts.labels !== false) label(ctx, e.transponder ? e.name : 'unidentified', sx, sy - Math.max(10, hull.W * sc), factionColor(e.faction));
    }

    // Docking overlays: the corridor and the two collars
    if (held) {
      const fr = collarFrame(state, d, tm);
      if (fr) {
        const bx = (fr.pos.x - us.x) * AU_M, by = (fr.pos.y - us.y) * AU_M;
        const [ax, ay] = toS(bx, by);
        const len = d.target.kind === 'ship' ? 300 : 1000;
        const [ex, ey] = toS(bx + fr.normal.x * len, by + fr.normal.y * len);
        ctx.strokeStyle = 'rgba(110,234,224,0.35)';
        ctx.setLineDash([4, 6]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.setLineDash([]);
        for (const mark of [10, 100, 500]) {
          if (mark > len) continue;
          const [mx, my] = toS(bx + fr.normal.x * mark, by + fr.normal.y * mark);
          ctx.fillStyle = 'rgba(110,234,224,0.6)';
          ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
          if (sc * mark > 30) { ctx.font = '9px "IBM Plex Mono", monospace'; ctx.fillText(`${mark} m`, mx + 5, my); }
        }
        ctx.strokeStyle = '#3EC7E6'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ax, ay, Math.max(4, 2 * sc), 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
    }

    // The station we are docking with, off the edge of the screen while we are framed far from it
    // (the final approach, the climb out): where it lies, and how far
    if (held && d.target.kind === 'station' && (d.phase === 'approach' || d.phase === 'outbound')) {
      const o = objects.find(x => x.e.id === d.target.id);
      if (o && o.d > FAR_FRAME_M) {
        const [sx, sy] = toS(o.dx, o.dy);
        if (sx < 0 || sx > W || sy < 0 || sy > H) edgeMarker(ctx, sx, sy, W, H, `${o.e.name} · ${fmtKm(o.d)}`, factionColor(o.e.faction));
      }
    }

    // Our hull
    const ours = hullOf(state.ship.classId || PLAYER_CLASS);
    const mine = ourPose ? { mx: 0, my: 0, facing: ourPose.facing, view: ourPose.view } : { mx: 0, my: 0, facing: f.facing, view: 'top' };
    const [ox, oy] = toS(mine.mx, mine.my);
    drawHull(ctx, ours, { x: ox, y: oy, facing: screenAngle(mine.facing), scale: sc, view: mine.view, tint: '#5FD38D', plume: d?.phase === 'approach' ? state.$dockThrust || 0 : f.thrustG, rcs: Math.min(1, (d && IN_FRAME_PHASES.has(d.phase) ? state.$dockRcs || 0 : 0) * 30 + (Math.abs(f.turning) > 0.01 ? 0.5 : 0)), t, ports: d?.port || true });
    if (ours.L * sc < 8) { ctx.fillStyle = '#5FD38D'; ctx.fillRect(ox - 2, oy - 2, 4, 4); }

    // Scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
    const want80 = 80 / sc;
    const bar = nice.find(n => n >= want80) || nice[nice.length - 1];
    ctx.strokeStyle = 'rgba(148,163,178,0.9)'; ctx.fillStyle = 'rgba(148,163,178,0.95)';
    ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + bar * sc, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + bar * sc, H - 20); ctx.lineTo(14 + bar * sc, H - 12); ctx.stroke();
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 18 + bar * sc, H - 12);
    if (!objects.length && !d) { ctx.fillStyle = 'rgba(122,142,162,0.6)'; ctx.fillText('Nothing within 12 km', 14, 20); }
  }
}


/**
 * Our place at tm (between the minute the sim has flown and the next):
 * holding station, at the hold's place off what we hold on (so the two
 * never drift apart on the screen); flying, flown on under the drive's
 * last thrust and the pull, as the sim flies everything else.
 */
const _op = { x: 0, y: 0 }, _ov = { vx: 0, vy: 0 };
function ourPlace(state, tm, dtS) {
  const f = state.flight;
  if (f.hold) {
    const t = targetStateAt(state, f.hold, tm);
    const o = t && holdOffset(state, f.hold, tm);
    if (t) return { x: t.pos.x + o.x / AU_M, y: t.pos.y + o.y / AU_M };
  }
  _op.x = f.pos.x; _op.y = f.pos.y; _ov.vx = f.vel.vx; _ov.vy = f.vel.vy;
  if (dtS > 0) stepFree(_op, _ov, dtS, f.thrustG || 0, f.facing || 0, state.clock.minute);
  return { x: _op.x, y: _op.y };
}

/** An arrow at the screen's edge toward something off it (sx, sy: where it would be drawn), and a label. */
function edgeMarker(ctx, sx, sy, W, H, text, color) {
  const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy;
  const m = 18, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-9), (H / 2 - m) / Math.abs(dy || 1e-9));
  const x = cx + dx * k, y = cy + dy * k, a = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = color; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillStyle = color;
  const tw = ctx.measureText(text).width;
  const lx = Math.max(6, Math.min(W - tw - 6, x - tw / 2 - Math.cos(a) * (tw / 2 + 14)));
  const ly = Math.max(14, Math.min(H - 30, y - Math.sin(a) * 16 + 4));     // (clear of the scale bar)
  ctx.fillText(text, lx, ly);
}

const fmtKm = (m) => m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

function label(ctx, text, x, y, color) {
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.textAlign = 'center';
  ctx.fillText(text.length > 26 ? text.slice(0, 25) + '…' : text, x, y);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

/**
 * The body a surface port stands on, drawn at its true radius: from a
 * kilometre up, Ceres is a horizon, not a ball. Only the arc across the
 * screen is drawn (a polygon), so the numbers stay sane.
 */
function drawBody(ctx, st, us, tm, toS, sc, W, H) {
  if (st.orbit?.r * AU_M > (getBody(st.orbit.body)?.radius || 0) * 1000 * 1.05) return;   // an orbital station: no ground close by
  const b = getBody(st.orbit.body);
  if (!b) return;
  const c = bodyPos(b, tm / DAY_MIN);
  const cx = (c.x - us.x) * AU_M, cy = (c.y - us.y) * AU_M;
  const R = b.radius * 1000;
  // the arc of the surface nearest us, ± what the screen spans
  const toUs = Math.atan2(-cy, -cx);
  const spanM = Math.max(W, H) / sc * 1.5;
  const half = Math.min(Math.PI, spanM / R);
  const pts = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const a = toUs - half + 2 * half * i / N;
    pts.push(toS(cx + R * Math.cos(a), cy + R * Math.sin(a)));
  }
  // close the shape deep below the surface
  const deep = Math.max(0.2 * R, R - spanM);          // (a small rock wider than the screen: the whole disc)
  pts.push(toS(cx + deep * Math.cos(toUs + half), cy + deep * Math.sin(toUs + half)));
  pts.push(toS(cx + deep * Math.cos(toUs - half), cy + deep * Math.sin(toUs - half)));
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#2A2723');
  grad.addColorStop(1, '#141210');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,150,130,0.4)';
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const p = pts[i]; if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
  ctx.stroke();
}

