// ============================================================
// LONGHAUL — Solar map (canvas)
// Pan / zoom from the whole system down to a few hundred km. Bodies
// are drawn from the ephemeris. Entities are what we KNOW of them
// (intel.js): live contacts and charted orbits where they are, and the
// reports on the plot (lost contacts, traffic digests) where they should
// be by now, faded with age. Big plots fall back to a point cloud.
//
// Layers can be filtered (stations, ships, the plot's reports), stations
// are drawn over the traffic crowding them, and a click on a crowd offers
// the list of what is under the pointer (onPickList) rather than guessing.
//
// It is the console's main display, drawn the way a nav display is:
// no starfield (stars tell a navigator nothing here), hairline orbits,
// the Belt as the band it is, colour that means something (green is us,
// magenta our route, cyan what is selected, amber and red the trouble
// spots, faction colours for who owns what), names that thin out with
// the zoom and never print over one another (labels.js: the most
// important are placed first), and nothing that moves unless the thing it shows does (a
// distress beacon's pulse is the one exception: it is an alarm). Zoom
// eases toward where the wheel asked for, about the point under the
// pointer. The nav computer's marks are drawn on it as on every display
// (marks.js): a ship running dark hollow, what our work points at in a
// magenta diamond (a mission's nav marks, which are drawn only then or
// when picked), the captain's flags as lettered pennants.
// ============================================================

import { AU_KM, AU_M, DAY_MIN } from '../core/constants.js';
import { BODIES, bodyPos } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { factionColor, INFLUENCE_SOURCES, FACTIONS } from '../sim/factions.js';
import { zonePos, ZONE_KINDS } from '../sim/conflict.js';
import { getBody } from '../sim/ephemeris.js';
import { estimate, liveKnowledge, LIGHT_SECOND_AU, LIGHT_MINUTE_AU } from '../sim/intel.js';
import { isDark, contactById } from '../sim/sensors.js';
import { aimPoint } from '../sim/ordnance.js';
import { FitCanvas, fmtKm, pointAt } from './dom.js';
import { Labels } from './labels.js';
import { frameMarks, marksOf, markPri, labelTags, drawMissionMark, drawFlagMark, paintMark, MARK_COL } from './marks.js';
import { ourName } from '../sim/service.js';
import { worldOf } from '../sim/worlds.js';
import { drawWorldZones, drawShuttleTracks } from './worldzones.js';

const LIGHT_RINGS = [[LIGHT_SECOND_AU, '1 LIGHT-SEC'], [LIGHT_MINUTE_AU, '1 LIGHT-MIN'], [LIGHT_MINUTE_AU * 10, '10 LIGHT-MIN']];
const REPORT_FADE_MIN = 3 * 1440;   // a report is drawn faintest at this age
const _est = { x: 0, y: 0, sigmaAU: 0 };

/**
 * The name a contact goes by on our board (null until identified): looked
 * up by id in an index of the board, made again when the board is (once a
 * minute: a crowded port's board holds thousands, and the map asks for
 * every label every frame).
 */
const contactName = (state, id) => contactById(state, id)?.name ?? null;

const MIN_SCALE = 6;          // px per AU (whole system)
const MAX_SCALE = 4e8;        // px per AU (~0.4 km per px)
const _q = [];
const _bp = { x: 0, y: 0 };

// The display's colours (the console's: css/console.css)
const COL = {
  void: '#05070A', ring: 'rgba(42,56,70,0.55)', ringText: 'rgba(94,109,124,0.9)', orbit: 'rgba(52,70,88,0.75)', orbitMinor: 'rgba(42,56,70,0.6)',
  text: '#D8E1EA', text2: '#94A3B2', text3: '#5E6D7C', own: '#5FD38D', sel: '#3EC7E6', route: '#D46BE0', caution: '#F0A93A', warn: '#EF5350', mil: '#E07B4F',
  belt: 'rgba(150,135,110,0.06)', light: 'rgba(240,169,58,0.35)', lightText: 'rgba(240,169,58,0.7)',
};
const UI = (px, w = 500) => `${w} ${px}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`;
const MONO = (px) => `${px}px "IBM Plex Mono", ui-monospace, monospace`;
/** A hot zone's colour: what it means for a ship going near it. */
const ZONE_COL = { front: COL.warn, skirmish: COL.warn, blockade: COL.caution, standoff: COL.caution, proxy: COL.mil, insurgency: COL.caution, pirates: '#C05AA0' };

export class SolarMap {
  constructor(container, { onSelect, onHover, onPickList } = {}) {
    this.fc = new FitCanvas(container, { className: 'map-canvas' });
    this.labels = new Labels({ halo: 'rgba(5,7,10,0.8)', haloW: 3 });
    this.cx = 0; this.cy = 0;           // view center, AU
    this.scale = 60;                    // px per AU
    this.follow = 'ship';               // 'ship' | 'target' | null
    this.selected = null;               // { kind, id }
    this.hover = null;
    this.preview = null;                // [{x,y}] planned path to draw
    this.routePath = null;              // active route predicted path
    this.showPolitics = true;           // spheres of influence and hot zones
    this.showIntel = true;              // reported tracks on the plot, light-time rings
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.onPickList = onPickList || null;
    this.filter = { stations: true, ships: true };   // layers drawn (reports: showIntel)
    this._pickables = [];
    this._zoom = null;                  // { target scale, sx, sy (the point to keep still) }
    this._bind(container);
  }

  // ---- CAMERA ----
  setView(name, state) {
    const f = state.flight.pos;
    if (name === 'ship') { this.follow = 'ship'; this.scale = this._fitScale(0.6); }
    else if (name === 'inner') { this.follow = null; this.cx = 0; this.cy = 0; this.scale = this._fitScale(1.9); }
    else if (name === 'belt') { this.follow = null; this.cx = 0; this.cy = 0; this.scale = this._fitScale(3.5); }
    else if (name === 'system') { this.follow = null; this.cx = 0; this.cy = 0; this.scale = this._fitScale(32); }
    else if (name === 'target') { this.follow = 'target'; this.scale = Math.max(this.scale, 4000); }
    if (this.follow === 'ship') { this.cx = f.x; this.cy = f.y; }
  }

  _fitScale(radiusAU) {
    const m = Math.min(this.fc.w || 600, this.fc.h || 600) / 2;
    return m / radiusAU;
  }

  focusOn(pos, scale) {
    this.follow = null;
    this.cx = pos.x; this.cy = pos.y;
    this._zoom = null;
    if (scale) this.scale = scale;
  }

  /** A step of the eased zoom: a quarter of the way there a frame, the point under the pointer kept still. */
  _ease() {
    const z = this._zoom;
    if (!z) return;
    const before = this.toWorld(z.sx, z.sy);
    const ratio = z.target / this.scale;
    this.scale = Math.abs(Math.log(ratio)) < 0.004 ? z.target : this.scale * Math.pow(ratio, 0.28);
    if (!this.follow) { const after = this.toWorld(z.sx, z.sy); this.cx += before.x - after.x; this.cy += before.y - after.y; }
    if (this.scale === z.target) this._zoom = null;
  }

  _bind(el) {
    let drag = null;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0018);
      const from = this._zoom?.target ?? this.scale;
      this._zoom = { target: Math.min(MAX_SCALE, Math.max(MIN_SCALE, from * k)), sx: mx, sy: my };
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        if (drag.moved > 4) {
          this.follow = null;
          this.cx = drag.cx - dx / this.scale;
          this.cy = drag.cy + dy / this.scale;
          this.fc.canvas.style.cursor = 'var(--cur-move, grabbing)';
        }
      } else {
        const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
        const key = hit ? `${hit.kind}:${hit.id}` : null;
        if (key !== (this.hover ? `${this.hover.kind}:${this.hover.id}` : null)) {
          this.hover = hit;
          this.onHover(hit);
        }
        pointAt(this.fc.canvas, hit);
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const r = el.getBoundingClientRect();
      if (drag.moved <= 4) {
        const all = this.pickAll(e.clientX - r.left, e.clientY - r.top);
        if (all.length > 1 && this.onPickList) this.onPickList(all, e.clientX - r.left, e.clientY - r.top);
        else {
          const hit = all[0] || null;
          this.selected = hit;
          this.onSelect(hit);
        }
      }
      drag = null;
      pointAt(this.fc.canvas, false);
    });
  }

  toWorld(sx, sy) {
    return { x: this.cx + (sx - this.fc.w / 2) / this.scale, y: this.cy - (sy - this.fc.h / 2) / this.scale };
  }

  toScreen(x, y) {
    return { sx: this.fc.w / 2 + (x - this.cx) * this.scale, sy: this.fc.h / 2 - (y - this.cy) * this.scale };
  }

  pick(sx, sy) {
    return this.pickAll(sx, sy)[0] || null;
  }

  /** Everything under the pointer (within 14 px): stations and bodies first, then the nearest. */
  pickAll(sx, sy) {
    const out = [], seen = new Set();
    for (const p of this._pickables) {
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
      if (d > 14 * 14 || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ kind: p.kind, id: p.id, d: d - (p.kind === 'body' ? 60 : p.station ? 80 : 0), report: !!p.report });
    }
    return out.sort((a, b) => a.d - b.d).map(({ kind, id, report }) => ({ kind, id, report }));
  }

  _cloudLayer(W, H) {
    let c = this._cloud;
    if (!c || c.bw !== W || c.bh !== H) {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      c = this._cloud = { canvas, ctx, img, buf: new Uint32Array(img.data.buffer), bw: W, bh: H };
    }
    return c;
  }

  // ---- RENDER ----

  /** Reports on the plot (not on our board): where they should be by now. */
  _drawReports(ctx, state, view, sp, drawn, opts, fm) {
    const tracks = state.intel?.tracks;
    if (!tracks) return;
    const now = state.clock.minute;
    const W = this.fc.w, H = this.fc.h, S = this.scale;
    const pick = this._pickables;
    const inView = this._inView || (this._inView = []);
    inView.length = 0;
    for (const id in tracks) {
      if (drawn.has(id)) continue;
      const r = tracks[id];
      if (r.kind === 'chart') continue;            // charted: drawn live
      if (!estimate(state, r, now, _est)) continue;
      if (_est.x < view.x0 || _est.x > view.x1 || _est.y < view.y0 || _est.y > view.y1) continue;
      inView.push(r, _est.x, _est.y, _est.sigmaAU);
    }
    const n = inView.length / 4;
    const crowd = n > 1500;
    if (crowd) {
      const cloud = this._cloudLayer(W, H);
      const { buf, img, bw, bh } = cloud;
      buf.fill(0);
      for (let i = 0; i < inView.length; i += 4) {
        const [x, y] = sp(inView[i + 1], inView[i + 2]);
        const xi = x | 0, yi = y | 0;
        if (xi >= 0 && xi < bw && yi >= 0 && yi < bh) buf[yi * bw + xi] = 0x806A7A8A;   // ABGR, dim
      }
      cloud.ctx.putImageData(img, 0, 0);
      ctx.drawImage(cloud.canvas, 0, 0, W, H);
    }
    for (let i = 0; i < inView.length; i += 4) {
      const r = inView[i];
      const m = marksOf(fm, r.id, r.dark, r.wreck);
      const focus = r.id === opts.targetId || r.id === this.selected?.id || r.id === this.hover?.id || m.flag || m.mission || m.maybe;
      const [x, y] = sp(inView[i + 1], inView[i + 2]);
      if (crowd && !focus) { pick.push({ kind: 'entity', id: r.id, sx: x, sy: y, report: true }); continue; }   // a dot in the cloud, still clickable
      const age = now - r.at;
      const a = Math.max(0.25, 0.75 - 0.5 * age / REPORT_FADE_MIN);
      const col = r.wreck ? '#5E6D7C' : r.faction ? factionColor(r.faction) : COL.text2;
      ctx.globalAlpha = a;
      ctx.strokeStyle = col;
      // (a report is a ring; one of a ship running dark, a broken ring)
      if (m.dark) ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // the circle it could be anywhere inside (only where it tells something)
      const rp = inView[i + 3] * S;
      if (rp > 6 && rp < Math.max(W, H) && (focus || n < 200)) {
        ctx.setLineDash([1, 4]);
        ctx.beginPath(); ctx.arc(x, y, rp, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      if (m.mission) drawMissionMark(ctx, x, y, 8);
      else if (m.maybe) drawMissionMark(ctx, x, y, 8, true);
      if (m.flag) drawFlagMark(ctx, x, y, 5, m.flag, this.labels);
      if (focus || S > 3e4) this.labels.add(`${r.name || 'Track'} · ${ageLabel(age)} old`, x, y, { off: 7, font: UI(11), color: col, alpha: a, pri: (focus ? 5 : 1) + markPri(m), tags: labelTags(m) });
      pick.push({ kind: 'entity', id: r.id, sx: x, sy: y, report: true });
    }
  }

  render(state, opts = {}) {
    const fc = this.fc;
    if (!fc.fit()) return;
    this._ease();
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const days = state.clock.minute / DAY_MIN;
    const S = this.scale;
    const world = getWorld(state);
    if (this.follow === 'ship') { this.cx = state.flight.pos.x; this.cy = state.flight.pos.y; }
    if (this.follow === 'target' && opts.targetPos) { this.cx = opts.targetPos.x; this.cy = opts.targetPos.y; }
    const pick = this._pickables;
    pick.length = 0;
    const L = this.labels;
    L.reset();

    ctx.fillStyle = COL.void;
    ctx.fillRect(0, 0, W, H);

    const view = { x0: this.cx - W / 2 / S, x1: this.cx + W / 2 / S, y0: this.cy - H / 2 / S, y1: this.cy + H / 2 / S };
    const sp = (x, y) => [W / 2 + (x - this.cx) * S, H / 2 - (y - this.cy) * S];
    const [sx0, sy0] = sp(0, 0);
    const inside = (x, y, m = 0) => x >= -m && x <= W + m && y >= -m && y <= H + m;

    // The Belt: the band it is (2.1–3.3 AU), not a spray of dots
    if (S < 4000) {
      const r0 = 2.1 * S, r1 = 3.3 * S;
      ctx.strokeStyle = COL.belt; ctx.lineWidth = r1 - r0;
      ctx.beginPath(); ctx.arc(sx0, sy0, (r0 + r1) / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Distance from the Sun, in AU
    ctx.strokeStyle = COL.ring; ctx.setLineDash([2, 6]);
    for (const r of [0.5, 1, 1.5, 2, 3, 5, 10, 20, 30]) {
      const rp = r * S;
      if (rp < 24 || rp > Math.hypot(W, H) * 4) continue;
      ctx.beginPath(); ctx.arc(sx0, sy0, rp, 0, Math.PI * 2); ctx.stroke();
      L.add(`${r} AU`, sx0, sy0 - rp - 8, { off: 4, font: MONO(10), color: COL.ringText, pri: 0, fixed: true });
    }
    ctx.setLineDash([]);

    // Orbits: hairlines (the minor bodies' dotted)
    for (const b of BODIES) {
      if (!b.a) continue;
      let ox, oy;
      if (b.parent) { bodyPos(b.parent, days, _bp); ox = _bp.x; oy = _bp.y; } else { ox = 0; oy = 0; }
      const rp = b.a * S;
      if (rp < 4) continue;
      const [cx, cy] = sp(ox, oy);
      if (cx + rp < 0 || cx - rp > W || cy + rp < 0 || cy - rp > H) continue;
      if (rp > 20000) continue;   // effectively a straight line through the view; skip
      const minor = b.type === 'asteroid' || b.type === 'moon';
      ctx.strokeStyle = minor ? COL.orbitMinor : COL.orbit;
      ctx.setLineDash(minor ? [1, 4] : []);
      ctx.beginPath(); ctx.arc(cx, cy, rp, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Who holds the space, and where the trouble is
    if (this.showPolitics) {
      for (const src of INFLUENCE_SOURCES) {
        const col = factionColor(src.faction);
        if (src.ring) {
          ctx.strokeStyle = col; ctx.globalAlpha = 0.045 * src.s;
          ctx.lineWidth = Math.max(1, src.ring.w * 1.6 * S);
          ctx.beginPath(); ctx.arc(sx0, sy0, src.ring.a * S, 0, Math.PI * 2); ctx.stroke();
          ctx.lineWidth = 1; ctx.globalAlpha = 1;
          continue;
        }
        bodyPos(getBody(src.body), days, _bp);
        const [cx, cy] = sp(_bp.x, _bp.y);
        const r = src.r * S;
        if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H || r < 2) continue;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.5);
        g.addColorStop(0, col + '1C'); g.addColorStop(1, col + '00');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      // Hot zones we have heard of (news travels at light speed: a zone that
      // ended an hour ago at Ganymede is still on our plot at Ceres)
      const known = state.intel?.zones || {};
      for (const id of Object.keys(known)) {
        const z = known[id];
        if (z.r == null) continue;
        const p = zonePos(z, state.clock.minute);
        const [zx, zy] = sp(p.x, p.y);
        const zr = Math.max(10, z.radius * S);
        if (zx + zr < 0 || zx - zr > W || zy + zr < 0 || zy - zr > H) continue;
        const col = ZONE_COL[z.kind] || COL.caution;
        ctx.fillStyle = col; ctx.globalAlpha = 0.05;
        ctx.beginPath(); ctx.arc(zx, zy, zr, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.75; ctx.strokeStyle = col; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.arc(zx, zy, zr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        L.add(ZONE_KINDS[z.kind].label, zx + zr * 0.72, zy - zr * 0.72 - 6, { off: 5, font: UI(11, 600), color: col, alpha: 0.95, pri: 4, fixed: true });
        L.add(z.body.toUpperCase(), zx + zr * 0.72, zy - zr * 0.72 + 7, { off: 5, font: UI(10), color: COL.text3, pri: 3, fixed: true });
      }
    }

    // The Sun
    {
      const r = Math.max(4, 696_000 / AU_KM * S);
      const g = ctx.createRadialGradient(sx0, sy0, 0, sx0, sy0, r * 2.4);
      g.addColorStop(0, 'rgba(255,244,214,1)'); g.addColorStop(0.4, 'rgba(255,214,120,0.85)'); g.addColorStop(1, 'rgba(255,170,60,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx0, sy0, r * 2.4, 0, Math.PI * 2); ctx.fill();
      pick.push({ kind: 'body', id: 'Sol', sx: sx0, sy: sy0 });
    }

    // A world's space (sim/worlds.js): the one picked, or the one we are in (worldzones.js)
    const zoneWorld = (this.selected?.kind === 'body' && worldOf(this.selected.id)) || worldOf(state.flight.world?.name || '');
    let zoneAt = null;
    if (zoneWorld) {
      bodyPos(zoneWorld.body, days, _bp);
      zoneAt = sp(_bp.x, _bp.y);
      drawWorldZones(ctx, zoneWorld, zoneAt[0], zoneAt[1], S / AU_M, W, H, L, state.clock.minute, 'under');
    }

    // Bodies
    for (const b of BODIES) {
      if (!b.a) continue;
      bodyPos(b, days, _bp);
      const [x, y] = sp(_bp.x, _bp.y);
      if (!inside(x, y, 50)) continue;
      if (b.type === 'moon' && b.parent && b.a * S < 6) continue;          // hidden inside the planet's dot
      const trueR = (b.radius || 0) / AU_KM * S;
      const r = Math.max(b.type === 'planet' ? 3.5 : b.type === 'moon' ? 2 : 1.6, trueR);
      // a dot in its colour; a disc big enough to write over, as a chart draws land: a dark tint of
      // its colour and its limb in it (names, tracks and the airspaces read over it)
      const disc = Math.min(1, Math.max(0, (r - 18) / 60));
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 1 - 0.76 * disc;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (disc > 0) { ctx.strokeStyle = b.color; ctx.globalAlpha = 0.5 + 0.4 * disc; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1; }
      if (b.rings && r > 2) { ctx.strokeStyle = 'rgba(212,196,154,0.45)'; ctx.beginPath(); ctx.ellipse(x, y, r * 2.2, r * 0.6, 0, 0, Math.PI * 2); ctx.stroke(); }
      pick.push({ kind: 'body', id: b.name, sx: x, sy: y });
      if (r < 16) L.block(x - r, y - r, x + r, y + r);
      const showLabel = b.type === 'planet' || (b.type === 'asteroid' && S > 40) || (b.type === 'moon' && b.a * S > 30);
      if (showLabel) {
        const planet = b.type === 'planet';
        L.add(planet ? b.name.toUpperCase() : b.name, x, y, { off: r + 5, font: planet ? UI(12, 600) : UI(11), color: planet ? COL.text2 : COL.text3, pri: planet ? 8 : 3 });
      }
    }

    if (zoneWorld) drawWorldZones(ctx, zoneWorld, zoneAt[0], zoneAt[1], S / AU_M, W, H, L, state.clock.minute, 'over');
    if (zoneWorld) drawShuttleTracks(ctx, state, zoneWorld, zoneAt[0], zoneAt[1], S / AU_M);

    // Entities: only what we know. LIVE contacts on our board and CHARTED
    // things on published orbits are drawn where they are; everything else
    // is a REPORT on the plot (intel.js), drawn where it should be by now,
    // dimmer as it ages, with the circle it could be anywhere inside.
    const drawn = this._drawn || (this._drawn = new Set());
    drawn.clear();
    const live = _q;
    live.length = 0;
    const add = (e) => { if (e && !drawn.has(e.id)) { drawn.add(e.id); live.push(e); } };
    for (const st of world.stations) add(st);
    const fm = frameMarks(state);
    for (const id of fm.missions.keys()) { const e = world.get(id); if (e && liveKnowledge(state, e)) add(e); }
    { const e = opts.targetId && world.get(opts.targetId); if (e && liveKnowledge(state, e)) add(e); }
    for (const c of state.sensors.contacts) add(world.get(c.id));
    for (const e of world.driven) if (e.type === 'ordnance' && e.ord.owner === 'player') add(e);
    const tracks = state.intel?.tracks || {};
    for (const id in tracks) if (tracks[id].kind === 'chart') add(world.get(id));    // wrecks in the news: charted
    for (const e of world.forces) if (e.tags?.command && liveKnowledge(state, e)) add(e);   // the navies' forward commands (FOBs) on their posts: charted
    if (this.showIntel && this.filter.ships) this._drawReports(ctx, state, view, sp, drawn, opts, fm);

    // stations drawn last, over the traffic crowding them; filtered layers left out (but never what is picked)
    live.sort((a, b) => (a.type === 'station') - (b.type === 'station'));
    for (const e of live) {
      if (e.pos.x < view.x0 - 0.01 || e.pos.x > view.x1 + 0.01 || e.pos.y < view.y0 - 0.01 || e.pos.y > view.y1 + 0.01) continue;
      const m = marksOf(fm, e.id, isDark(e), e.tags?.wreck);
      if (e.type === 'nav' && !m.mission && e.id !== opts.targetId) continue;      // (a nav mark is drawn for the work it is for, or picked)
      const keep = e.id === opts.targetId || e.id === this.selected?.id || m.flag || m.mission || m.maybe;
      if (!keep && e.type === 'station' && !this.filter.stations) continue;
      const fob = e.type === 'ship' && !!e.tags?.command;
      if (!keep && e.type === 'ship' && !fob && !this.filter.ships) continue;
      if (!keep && fob && !this.filter.stations && !this.filter.ships) continue;
      const [x, y] = sp(e.pos.x, e.pos.y);
      const color = e.sos ? COL.warn : e.tags?.wreck ? '#5E6D7C' : factionColor(e.faction);
      if (e.type === 'ordnance') {
        const tgt = e.ord.target === 'player' ? state.flight.pos : aimPoint(e, state.clock.minute);
        const c = e.ord.target === 'player' ? COL.warn : e.ord.owner === 'player' ? COL.own : COL.caution;
        if (tgt && e.ord.kind === 'torpedo') {
          const [tx, ty] = sp(tgt.x, tgt.y);
          ctx.strokeStyle = c; ctx.globalAlpha = 0.4; ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
        ctx.fillStyle = c;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        continue;
      }
      if (e.type === 'station') {
        ctx.fillStyle = COL.void; ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(x - 4, y - 4, 8, 8); ctx.lineWidth = 1;
        ctx.fillStyle = color; ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      } else if (fob) {
        // a forward command (FOB): a station of circumstance, drawn as a base (a diamond round a dot) in its navy's colour
        ctx.fillStyle = COL.void;
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = color; ctx.fillRect(x - 2, y - 2, 4, 4);
      } else if (e.type === 'nav') {
        ctx.strokeStyle = COL.caution; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(x, y, Math.max(6, 0.001 * S), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        // (a ship squawking is a solid arrowhead; one running dark, or a wreck, hollow and a size up so it reads)
        const hd = e.thrust > 0 ? e.heading : Math.atan2(e.vel.vy, e.vel.vx);
        const hollow = m.dark || m.wreck, k = hollow ? 1.35 : 1;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(-hd) * 5 * k, y + Math.sin(-hd) * 5 * k);
        ctx.lineTo(x + Math.cos(-hd + 2.5) * 3.5 * k, y + Math.sin(-hd + 2.5) * 3.5 * k);
        ctx.lineTo(x + Math.cos(-hd - 2.5) * 3.5 * k, y + Math.sin(-hd - 2.5) * 3.5 * k);
        ctx.closePath();
        paintMark(ctx, color, hollow, COL.void);
        if (e.thrust > 0) {
          ctx.strokeStyle = 'rgba(216,225,234,0.5)';
          ctx.beginPath(); ctx.moveTo(x - Math.cos(-hd) * 4, y - Math.sin(-hd) * 4); ctx.lineTo(x - Math.cos(-hd) * 12, y - Math.sin(-hd) * 12); ctx.stroke();
        }
      }
      if (e.sos) {
        const ph = (performance.now() / 1000) % 1;
        ctx.strokeStyle = `rgba(239,83,80,${0.7 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(x, y, 6 + ph * 10, 0, Math.PI * 2); ctx.stroke();
      }
      if (m.mission) drawMissionMark(ctx, x, y, e.type === 'station' ? 10 : 9);
      else if (m.maybe) drawMissionMark(ctx, x, y, e.type === 'station' ? 10 : 9, true);
      if (m.flag) drawFlagMark(ctx, x, y, 6, m.flag, L);
      pick.push({ kind: 'entity', id: e.id, sx: x, sy: y, station: e.type === 'station' });
      L.block(x - 4, y - 4, x + 4, y + 4);
      // (named as we know it: a station, a mark, what our work points at, a contact once identified)
      const label = e.type === 'station' || fob || e.sos || e.tags?.missionId || m.mission || m.maybe || m.flag || S > 3e4 || e.id === opts.targetId;
      const named = fob ? `${FACTIONS[e.faction]?.short || e.faction} FOB · ${contactName(state, e.id) || e.name}` : e.type === 'station' || e.type === 'nav' || !!m.mission || contactName(state, e.id);
      if (label) {
        const pri = (e.id === opts.targetId ? 9 : e.sos || e.tags?.missionId ? 7 : e.type === 'station' || fob ? 6 : 2) + markPri(m);
        const font = UI(11, e.type === 'station' ? 600 : 500);
        // (a ship we can't name yet is called what it is to us: DARK, or a WRECK)
        if (named) L.add(named === true ? e.name : named, x, y, { off: 9, font, color: e.type === 'station' ? COL.text : color, alpha: e.type === 'station' ? 0.9 : 0.85, pri, tags: labelTags(m) });
        else if (m.dark || m.wreck) L.add(m.dark ? 'DARK' : 'WRECK', x, y, { off: 9, font, color: m.dark ? MARK_COL.dark : MARK_COL.wreck, alpha: 0.85, pri, tags: labelTags({ mission: m.mission, maybe: m.maybe }) });
      }
    }

    // How far light gets: one light-second (the live window of a fight),
    // one light-minute (about our sensor reach), ten (news across the Belt)
    if (this.showIntel) {
      const [ux, uy] = sp(state.flight.pos.x, state.flight.pos.y);
      ctx.setLineDash([1, 6]);
      for (const [r, txt] of LIGHT_RINGS) {
        const rp = r * S;
        if (rp < 30 || rp > Math.hypot(W, H) * 1.5) continue;
        ctx.strokeStyle = COL.light;
        ctx.beginPath(); ctx.arc(ux, uy, rp, 0, Math.PI * 2); ctx.stroke();
        L.add(txt.toLowerCase(), ux + rp * 0.71, uy - rp * 0.71 - 8, { off: 4, font: MONO(10), color: COL.lightText, pri: 0, fixed: true });
      }
      ctx.setLineDash([]);
    }

    // The route under way (magenta), and the one being planned (cyan, dashed)
    const drawPath = (path, color, dash, width) => {
      if (!path || path.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath();
      path.forEach((p, i) => { const [x, y] = sp(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    drawPath(this.routePath, COL.route, [], 2);
    drawPath(this.preview, COL.sel, [7, 5], 1.5);

    // Our ship: where it points, and where it is going (an hour of coasting)
    {
      const f = state.flight;
      const [x, y] = sp(f.pos.x, f.pos.y);
      const vx = f.vel.vx * 3600 / 1000 / AU_KM * S, vy = f.vel.vy * 3600 / 1000 / AU_KM * S;
      const vl = Math.hypot(vx, vy);
      if (vl > 3) {
        const k = Math.min(1, 160 / vl);
        ctx.strokeStyle = COL.own; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + vx * k, y - vy * k); ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = COL.void;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.own;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(-f.facing) * 7, y + Math.sin(-f.facing) * 7);
      ctx.lineTo(x + Math.cos(-f.facing + 2.5) * 5.5, y + Math.sin(-f.facing + 2.5) * 5.5);
      ctx.lineTo(x + Math.cos(-f.facing - 2.5) * 5.5, y + Math.sin(-f.facing - 2.5) * 5.5);
      ctx.closePath(); ctx.fill();
      L.block(x - 9, y - 9, x + 9, y + 9);
      L.add(ourName(state), x, y, { off: 12, font: UI(12, 600), color: COL.own, pri: 100 });
    }

    // Every name, most important first, none over another (labels.js); the
    // foot of the display is the readouts' and the scale bar's
    L.block(0, H - 26, W, H);
    L.draw(ctx, W, H);

    // Hover, and a target box round the selection
    const at = (sel) => sel && this._pickables.find(q => q.kind === sel.kind && q.id === sel.id);
    const hv = at(this.hover);
    if (hv && (!this.selected || this.hover.id !== this.selected.id)) {
      ctx.strokeStyle = 'rgba(62,199,230,0.45)';
      ctx.beginPath(); ctx.arc(hv.sx, hv.sy, 10, 0, Math.PI * 2); ctx.stroke();
      // what it is, beside it (the display's own tooltip)
      const label = opts.hoverLabel?.(this.hover);
      if (label) {
        ctx.font = UI(12, 500);
        const w = ctx.measureText(label).width + 14, h = 22;
        const lx = Math.min(hv.sx + 14, W - w - 6), ly = Math.max(6, hv.sy - h - 8);
        ctx.fillStyle = 'rgba(18,26,35,0.96)'; ctx.fillRect(lx, ly, w, h);
        ctx.strokeStyle = '#2A3846'; ctx.strokeRect(lx + 0.5, ly + 0.5, w - 1, h - 1);
        ctx.fillStyle = COL.text; ctx.fillText(label, lx + 7, ly + 15);
      }
    }
    const sl = at(this.selected);
    if (sl) {
      const r = 12, c = 5;
      ctx.strokeStyle = COL.sel; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = sl.sx + dx * r, cy = sl.sy + dy * r;
        ctx.moveTo(cx - dx * c, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - dy * c);
      }
      ctx.stroke(); ctx.lineWidth = 1;
    }

    // Scale bar
    const targetPx = 120;
    const raw = targetPx / S * AU_KM;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const nice = [1, 2, 5, 10].map(k => k * pow).find(v => v >= raw * 0.6) || pow;
    const len = nice / AU_KM * S;
    const bx = W - 24 - len, by = H - 18;
    ctx.strokeStyle = COL.text3;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + len, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + len, by - 4); ctx.lineTo(bx + len, by + 4); ctx.stroke();
    ctx.fillStyle = COL.text2; ctx.font = MONO(10);
    const lbl = fmtKm(nice);
    ctx.fillText(lbl, bx + len / 2 - ctx.measureText(lbl).width / 2, by - 7);
  }
}


/** "12 min", "5 h", "3 d": how old a report is. */
export function ageLabel(min) {
  if (min < 90) return `${Math.max(0, Math.round(min))} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}
