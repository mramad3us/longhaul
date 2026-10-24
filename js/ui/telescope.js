// ============================================================
// LONGHAUL — The telescope's picture
//
// What our telescope (sim/telescope.js) shows of what it holds, a contact
// or a world, as its camera would: from where we are, along the line of
// sight, the plane's up as up. The physics decides everything drawn:
//
//   a hull many resolution elements long is its shape: the solid (on the
//   GPU, gl/ships3d.js) seen along our line of sight, rolled as its crew
//   left it, lit by the Sun at its true phase (or its night side, nearly
//   black but for its lit limb), blurred to what the camera resolves; a
//   few elements, a smudge; under one, a point of light as bright as its
//   magnitude against what the frame reaches
//   a lit drive is a star at the stern, the mirror's diffraction spikes on
//   it; the hull is lost in its glare unless the plume filter takes the
//   drive's lines out (FILTER on the bar: PLUME, DEEP), and looking aft
//   through our own exhaust the frame is blind without one, degraded with
//   one (washed, blurred, shimmering)
//   a world is a sphere at its phase, its surface turning (scope-sky.js);
//   the Sun is seen through the solar filter the mount puts in by itself,
//   and near the boresight its scattered light washes the frame; a world
//   between us and a ship hides it
//   a fight is what it would look like (scope-fx.js): flashes that white
//   out the sensor, fireballs kilometres across, fragments and venting air,
//   PDC tracers reaching for a torpedo, a hull raked by guns (the hits on
//   the faces we see of the solid, where it projects them)
//   behind, the stars, as many as the exposure picks up, drifting as the
//   mount tracks, streaking as it slews; the sensor's noise rising as the
//   camera reaches for faint things
//
// The mount slews to a new target (fast, eased: the stars streak), then
// holds it exactly. The frame takes in the whole of what it holds, a hull
// or a world: zooming out as far as a close ship takes, or in, past the
// optics' narrowest field digitally (to DIGITAL resolution elements across:
// a far hull blurred, as it is); anything smaller is shown in the narrowest
// field, a point in a great deal of black. When the
// target goes (blown apart), the mount holds where it was going (its
// debris keeps its velocity) and the frame holds still, so what happened
// is seen out (stage.js waits for it). The readouts say what the camera is
// doing (slewing, tracking, holding, the exposure, the filters, how old
// the light is) and why the picture looks as it does.
// ============================================================

import { AU_M } from '../core/constants.js';
import { bus } from '../core/events.js';
import { getWorld, predictEntity } from '../sim/world.js';
import {
  scopeOf, lockOn, sightOf, ownPlume, cameraRes, bodySight, bodiesInField, occulter, sunOffAxis,
  NATIVE_FIELD, WIDE_FIELD_RAD, FILTERS, FILTER_ORDER, SUN_GLARE_RAD,
} from '../sim/telescope.js';
import { getBody } from '../sim/ephemeris.js';
import { launchedBy } from '../sim/ordnance.js';
import { PLAYER } from '../sim/combatants.js';
import { isIdentified, isDark } from '../sim/sensors.js';
import { hullOf } from '../sim/hulls.js';
import { stationModel, stationAngle } from '../sim/stations.js';
import { facingOf } from '../sim/docking.js';
import { factionColor } from '../sim/factions.js';
import { FitCanvas, fmtKm } from './dom.js';
import { drawHull, drawStation } from './hull-art.js';
import { ourPlace } from './exterior.js';
import { relativeTo } from './hud.js';
import { fxList } from './fx.js';
import { frameMarks, marksOf, markWords } from './marks.js';
import { ScopeFx } from './scope-fx.js';
import { SkyPainter, drawStars, hash } from './scope-sky.js';
import { has3D, renderScene, orthoCamera, hullMatrix, stationMatrix } from './gl/ships3d.js';

const C_MS = 299_792_458;
const NIGHT = 2.3;               // rad of phase: past this we see the night side
const FRAME_AT = 12;             // resolution elements: a hull this long is framed; smaller, the narrowest field
const DIGITAL = 24;              // closer than the optics' narrowest field, digitally, to this many resolution elements across
const FILL = 0.55;               // a framed hull fills this share of the frame (its length or its height)
const FILL_WORLD = 0.62;
const ZOOM_TAU_S = 0.6;
const SLEW_RATE = 1.4;           // rad/s, after the start; a slew takes 0.35–1.6 s
const LINGER_MS = 7000;          // a target blown apart: the frame holds this long on where it was
const SOLAR_ND = 12.5;           // the solar filter, in magnitudes
const Z_SPREAD = 0.2;            // ships in the field sit off the plane by up to this share of their distance from the target (to 20 km)
const FONT = '10px "IBM Plex Mono", monospace';
const DIM = 'rgba(122,142,162,0.9)', TEXT = 'rgba(190,205,220,0.95)', CYAN = 'rgba(62,199,230,0.75)', WARN = 'rgba(240,169,58,0.98)', SUNC = 'rgba(255,196,110,0.95)';
const KIND_WORD = { star: 'STAR', planet: 'PLANET', moon: 'MOON', asteroid: 'ASTEROID' };

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const idHash = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return hash(h, 7); };
const smooth = (t) => t * t * (3 - 2 * t);

export class ScopeView {
  constructor(container) {
    this.fc = new FitCanvas(container, { className: 'scope-canvas' });
    this.off = document.createElement('canvas');
    this.noise = makeNoise();
    this.t0 = performance.now();
    this.fx = new ScopeFx();
    this.sky = new SkyPainter();
    this.destroyed = new Map();      // id → { how, at }: what the board saw go
    this.filter = 'off';
    this.hint = null;                // 'plume' | 'aft': the bar's FILTER is worth a press
    bus.on('ship-destroyed', (p) => this.destroyed.set(p.id, { how: p.how, at: performance.now() }));
    this.reset();
  }

  /** A new game: the mount starts over. */
  reset() {
    this.fov = null;
    this.aim = null;
    this.slew = null;
    this.key = null;
    this.track = null;
    this.held = null;
    this.lastPose = null;
    this.burst = null;
    this.poses = new Map();
    this.fx.clear();
  }

  /** The filter in: 'off' | 'plume' | 'deep'; FILTER on the bar steps through them. */
  cycleFilter() { this.filter = FILTER_ORDER[(FILTER_ORDER.indexOf(this.filter) + 1) % FILTER_ORDER.length]; return this.filter; }

  /** Until when (wall ms) the picture is worth watching though its target is gone: effects, a destroyed hull held. */
  busyUntil() { return Math.max(this.fx.until, this.held ? this.held.at + LINGER_MS : 0); }

  /** target: { kind: 'entity' | 'body', id } or null. */
  render(state, alpha, target) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const now = performance.now(), t = (now - this.t0) / 1000;
    const wall = Math.min(0.25, (now - (this.wall ?? now)) / 1000);
    this.wall = now;
    const key = target ? `${target.kind}:${target.id}` : null;
    const fresh = key !== this.key;
    if (fresh) { this.key = key; this.track = null; this.held = null; this.lastPose = null; }
    const world = getWorld(state);
    const a = clamp(alpha ?? 1, 0, 1);
    const tm = state.clock.minute + a;
    this.tm = tm;
    const sc = scopeOf(state);
    const filter = FILTERS[this.filter] || FILTERS.off;
    const lock = target ? lockOn(state, target, sc) : null;
    const us = ourPlace(state, tm, a * 60);
    this.poses.clear();
    this.hint = null;

    // ---- What we hold, and where it is (where its light left it)
    let e = null, sight = null, tpos = null, wv = null, want = null, lost = null;
    if (target?.kind === 'entity') {
      e = world.get(target.id);
      if (lock.ok && e) {
        tpos = predictEntity(e, tm - lock.distM / C_MS / 60, world).pos;
        sight = sightOf(state, e, tpos, us, sc, filter);
        want = sight.bearing;
        this.track = { pos: { ...tpos }, vel: { vx: e.vel.vx, vy: e.vel.vy }, tm };
        this.held = null;
      } else if (this.track && (!e || lock.why === 'track')) {
        // gone: the mount holds where it was going (what is left of it keeps its velocity)
        const dtS = (tm - this.track.tm) * 60;
        const p = { x: this.track.pos.x + this.track.vel.vx * dtS / AU_M, y: this.track.pos.y + this.track.vel.vy * dtS / AU_M };
        want = Math.atan2(p.y - us.y, p.x - us.x);
        if (!this.held) this.held = { at: now, how: this.destroyed.get(target.id)?.how || (e ? 'lost' : null) };
        lost = { how: this.held.how, distM: Math.hypot(p.x - us.x, p.y - us.y) * AU_M };
      } else if (e && lock.why === 'range') want = Math.atan2(e.pos.y - us.y, e.pos.x - us.x);
    } else if (target?.kind === 'body') {
      const b = getBody(target.id);
      if (b) { wv = bodySight(b, tm, us, sc); want = wv.bearing; }
    }

    // ---- The mount: a slew to a new target, eased, then the target held exactly
    let streak = 0;
    if (want != null) {
      if (fresh && this.aim != null) {
        const d0 = angDiff(want, this.aim);
        if (Math.abs(d0) > 1e-7) this.slew = { t0: now, d0, dur: clamp(0.35 + Math.abs(d0) / SLEW_RATE, 0.35, 1.6) };
      }
      let aim = want;
      if (this.slew) {
        const k = clamp((now - this.slew.t0) / (this.slew.dur * 1000), 0, 1);
        aim = want - this.slew.d0 * (1 - smooth(k));
        if (k >= 1) this.slew = null;
      }
      if (this.aim != null && this.slew) streak = Math.abs(angDiff(aim, this.aim));
      this.aim = aim;
    }
    const bearing = this.aim;

    // ---- The field: the whole of what we hold, or the narrowest field
    const narrow = NATIVE_FIELD * sc.resRad;
    let wantFov = narrow;
    if (sight && sight.elements >= FRAME_AT && (sight.regime !== 'plume' || sight.elements >= 6)) {
      const angH = heightOf(e) / sight.distM;
      wantFov = clamp(Math.max(sight.angRad, angH * W / H) / FILL, DIGITAL * sc.resRad, WIDE_FIELD_RAD);
    } else if (wv && wv.angRad / sc.resRad >= 4) {
      const ext = getBody(target.id)?.rings ? 2.35 : 1.1;
      wantFov = clamp(Math.max(wv.angRad * ext, wv.angRad * (W / H)) / FILL_WORLD, DIGITAL * sc.resRad, WIDE_FIELD_RAD);
    } else if (this.held && this.fov) wantFov = this.fov;                // (gone: the frame holds still)
    // a burst near what we hold: pulled back to take in its fireball while it lasts
    if (this.burst && now < this.burst.until) wantFov = Math.max(wantFov, Math.min(WIDE_FIELD_RAD, this.burst.fov));
    else this.burst = null;
    // (eased; pulling back for a burst, quickly: the fireball grows fast)
    this.fov = !this.fov ? wantFov : this.fov * Math.pow(wantFov / this.fov, 1 - Math.exp(-wall / (this.burst && wantFov > this.fov ? 0.2 : ZOOM_TAU_S)));
    const fov = this.fov, ppr = W / fov;
    streak *= ppr;
    const camRes = cameraRes(sc, fov);
    // (through our own exhaust, with a filter: what gets through is blurred and shimmers)
    const own = bearing != null ? ownPlume(state, bearing, filter) : null;
    const blurK = own?.see ? own.blur : 1;
    const psfPx = Math.max(0.7, 0.5 * camRes * ppr * blurK);
    const asSeen = (v) => ({ ...v, resRad: camRes * blurK, resM: camRes * blurK * v.distM, elements: v.angRad / (camRes * blurK) });
    if (sight) sight = asSeen(sight);

    // ---- The worlds in the field; is the target behind one?
    const worlds = bearing != null ? bodiesInField(tm, us, bearing, fov) : [];
    const hider = sight ? occulter(tm, us, sight.bearing, sight.distM) : null;
    const sunOff = bearing != null ? sunOffAxis(us, bearing) : Math.PI;
    // (the Sun behind a nearer world that covers it is not in the field: no filter wanted, no glare)
    const sunV = worlds.find(v => v.sun);
    const sunHidden = !!sunV && !!occulter(tm, us, sunV.bearing, sunV.distM);
    const sunInField = !!sunV && !sunHidden && Math.abs(angDiff(sunV.bearing, bearing)) < fov / 2 + sunV.radRad;

    // ---- The exposure: everything to the limit, unless something bright sets it
    let mShow = sc.magLimit;
    if (sight && !hider) {
      if (sight.regime === 'resolved' && sight.phase < 2.6) mShow = sc.magLimit - 10;      // a sunlit hull: a short exposure, no stars
      const brightest = Math.min(sight.hullMag, sight.plumeMag);
      if (brightest < mShow - 9) mShow = brightest + 9;
    }
    for (const v of worlds) {
      if (v.sun && !sunInField) continue;
      const m = v.sun ? v.mag + SOLAR_ND : v.mag;
      if (v.radRad * ppr > 2 && !v.sun) mShow = Math.min(mShow, sc.magLimit - 10);
      if (m < mShow - 9) mShow = m + 9;
    }
    const gain = clamp((mShow - (sc.magLimit - 10)) / 10, 0, 1) + (filter.id === 'deep' ? 0.25 : filter.id === 'plume' ? 0.1 : 0);
    const expS = clamp(1 / 30 * Math.pow(10, (mShow - sc.magLimit) / 2.5), 1e-6, 1 / 30);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!sc.working) { this.hud(ctx, W, H, state, { sc, msg: 'SENSORS DARK · no power to the telescope', warn: true, mode: 'DARK' }); return; }
    if (bearing == null) {
      this.grain(ctx, W, H, 0.6);
      this.hud(ctx, W, H, state, { sc, mode: 'IDLE', msg: !target ? 'NO TARGET · pick a contact or a world and LOOK (Z), or LOOK AT PICK' : `NO TRACK · ${lock?.text || 'nothing to point at'}`, warn: !!target });
      return;
    }

    // (shimmering through our own exhaust)
    ctx.save();
    if (own?.see) ctx.translate((Math.random() - 0.5) * 2.4 * own.wash, (Math.random() - 0.5) * 2.4 * own.wash);

    // ---- The sky
    drawStars(ctx, W, H, bearing, fov, ppr, mShow - filter.hull, psfPx, streak, psf);
    const screenOf = (b) => [W / 2 - angDiff(b, bearing) * ppr, H / 2];
    const tDist = sight?.distM ?? lost?.distM ?? Infinity;
    const drawWorlds = (behind) => {
      for (const v of worlds) {
        if (behind ? v.distM < tDist : v.distM >= tDist) continue;
        const [x, y] = screenOf(v.bearing);
        const rPx = v.radRad * ppr;
        if (rPx >= 1.2) {
          const box = this.sky.drawWorld(ctx, v, x, y, rPx, { days: tm / 1440, blurPx: 0.45 * camRes * ppr * blurK, W, H });
          if (target?.kind === 'body' && v.body.name === target.id) this.worldBox = box;
        } else psf(ctx, x, y, mShow - (v.sun ? v.mag + SOLAR_ND : v.mag) - filter.hull, psfPx, v.sun ? [255, 214, 150] : [236, 232, 222]);
      }
    };
    this.worldBox = null;
    drawWorlds(true);

    // ---- Things in the field: the target and whatever else the board holds there
    const toScreen = (s, zM) => [W / 2 - angDiff(s.bearing, bearing) * ppr, H / 2 - (zM / s.distM) * ppr];
    let box = null;
    if (sight && !hider) {
      const [x, y] = toScreen(sight, 0);
      box = this.drawThing(ctx, state, e, sight, x, y, ppr, psfPx, mShow, t);
      const hull = e.type === 'ship' ? hullOf(e.cls) : null;
      if (hull && sight.elements >= 3) this.lastPose = { id: e.id, pos: { ...tpos }, L: hull.L, H: heightOf(e), dir: sight.noseRight ? 1 : -1, fs: sight.foreshorten, faction: e.faction };
      if (sight.regime === 'plume' && sight.elements >= 6 && filter.id === 'off') this.hint = 'plume';
    }
    const others = new Set();
    for (const c of state.sensors.contacts) if (c.id !== target?.id && Math.abs(angDiff(c.bearing, bearing)) < fov) others.add(c.id);
    for (const o of launchedBy(state, PLAYER)) if (o.id !== target?.id) others.add(o.id);
    const threats = new Map();
    for (const oid of others) {
      const o = world.get(oid);
      if (!o) continue;
      const at = tm - Math.hypot(o.pos.x - us.x, o.pos.y - us.y) * AU_M / C_MS / 60;      // (its own light time)
      const p = predictEntity(o, at, world).pos;
      if (o.type === 'ordnance' && passed(o, p, world, at)) continue;
      const s = asSeen(sightOf(state, o, p, us, sc, filter));
      if (Math.abs(angDiff(s.bearing, bearing)) > fov) continue;
      if (occulter(tm, us, s.bearing, s.distM)) continue;
      // (a ship near it sits a little off the plane, as ships do; a torpedo flying at it, between it
      // and us or closing from the side, is on its way to it in the plane: it converges on it)
      const dT = tpos ? Math.hypot(p.x - tpos.x, p.y - tpos.y) * AU_M : s.distM;
      const zM = o.ord?.target === target?.id ? 0 : (idHash(oid) - 0.5) * 2 * Z_SPREAD * Math.min(dT, 20_000);
      const [x, y] = toScreen(s, zM);
      if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
      this.drawThing(ctx, state, o, s, x, y, ppr, psfPx, mShow, t);
      if (o.type === 'ordnance' && o.ord?.target) {
        const cur = threats.get(o.ord.target);
        if (!cur || s.distM < cur.d) threats.set(o.ord.target, { d: s.distM, xy: [x, y] });
      }
    }
    drawWorlds(false);
    // (what the guns of the ships we draw are shooting at: ordnance closing on them, wherever it is)
    for (const o of world.driven) {
      if (o.type !== 'ordnance' || !o.ord?.target || threats.has(o.ord.target) || !this.poses.has(o.ord.target)) continue;
      const s = sightOf(state, o, o.pos, us, sc, filter);
      threats.set(o.ord.target, { d: s.distM, xy: toScreen(s, 0) });
    }

    // ---- The fight, as it would look
    const velOf = (pos, id) => {
      const o = id && world.get(id);
      if (o) return { vx: o.vel.vx, vy: o.vel.vy };
      if (this.track && Math.hypot(pos.x - this.track.pos.x, pos.y - this.track.pos.y) * AU_M < 200_000) return this.track.vel;
      return { vx: state.flight.vel.vx, vy: state.flight.vel.vy };
    };
    const fxView = {
      now, tm, W, H, ppr, mShow, filter, psfPx, point: psf,
      toScreen: (pos) => { const d = Math.max(1, Math.hypot(pos.x - us.x, pos.y - us.y) * AU_M); return [W / 2 - angDiff(Math.atan2(pos.y - us.y, pos.x - us.x), bearing) * ppr, H / 2, d]; },
      pose: (id) => this.poses.get(id) || null,
      threat: (id) => threats.get(id)?.xy || null,
      // where any other thing is on the screen (off it or not); we are the camera, nowhere
      at: (id) => { if (id === PLAYER) return null; const o = world.get(id); return o ? fxView.toScreen(predictEntity(o, tm, world).pos) : null; },
    };
    // (how far apart two things are, and how fast they close: a gun's rounds take their time to cross it)
    const kin = (id) => {
      if (id === PLAYER) return { x: us.x, y: us.y, vx: state.flight.vel.vx, vy: state.flight.vel.vy };
      const o = world.get(id);
      return o ? { ...predictEntity(o, tm, world).pos, vx: o.vel.vx, vy: o.vel.vy } : null;
    };
    this.fx.ingest(fxList(), {
      now, tm, pose: fxView.pose, velOf,
      between: (a, b) => {
        const p = kin(a), q = kin(b);
        if (!p || !q) return null;
        const dx = (q.x - p.x) * AU_M, dy = (q.y - p.y) * AU_M, d = Math.max(1, Math.hypot(dx, dy));
        return { distM: d, closing: -((q.vx - p.vx) * dx + (q.vy - p.vy) * dy) / d };
      },
      burst: (pos, sizeM, until) => {
        const d = Math.max(1, Math.hypot(pos.x - us.x, pos.y - us.y) * AU_M);
        if (Math.abs(angDiff(Math.atan2(pos.y - us.y, pos.x - us.x), bearing)) < fov) this.burst = { fov: sizeM / d / 0.8, until };
      },
      near: (pos) => Math.abs(angDiff(Math.atan2(pos.y - us.y, pos.x - us.x), bearing)) < fov * 1.5,
      lastPoseNear: (pos) => {
        const L = this.lastPose;
        if (!L || world.get(L.id) || Math.hypot(pos.x - L.pos.x, pos.y - L.pos.y) * AU_M > 20_000) return null;
        const d = Math.max(1, Math.hypot(L.pos.x - us.x, L.pos.y - us.y) * AU_M);
        return { ...L, pxPerM: ppr / d };
      },
    });
    this.fx.draw(ctx, fxView);
    ctx.restore();

    // ---- What washes the frame: our own exhaust, the Sun near the boresight
    if (own) {
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, `rgba(225,235,255,${own.see ? own.wash : 0.96})`); g.addColorStop(1, `rgba(120,160,255,${(own.see ? own.wash : 0.96) * 0.8})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (!own.see) this.hint = 'aft';
    }
    if (!sunInField && !sunHidden && sunOff < SUN_GLARE_RAD) {
      const k = Math.pow(1 - sunOff / SUN_GLARE_RAD, 2) * (0.35 + 0.65 * filter.own);
      const left = angDiff(Math.atan2(-us.y, -us.x), bearing) > 0;
      const g = ctx.createLinearGradient(left ? 0 : W, 0, left ? W : 0, 0);
      g.addColorStop(0, `rgba(255,236,200,${0.95 * k})`); g.addColorStop(0.6, `rgba(255,220,170,${0.35 * k})`); g.addColorStop(1, `rgba(255,210,160,${0.12 * k})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    this.fx.drawSensor(ctx, fxView);
    this.grain(ctx, W, H, Math.min(1.3, gain));

    // ---- The readouts
    const named = e ? (e.type === 'ordnance' ? 'Torpedo' : isIdentified(state, e) ? e.name : 'Unidentified contact') : wv ? (wv.sun ? 'The Sun' : wv.body.name) : null;
    const marks = e && e.type !== 'ordnance' ? markWords(marksOf(frameMarks(state), e.id, isDark(e), e.tags?.wreck)) : '';
    const mode = this.slew ? 'SLEWING' : lost ? 'HOLDING LAST POSITION' : hider ? 'OCCULTED' : lock && !lock.ok ? (lock.why === 'range' ? 'NO LOCK' : 'NO TRACK') : 'TRACKING';
    this.hud(ctx, W, H, state, {
      sc, sight: hider ? null : sight, wv, lock, name: named, marks, fov, ppr, box: box || this.worldBox, own, faction: e?.faction, lost, hider, mode,
      rangeM: e && !lost ? relativeTo(state, { kind: 'entity', id: e.id })?.dist : null,
      expS, gain, filter, sunInField, sunOff, us, bearing, lag: sight?.lagS ?? wv?.lagS ?? null, event: this.fx.event(now),
    });
  }

  /** One thing in the field, by its regime; returns the box round it (px) for the reticle, and keeps its pose for the effects. */
  drawThing(ctx, state, e, s, x, y, ppr, psfPx, mShow, t) {
    const pxPerM = ppr / s.distM;
    const dir = s.noseRight ? 1 : -1;
    const lit = s.plumeMag < Infinity;
    // how far it is resolved, 0 (a point) to 1 (a shape), between 1.5 and 3 elements
    const shape = Math.max(0, Math.min(1, (s.elements - 1.5) / 1.5));
    const hull = e.type === 'ship' ? hullOf(e.cls) : null;
    let box = null;
    // a lit drive's glare against the hull: how many magnitudes it outshines it (the filters close the gap)
    const glareK = lit ? Math.max(0, Math.min(1, (s.hullMag - s.plumeMag - 6) / 6)) : 0;
    const toward = Math.max(0, Math.min(1, (s.away - 0.2) / 0.6));        // its exhaust pointing at us
    const sternM = hull ? hull.bounds.x0 : -3;
    // (the nozzle where the axis really projects: end on, in the middle of the hull)
    const nx = x + dir * sternM * (s.sinA ?? s.foreshorten) * pxPerM;
    const hullPx = (hull?.L || 6) * s.foreshorten * pxPerM;
    // pointing at us, the hull hides its own drive: the glare round its silhouette, drawn first
    if (lit && s.away < -0.2 && shape > 0) psf(ctx, nx, y, mShow - s.plumeMag, psfPx * 1.6, [205, 222, 255]);
    if (shape > 0 && e.type !== 'ordnance' && (s.regime !== 'plume' || s.elements >= 6)) {
      // exposed for a bright drive the hull goes dark; looking into its exhaust, the plume washes over it
      const dim = (1 - 0.45 * glareK) * (1 - 0.88 * glareK * toward);
      box = this.drawShape(ctx, e, s, x, y, pxPerM, Math.max(0, 0.45 * s.resRad * ppr), shape * dim * (e.tags?.wreck ? 0.7 : 1), t);
    }
    if (shape < 1 && s.regime !== 'none') psf(ctx, x, y, (mShow - s.hullMag) * (1 - shape), psfPx, [232, 238, 245]);
    // its night side to us: what light there is comes off the sunlit limb, a thin crescent at the Sun's end
    else if (box && s.phase > NIGHT) {
      const limb = (s.sunRight ? box.x1 : box.x0) - (s.sunRight ? 1 : -1) * Math.min(6, (box.x1 - box.x0) * 0.08);
      psf(ctx, limb, y, (mShow - s.hullMag) * 0.8, psfPx, [232, 238, 245]);
    }
    if (lit && !(s.away < -0.2 && shape > 0)) {
      // the drive: a star at the stern; its exhaust out behind it, as long as we see it from the side
      psf(ctx, nx, y, mShow - s.plumeMag, psfPx, [205, 222, 255]);
      if (box) exhaust(ctx, nx, y, -dir, Math.max(8, hullPx * 0.8 * (1 - toward * 0.7)), Math.max(1.5, (hull?.W || 1) * 0.18 * pxPerM), clamp(1 - (s.plumeMag - (mShow - 9)) / 12, 0.15, 1));
      // looking up its exhaust: the plume's light between us and the hull
      if (box && toward > 0 && glareK > 0) {
        const g = ctx.createRadialGradient(nx, y, 0, nx, y, Math.max(10, hullPx * (0.55 + 0.6 * toward)));
        const a = 0.9 * toward * glareK;
        g.addColorStop(0, `rgba(240,246,255,${a})`); g.addColorStop(0.4, `rgba(190,210,255,${a * 0.6})`); g.addColorStop(1, 'rgba(150,180,255,0)');
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(nx, y, Math.max(10, hullPx * (0.55 + 0.6 * toward)), 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }
    if (lit && glareK > 0.5 && s.elements >= 6 && this.filter === 'off') this.hint = this.hint || 'plume';
    const b = box || { x0: x - 10, y0: y - 10, x1: x + 10, y1: y + 10 };
    this.poses.set(e.id, { x, y, pxPerM, dir, fs: s.foreshorten, hull, box: box || null, distM: s.distM, solid: box?.solid || null });
    return b;
  }

  /** A hull (or a station) as the optics resolve it: drawn side on, shaded by the Sun, blurred. */
  drawShape(ctx, e, s, x, y, pxPerM, blurPx, alpha, t) {
    const hull = e.type === 'ship' ? hullOf(e.cls) : null;
    const model = e.type === 'station' ? stationModel(e.id) : null;
    if (!hull && !model) return null;
    if (has3D()) {
      const b = this.solidShape(ctx, e, s, x, y, pxPerM, blurPx, alpha, t, hull, model);
      if (b) return b;
    }
    const L = hull ? hull.L : model.sizeM, Hm = heightOf(e);
    const wPx = L * s.foreshorten * pxPerM, hPx = Hm * pxPerM;
    const m = Math.ceil(blurPx * 3 + 6);
    const dpr = this.fc.dpr;
    // (a hull bigger than the frame is drawn only as far as the frame's twice over: the rest is off it)
    const cap = Math.min(4096 / dpr, 2.2 * Math.max(this.fc.w, this.fc.h));
    const ow = Math.min(cap, Math.ceil(wPx * 1.15 + 2 * m)), oh = Math.min(cap, Math.ceil(hPx * 1.2 + 2 * m));
    const off = this.off;
    if (off.width < ow * dpr || off.height < oh * dpr) { off.width = Math.max(off.width, Math.ceil(ow * dpr)); off.height = Math.max(off.height, Math.ceil(oh * dpr)); }
    const o = off.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, off.width, off.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.save();
    o.translate(ow / 2, oh / 2);
    o.scale((s.noseRight ? 1 : -1) * s.foreshorten, 1);
    const tint = factionColor(e.faction);
    if (hull) drawHull(o, hull, { x: 0, y: 0, facing: 0, scale: pxPerM, view: 'side', tint, plume: 0, t, ports: false });
    else drawStation(o, model, { x: 0, y: 0, angle: 0, scale: pxPerM, t, tint, labels: false });
    o.restore();
    // The Sun's side lit, the far side in shadow; seen from its night side, a silhouette
    const k = (1 - Math.cos(s.phase)) / 2;
    const near = Math.min(0.95, 0.08 + 0.78 * k), far = Math.min(0.97, 0.35 + 0.62 * k);
    const g = o.createLinearGradient(s.sunRight ? ow : 0, 0, s.sunRight ? 0 : ow, 0);
    g.addColorStop(0, `rgba(0,0,0,${near})`); g.addColorStop(1, `rgba(0,0,0,${far})`);
    o.globalCompositeOperation = 'source-atop';
    o.fillStyle = g; o.fillRect(0, 0, ow, oh);
    o.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = alpha;
    // (the model's tones are the display's, dark; in sunlight a hull is bright: exposed for it)
    ctx.filter = `${blurPx > 0.35 ? `blur(${blurPx.toFixed(1)}px) ` : ''}brightness(1.6) contrast(1.1)`;
    ctx.drawImage(off, 0, 0, ow * dpr, oh * dpr, x - ow / 2, y - oh / 2, ow, oh);
    ctx.restore();
    return { x0: x - wPx / 2, y0: y - hPx / 2, x1: x + wPx / 2, y1: y + hPx / 2 };
  }

  /**
   * A hull (or a station) on the GPU (gl/ships3d.js): the solid seen along
   * our line of sight with the plane's up as up, lit by the Sun at its true
   * phase (the side toward it bright, its night side black but for what the
   * sky gives back), blurred to what the optics resolve. Only the part in
   * the frame is rendered. Returns its box, and how its own frame projects
   * (the effects put hits and the guns' muzzles on it: scope-fx.js).
   */
  solidShape(ctx, e, s, x, y, pxPerM, blurPx, alpha, t, hull, model) {
    const dpr = this.fc.dpr, W = this.fc.w, H = this.fc.h;
    const b = s.bearing, f = [Math.cos(b), Math.sin(b), 0], right = [Math.sin(b), -Math.cos(b), 0];
    // (a ship flying in the plane is rolled however its crew left it: a little of its back or its belly shows)
    const m = hull ? rolled(hullMatrix(0, 0, facingOf(e), 'top'), (idHash(e.id) - 0.5) * 0.9) : stationMatrix(0, 0, stationAngle(e.orbit, this.tm));
    const bb = hull ? hull.bounds : modelBounds(model);
    // where its corners fall on the screen
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const cx of [bb.x0, bb.x1]) for (const cy of [bb.y0, bb.y1]) for (const cz of [bb.z0, bb.z1]) {
      const w = [m[0] * cx + m[4] * cy + m[8] * cz, m[1] * cx + m[5] * cy + m[9] * cz, m[2] * cx + m[6] * cy + m[10] * cz];
      const rr = w[0] * right[0] + w[1] * right[1];
      r0 = Math.min(r0, rr); r1 = Math.max(r1, rr); u0 = Math.min(u0, w[2]); u1 = Math.max(u1, w[2]);
    }
    const box = { x0: x + r0 * pxPerM, x1: x + r1 * pxPerM, y0: y - u1 * pxPerM, y1: y - u0 * pxPerM };
    // (rendered only as far as the frame, and a margin for the blur)
    const pad = Math.ceil(blurPx * 3 + 4);
    const cx0 = Math.max(-pad, Math.floor(box.x0 - pad)), cx1 = Math.min(W + pad, Math.ceil(box.x1 + pad));
    const cy0 = Math.max(-pad, Math.floor(box.y0 - pad)), cy1 = Math.min(H + pad, Math.ceil(box.y1 + pad));
    if (cx1 <= cx0 || cy1 <= cy0) return { ...box, solid: null };
    const wD = Math.min(4096, Math.ceil((cx1 - cx0) * dpr)), hD = Math.min(4096, Math.ceil((cy1 - cy0) * dpr));
    const k = wD / (cx1 - cx0);
    const mx = ((cx0 + cx1) / 2 - x) / pxPerM, my = (y - (cy0 + cy1) / 2) / pxPerM;
    const L = hull ? hull.L : model.sizeM;
    const cam = orthoCamera([right[0] * mx, right[1] * mx, my], f, [0, 0, 1], wD, hD, pxPerM * k, L * 2 + 200);
    // the Sun, at the phase we see it at: on the side the sight says
    const ph = s.phase, side = s.sunRight ? 1 : -1;
    const sun = [-f[0] * Math.cos(ph) + right[0] * side * Math.sin(ph), -f[1] * Math.cos(ph) + right[1] * side * Math.sin(ph), 0.04];
    const out = renderScene({
      w: wD, h: hD, ...cam, sun, sunI: 3.4, exposure: 1.15, t, pxPerM: pxPerM * k,
      objects: [{ kind: hull ? 'hull' : 'station', key: hull ? e.cls : e.id, model: hull || model, tl: e.tl ?? 2, m, tint: factionColor(e.faction), plume: 0, heat: Math.min(1, (e.thrust || 0) * 0.35), lights: !e.tags?.wreck && !isDark(e) }],
      shadowBox: { cx: 0, cy: 0, cz: 0, half: L * 0.7, depth: L * 0.7 }, fill: { dir: [0, 0, 1], col: [0.012, 0.012, 0.015] },
    });
    if (!out) return null;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blurPx > 0.35) ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
    ctx.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.restore();
    // a point of its own frame (m) on the screen; is a face turned toward us
    const proj = (p) => {
      const w = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
      return [x + (w[0] * right[0] + w[1] * right[1]) * pxPerM, y - w[2] * pxPerM];
    };
    const toUs = (n) => -(m[0] * n[0] + m[4] * n[1] + m[8] * n[2]) * f[0] - (m[1] * n[0] + m[5] * n[1] + m[9] * n[2]) * f[1];
    return { ...box, solid: { proj, toUs, m, f, right } };
  }

  /** The sensor's noise: a still pattern, moved every frame. */
  grain(ctx, W, H, gain) {
    if (gain <= 0.02) return;
    const p = this._pat || (this._pat = ctx.createPattern(this.noise, 'repeat'));
    ctx.save();
    ctx.globalAlpha = 0.02 + 0.07 * gain;
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(-Math.floor(Math.random() * 128), -Math.floor(Math.random() * 128));
    ctx.fillStyle = p;
    ctx.fillRect(0, 0, W + 128, H + 128);
    ctx.restore();
  }

  hud(ctx, W, H, state, o) {
    ctx.font = FONT;
    ctx.textBaseline = 'alphabetic';
    const sc = o.sc || scopeOf(state);
    const s = o.sight, wv = o.wv;
    // the camera itself: what it is doing, how it is exposed, how old the light is
    ctx.textAlign = 'left';
    const modeCol = o.mode === 'TRACKING' ? CYAN : o.mode === 'SLEWING' ? TEXT : WARN;
    label(ctx, `TELESCOPE ${sc.apertureM} m · `, 12, 20, DIM);
    label(ctx, o.mode || '', 12 + ctx.measureText(`TELESCOPE ${sc.apertureM} m · `).width, 20, modeCol);
    if (o.expS) {
      const filt = [o.filter && o.filter.id !== 'off' ? `FILTER ${o.filter.label} −${o.filter.plume}` : null, o.sunInField ? `SOLAR FILTER ND ${(SOLAR_ND / 2.5).toFixed(0)}` : null].filter(Boolean).join(' · ');
      label(ctx, `EXPOSURE ${fmtExp(o.expS)} · GAIN ${Math.round(clamp(o.gain, 0, 1) * 24)} dB${filt ? ' · ' + filt : ''}`, 12, 34, o.filter?.id !== 'off' || o.sunInField ? SUNC : DIM);
    }
    if (o.lag != null) label(ctx, `IMAGE ${lightTime(o.lag * C_MS)} OLD`, 12, 48, DIM);
    // where the Sun is, off the frame's edge (in the plane: to one side)
    if (o.us && o.bearing != null && !o.sunInField) {
      const off = angDiff(Math.atan2(-o.us.y, -o.us.x), o.bearing);
      const left = off > 0, x = left ? 14 : W - 14, y = H / 2;
      ctx.fillStyle = SUNC;
      ctx.beginPath(); ctx.moveTo(x + (left ? -6 : 6), y); ctx.lineTo(x + (left ? 2 : -2), y - 5); ctx.lineTo(x + (left ? 2 : -2), y + 5); ctx.closePath(); ctx.fill();
      ctx.textAlign = left ? 'left' : 'right';
      label(ctx, `☉ ${Math.round(Math.abs(off) * 180 / Math.PI)}°`, x + (left ? 6 : -6), y + 16, SUNC);
    }
    // the reticle: corner marks round what we hold, and the boresight
    if (s || wv || o.lost || o.lock?.why === 'range' || o.hider) {
      const b = o.box || { x0: W / 2 - 12, y0: H / 2 - 12, x1: W / 2 + 12, y1: H / 2 + 12 };
      const pad = 10, L = 9;
      const x0 = Math.max(4, b.x0 - pad), x1 = Math.min(W - 4, b.x1 + pad), y0 = Math.max(4, b.y0 - pad), y1 = Math.min(H - 30, b.y1 + pad);
      ctx.strokeStyle = o.lost || o.hider ? WARN : CYAN; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.moveTo(cx + 0.5, cy + sy * L + 0.5); ctx.lineTo(cx + 0.5, cy + 0.5); ctx.lineTo(cx + sx * L + 0.5, cy + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(62,199,230,0.35)';
    ctx.beginPath(); ctx.moveTo(W / 2 - 4, H / 2 + 0.5); ctx.lineTo(W / 2 - 1.5, H / 2 + 0.5); ctx.moveTo(W / 2 + 1.5, H / 2 + 0.5); ctx.lineTo(W / 2 + 4, H / 2 + 0.5);
    ctx.moveTo(W / 2 + 0.5, H / 2 - 4); ctx.lineTo(W / 2 + 0.5, H / 2 - 1.5); ctx.moveTo(W / 2 + 0.5, H / 2 + 1.5); ctx.lineTo(W / 2 + 0.5, H / 2 + 4); ctx.stroke();
    // what we look at, and the numbers that decide how it looks
    if (o.name) {
      ctx.textAlign = 'right';
      const lines = [[o.name + (o.marks || ''), o.faction ? factionColor(o.faction) : wv ? SUNC : TEXT]];
      // (a contact's range is the one every panel gives: hud.js relativeTo, at the sim's minute)
      const d = o.rangeM ?? s?.distM ?? wv?.distM ?? o.lost?.distM ?? o.lock?.distM;
      if (wv) lines[0][0] += ` · ${KIND_WORD[wv.body.type] || 'BODY'}`;
      if (d != null) lines.push([`RANGE ${d > 0.02 * AU_M ? `${(d / AU_M).toFixed(3)} AU` : fmtKm(d / 1000)} · LIGHT ${lightTime(d)}`, TEXT]);
      if (s) {
        lines.push([`SIZE ${fmtRad(s.angRad)} · RESOLVES ${fmtRad(s.resRad)} (${fmtLen(s.resM)})`, DIM]);
        const mags = [s.hullMag < 40 ? `HULL MAG ${s.hullMag.toFixed(1)}` : null, s.plumeMag < Infinity ? `PLUME ${s.plumeMag.toFixed(1)}` : null].filter(Boolean).join(' · ');
        lines.push([`${mags} · LIMIT ${s.magLimit.toFixed(1)}`, DIM]);
        lines.push([`FIELD ${fmtRad(o.fov)} · PHASE ${Math.round(s.phase * 180 / Math.PI)}°`, DIM]);
      } else if (wv) {
        lines.push([`DIAMETER ${fmtArc(wv.angRad)} (${fmtKm(wv.body.radius * 2)}) · MAG ${wv.mag.toFixed(1)}`, DIM]);
        if (!wv.sun) lines.push([`PHASE ${Math.round(wv.phase * 180 / Math.PI)}° · ${Math.round((1 + Math.cos(wv.phase)) * 50)}% LIT`, DIM]);
        lines.push([`FIELD ${fmtArc(o.fov)}`, DIM]);
      }
      lines.forEach(([txt, col], i) => label(ctx, txt, W - 12, 20 + i * 14, col));
    }
    // scale: a bar of round metres (or km) at the target's range
    const distForScale = s?.distM ?? wv?.distM ?? o.lost?.distM ?? null;
    if (distForScale && o.ppr) {
      const pxPerM = o.ppr / distForScale;
      const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8];
      const bar = nice.find(n => n * pxPerM >= 70) || nice.at(-1);
      const len = bar * pxPerM;
      ctx.strokeStyle = 'rgba(148,163,178,0.9)';
      ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + len, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + len, H - 20); ctx.lineTo(14 + len, H - 12); ctx.stroke();
      ctx.textAlign = 'left';
      label(ctx, `${fmtLen(bar)} at the target`, 18 + len, H - 12, 'rgba(148,163,178,0.95)');
    }
    // what the picture is, in words
    let msg = o.msg, warn = !!o.warn;
    // (what is happening in the frame outranks what it shows)
    const lostWords = o.lost ? (o.lost.how === 'reactor' ? 'TARGET DESTROYED · its reactor let go · holding on its last position' : 'TARGET LOST · holding on its last position') : null;
    const msgY = distForScale ? H - 36 : H - 16;
    if (!msg && o.event && !(o.own && !o.own.see)) {
      msg = o.event; warn = /DETONATION|HIT|DOWN/.test(o.event);
      if (lostWords) { ctx.textAlign = 'center'; label(ctx, lostWords, W / 2, msgY - 14, WARN); }
    }
    if (!msg) {
      if (o.own && !o.own.see) { msg = 'BLINDED · our own drive plume is in the line of sight: FILTER to see through it'; warn = true; }
      else if (o.lost) { msg = lostWords; warn = true; }
      else if (o.hider) { msg = `OCCULTED · behind ${o.hider.sun ? 'the Sun' : o.hider.body.name}`; warn = true; }
      else if (s) msg = (o.own?.see ? 'THROUGH OUR OWN EXHAUST, FILTERED · ' : '') + REGIME[s.regime](s, o.filter);
      else if (wv) msg = worldWords(wv, o.ppr);
      else if (o.lock && !o.lock.ok) { msg = lockWords(o.lock); warn = true; }
    }
    if (!msg && o.sunOff < SUN_GLARE_RAD && !o.sunInField) msg = `SUN ${(o.sunOff * 180 / Math.PI).toFixed(1)}° OFF THE BORESIGHT · its scattered light washes the frame`;
    if (msg) {
      ctx.textAlign = 'center';
      label(ctx, msg, W / 2, msgY, warn ? WARN : TEXT);
    }
    ctx.textAlign = 'left';
  }
}

/** A hull's height across the line of sight (side on), m; a station's plan. */
/** A hull's model matrix rolled about its own axis by `a` (rad). */
function rolled(m, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const Y = [m[4], m[5], m[6]], Z = [m[8], m[9], m[10]];
  const out = Float32Array.from(m);
  for (let i = 0; i < 3; i++) { out[4 + i] = Y[i] * c + Z[i] * s; out[8 + i] = Z[i] * c - Y[i] * s; }
  return out;
}

/** A station model's extent (m, its own frame), worked once. */
const _bounds = new WeakMap();
function modelBounds(model) {
  let b = _bounds.get(model);
  if (b) return b;
  b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of model.parts) {
    const e = p.k === 'box' ? [p.x0, p.x1, p.y0, p.y1, p.z0, p.z1] : p.k === 'cyl' ? [p.x0, p.x1, p.y - p.r, p.y + p.r, (p.z || 0) - p.r, (p.z || 0) + p.r]
      : p.k === 'ring' ? [p.x - p.r - p.d, p.x + p.r + p.d, -p.r - p.d, p.r + p.d, -p.w / 2, p.w / 2] : null;
    if (!e) continue;
    b.x0 = Math.min(b.x0, e[0]); b.x1 = Math.max(b.x1, e[1]); b.y0 = Math.min(b.y0, e[2]); b.y1 = Math.max(b.y1, e[3]); b.z0 = Math.min(b.z0, e[4]); b.z1 = Math.max(b.z1, e[5]);
  }
  _bounds.set(model, b);
  return b;
}

function heightOf(e) {
  if (e?.type === 'station') return (stationModel(e.id)?.sizeM || 1000) * 0.7;
  const h = e?.type === 'ship' ? hullOf(e.cls) : null;
  return h ? Math.max(h.bounds.z1 - h.bounds.z0, h.W * 0.6) * 1.3 : 6;
}

const REGIME = {
  resolved: (s) => s.phase > NIGHT ? `RESOLVED · its night side to us, ${Math.round(s.elements)} resolution elements of shadow` : `RESOLVED · ${Math.round(s.elements)} resolution elements across it`,
  blob: () => 'BARELY RESOLVED · a smudge of reflected sunlight',
  point: () => 'UNRESOLVED · a point of reflected sunlight',
  plume: (s, f) => s.hullMag > s.magLimit ? `DRIVE PLUME ONLY · the hull is too faint to see${f?.id === 'off' ? '' : ' even filtered'}`
    : s.elements >= 6 && f?.id === 'off' ? 'DRIVE PLUME · the hull is lost in its glare: FILTER to bring it out' : 'DRIVE PLUME · the hull is lost in its glare',
  none: (s) => s.hullMag < 40 ? `NOTHING ABOVE THE NOISE · it would be magnitude ${s.hullMag.toFixed(1)}; the camera reaches ${s.magLimit.toFixed(1)}`
    : 'NOTHING ABOVE THE NOISE · we see its night side',
};
const lockWords = (l) => l.why === 'range' ? `NO LOCK · ${fmtKm(l.distM / 1000)} out: ${l.text.toLowerCase()}` : l.why === 'track' ? 'NO TRACK · the board no longer holds it' : 'SENSORS DARK';

function worldWords(v, ppr) {
  const rPx = v.radRad * ppr;
  if (v.sun) return 'THE SUN · through the solar filter: the photosphere, its granulation, sunspots';
  if (rPx < 1.2) return `A POINT OF LIGHT · magnitude ${v.mag.toFixed(1)}, too far to show a disc`;
  if (rPx < 6) return `A DISC · ${Math.round((1 + Math.cos(v.phase)) * 50)}% lit, a few resolution elements across`;
  return v.phase > NIGHT ? 'ITS NIGHT SIDE · a thin crescent of sunlight' : v.phase > 1.2 ? 'A CRESCENT · the Sun beyond it' : `${Math.round((1 + Math.cos(v.phase)) * 50)}% LIT · the Sun ${v.sunRight ? 'to the right' : 'to the left'}`;
}

/** A readout, outlined dark so it reads over a bright hull as over black sky. */
function label(ctx, text, x, y, color) {
  ctx.lineWidth = 3; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.lineWidth = 1;
}

function lightTime(m) {
  const s = m / C_MS;
  return s < 0.01 ? `${(s * 1e3).toFixed(1)} ms` : s < 60 ? `${s.toFixed(s < 1 ? 2 : 1)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
}
function fmtRad(r) {
  if (!isFinite(r)) return '—';
  if (r < 1e-3) return `${(r * 1e6).toFixed(r < 1e-5 ? 1 : 0)} µrad`;
  return `${(r * 1e3).toFixed(r < 1e-2 ? 2 : 1)} mrad`;
}
/** An angle the way an astronomer says it: arcseconds, arcminutes, degrees. */
function fmtArc(r) {
  const as = r * 206265;
  return as < 120 ? `${as.toFixed(as < 10 ? 1 : 0)}″` : as < 7200 ? `${(as / 60).toFixed(1)}′` : `${(r * 180 / Math.PI).toFixed(1)}°`;
}
const fmtLen = (m) => m < 1000 ? `${m < 10 ? m.toFixed(1) : Math.round(m)} m` : fmtKm(m / 1000);
const fmtExp = (s) => s >= 1 / 30 - 1e-9 ? '1/30 s' : `1/${(1 / s) < 1e4 ? Math.round(1 / s) : `${Math.round(1 / s / 1000)}k`} s`;

/**
 * Has ordnance drawn at `p` (tm) passed its target since the minute the sim
 * last flew? Then it is no longer drawn: the sim settles that minute whole,
 * and whether it hit, was shot down or missed shows when it does.
 */
function passed(o, p, world, tm) {
  const tg = o.ord?.target ? world.get(o.ord.target) : null;
  if (!tg) return false;
  const q = predictEntity(tg, tm, world).pos;
  const r0x = tg.pos.x - o.pos.x, r0y = tg.pos.y - o.pos.y;
  const r1x = q.x - p.x, r1y = q.y - p.y;
  return r0x * r1x + r0y * r1y < 0;
}

/**
 * A point of light: `s` magnitudes above what the frame shows (none at
 * 0 or less), as wide as the optics blur a star (rPx); saturated, it
 * blooms and throws the mirror's four diffraction spikes.
 */
export function psf(ctx, x, y, s, rPx, rgb) {
  if (!(s > 0)) return;
  const I = Math.min(1, 0.2 + 0.13 * s);
  const r = Math.max(1.1, rPx);
  const over = Math.max(0, s - 6);           // past this the pixels saturate: the spot blooms
  const R = r * (2 + over * 0.9);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, `rgba(255,255,255,${I})`);
  g.addColorStop(Math.min(0.5, 0.45 / (1 + over * 0.3)), `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${I * 0.6})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
  if (over > 1) {
    const len = r * (4 + over * 6);
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(0.7, (over - 1) * 0.12)})`;
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len); ctx.stroke();
  }
  ctx.restore();
}

/** The exhaust behind a resolved hull's drive: a short, hot cone (most of a fusion jet is invisible), dimmer filtered. */
function exhaust(ctx, x, y, dir, len, w, k = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, y, x + dir * len, y);
  g.addColorStop(0, `rgba(235,242,255,${0.9 * k})`); g.addColorStop(0.12, `rgba(170,200,255,${0.45 * k})`); g.addColorStop(0.5, `rgba(110,150,255,${0.12 * k})`); g.addColorStop(1, 'rgba(90,130,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(x, y - w); ctx.quadraticCurveTo(x + dir * len * 0.3, y - w * 2.2, x + dir * len, y - w * 2.6); ctx.lineTo(x + dir * len, y + w * 2.6); ctx.quadraticCurveTo(x + dir * len * 0.3, y + w * 2.2, x, y + w); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** A tile of sensor noise: faint speckle, a few hot pixels. */
function makeNoise() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const o = c.getContext('2d');
  const img = o.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.002 ? 200 : Math.floor(Math.random() ** 3 * 90);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = Math.min(255, v + 6); img.data[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return c;
}
