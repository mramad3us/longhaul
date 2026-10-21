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
// ============================================================

import { AU_KM, DAY_MIN } from '../core/constants.js';
import { BODIES, bodyPos } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { factionColor, INFLUENCE_SOURCES } from '../sim/factions.js';
import { zonePos, ZONE_KINDS } from '../sim/conflict.js';
import { getBody } from '../sim/ephemeris.js';
import { estimate, liveKnowledge, LIGHT_SECOND_AU, LIGHT_MINUTE_AU } from '../sim/intel.js';
import { FitCanvas, fmtKm } from './dom.js';

const LIGHT_RINGS = [[LIGHT_SECOND_AU, '1 LIGHT-SEC'], [LIGHT_MINUTE_AU, '1 LIGHT-MIN'], [LIGHT_MINUTE_AU * 10, '10 LIGHT-MIN']];
const REPORT_FADE_MIN = 3 * 1440;   // a report is drawn faintest at this age
const _est = { x: 0, y: 0, sigmaAU: 0 };

/** The name a contact goes by on our board (null until identified). */
function contactName(state, id) {
  for (const c of state.sensors.contacts) if (c.id === id) return c.name;
  return null;
}

const MIN_SCALE = 6;          // px per AU (whole system)
const MAX_SCALE = 4e8;        // px per AU (~0.4 km per px)
const _q = [];
const _bp = { x: 0, y: 0 };

// Fixed starfield (screen space)
const STARS = Array.from({ length: 220 }, (_, i) => ({
  x: (Math.sin(i * 127.1 + 311.7) * 0.5 + 0.5),
  y: (Math.sin(i * 269.5 + 183.3) * 0.5 + 0.5),
  a: 0.12 + (Math.sin(i * 43.7) * 0.5 + 0.5) * 0.4,
  s: Math.sin(i * 91.3) > 0.7 ? 2 : 1,
}));
// Asteroid belt dust (orbital elements, drawn rotating with time)
const DUST = Array.from({ length: 900 }, (_, i) => {
  const r = 2.1 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 1.25;
  return { r, a: (i * 2.39996) % (Math.PI * 2), w: 1 / Math.pow(r, 1.5) };
});

export class SolarMap {
  constructor(container, { onSelect, onHover, onPickList } = {}) {
    this.fc = new FitCanvas(container, { className: 'map-canvas' });
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
    if (scale) this.scale = scale;
  }

  _bind(el) {
    let drag = null;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const before = this.toWorld(mx, my);
      const k = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * k));
      const after = this.toWorld(mx, my);
      // keep the point under the cursor fixed (unless following, then just zoom)
      if (!this.follow) { this.cx += before.x - after.x; this.cy += before.y - after.y; }
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
          el.style.cursor = 'grabbing';
        }
      } else {
        const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
        const key = hit ? `${hit.kind}:${hit.id}` : null;
        if (key !== (this.hover ? `${this.hover.kind}:${this.hover.id}` : null)) {
          this.hover = hit;
          this.onHover(hit);
        }
        el.style.cursor = hit ? 'pointer' : 'grab';
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
      el.style.cursor = 'grab';
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
  _drawReports(ctx, state, view, sp, drawn, opts) {
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
    const font = (px) => `${px}px "Share Tech Mono", monospace`;
    for (let i = 0; i < inView.length; i += 4) {
      const r = inView[i];
      const focus = r.id === opts.targetId || r.id === this.selected?.id || r.id === this.hover?.id;
      const [x, y] = sp(inView[i + 1], inView[i + 2]);
      if (crowd && !focus) { pick.push({ kind: 'entity', id: r.id, sx: x, sy: y, report: true }); continue; }   // a dot in the cloud, still clickable
      const age = now - r.at;
      const a = Math.max(0.25, 0.75 - 0.5 * age / REPORT_FADE_MIN);
      const col = r.wreck ? '#5A5A5A' : r.faction ? factionColor(r.faction) : '#8A9AAA';
      ctx.globalAlpha = a;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
      // the circle it could be anywhere inside (only where it tells something)
      const rp = inView[i + 3] * S;
      if (rp > 6 && rp < Math.max(W, H) && (focus || n < 200)) {
        ctx.setLineDash([1, 4]);
        ctx.beginPath(); ctx.arc(x, y, rp, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (focus || S > 3e4) {
        ctx.fillStyle = col; ctx.font = font(10);
        ctx.fillText(`${r.name || 'TRACK'} · ${ageLabel(age)}`, x + 7, y + 3);
      }
      ctx.globalAlpha = 1;
      pick.push({ kind: 'entity', id: r.id, sx: x, sy: y, report: true });
    }
  }

  render(state, opts = {}) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const days = state.clock.minute / DAY_MIN;
    const S = this.scale;
    const world = getWorld(state);
    if (this.follow === 'ship') { this.cx = state.flight.pos.x; this.cy = state.flight.pos.y; }
    if (this.follow === 'target' && opts.targetPos) { this.cx = opts.targetPos.x; this.cy = opts.targetPos.y; }
    const pick = this._pickables;
    pick.length = 0;

    ctx.fillStyle = '#030810';
    ctx.fillRect(0, 0, W, H);
    for (const s of STARS) { ctx.fillStyle = `rgba(255,255,255,${s.a})`; ctx.fillRect(s.x * W | 0, s.y * H | 0, s.s, s.s); }

    const view = { x0: this.cx - W / 2 / S, x1: this.cx + W / 2 / S, y0: this.cy - H / 2 / S, y1: this.cy + H / 2 / S };
    const sp = (x, y) => [W / 2 + (x - this.cx) * S, H / 2 - (y - this.cy) * S];
    const font = (px) => `${px}px "Share Tech Mono", monospace`;

    // Distance rings
    ctx.strokeStyle = 'rgba(26,42,58,0.9)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    const [sx0, sy0] = sp(0, 0);
    for (const r of [0.5, 1, 1.5, 2, 3, 5, 10, 20, 30]) {
      const rp = r * S;
      if (rp < 20 || rp > Math.hypot(W, H) * 4) continue;
      ctx.beginPath(); ctx.arc(sx0, sy0, rp, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(42,74,90,0.9)'; ctx.font = font(10);
      ctx.fillText(`${r} AU`, sx0 + 4, sy0 - rp + 12);
    }
    ctx.setLineDash([]);

    // Belt dust
    if (S < 2000 && S > 15) {
      ctx.fillStyle = 'rgba(140,130,110,0.35)';
      for (const d of DUST) {
        const a = d.a + days * d.w * 0.0172;
        const [x, y] = sp(d.r * Math.cos(a), d.r * Math.sin(a));
        if (x >= 0 && x < W && y >= 0 && y < H) ctx.fillRect(x | 0, y | 0, 1, 1);
      }
    }

    // Orbits
    ctx.lineWidth = 1;
    for (const b of BODIES) {
      if (!b.a) continue;
      let ox, oy;
      if (b.parent) { bodyPos(b.parent, days, _bp); ox = _bp.x; oy = _bp.y; } else { ox = 0; oy = 0; }
      const rp = b.a * S;
      if (rp < 3) continue;
      const [cx, cy] = sp(ox, oy);
      if (cx + rp < 0 || cx - rp > W || cy + rp < 0 || cy - rp > H) continue;
      if (rp > 20000) continue;   // effectively a straight line through the view; skip
      ctx.strokeStyle = b.type === 'asteroid' ? 'rgba(18,31,42,1)' : b.type === 'moon' ? 'rgba(42,74,90,0.6)' : 'rgba(21,37,53,1)';
      ctx.setLineDash(b.type === 'asteroid' || b.type === 'moon' ? [2, 4] : []);
      ctx.beginPath(); ctx.arc(cx, cy, rp, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Spheres of influence: each source as a soft disc in its power's color
    if (this.showPolitics) {
      for (const src of INFLUENCE_SOURCES) {
        let cx, cy, r;
        const col = factionColor(src.faction);
        if (src.ring) {
          ctx.strokeStyle = col; ctx.globalAlpha = 0.07 * src.s;
          ctx.lineWidth = Math.max(1, src.ring.w * 1.6 * S);
          ctx.beginPath(); ctx.arc(sx0, sy0, src.ring.a * S, 0, Math.PI * 2); ctx.stroke();
          ctx.lineWidth = 1; ctx.globalAlpha = 1;
          continue;
        }
        bodyPos(getBody(src.body), days, _bp);
        [cx, cy] = sp(_bp.x, _bp.y);
        r = src.r * S;
        if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H || r < 2) continue;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.5);
        g.addColorStop(0, col + '30'); g.addColorStop(1, col + '00');
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
        const zr = Math.max(8, z.radius * S);
        if (zx + zr < 0 || zx - zr > W || zy + zr < 0 || zy - zr > H) continue;
        const col = z.kind === 'pirates' ? '#C05AA0' : z.kind === 'skirmish' ? '#FF5555' : z.kind === 'insurgency' ? '#E2A355' : '#E8D56B';
        ctx.strokeStyle = col; ctx.globalAlpha = 0.65; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(zx, zy, zr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.font = font(10);
        ctx.fillText(`${ZONE_KINDS[z.kind].label} · ${z.body}`, zx + zr * 0.72 + 4, zy - zr * 0.72);
        ctx.globalAlpha = 1;
      }
    }

    // Sun
    {
      const r = Math.max(4, 696_000 / AU_KM * S);
      const g = ctx.createRadialGradient(sx0, sy0, 0, sx0, sy0, r * 4);
      g.addColorStop(0, 'rgba(255,248,224,1)'); g.addColorStop(0.25, 'rgba(253,184,19,0.9)'); g.addColorStop(1, 'rgba(192,96,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx0, sy0, r * 4, 0, Math.PI * 2); ctx.fill();
      pick.push({ kind: 'body', id: 'Sol', sx: sx0, sy: sy0 });
    }

    // Bodies
    for (const b of BODIES) {
      if (!b.a) continue;
      bodyPos(b, days, _bp);
      const [x, y] = sp(_bp.x, _bp.y);
      if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
      if (b.type === 'moon' && b.parent && b.a * S < 6) continue;          // hidden inside the planet's dot
      const trueR = (b.radius || 0) / AU_KM * S;
      const r = Math.max(b.type === 'planet' ? 3.5 : b.type === 'moon' ? 2 : 1.6, trueR);
      ctx.fillStyle = b.color;
      if (b.type === 'asteroid' && r < 4) {
        ctx.beginPath(); ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        if (b.rings && r > 2) { ctx.strokeStyle = 'rgba(212,196,154,0.5)'; ctx.beginPath(); ctx.ellipse(x, y, r * 2.2, r * 0.6, 0, 0, Math.PI * 2); ctx.stroke(); }
      }
      pick.push({ kind: 'body', id: b.name, sx: x, sy: y });
      const showLabel = b.type === 'planet' || (b.type === 'asteroid' && S > 40) || (b.type === 'moon' && b.a * S > 30);
      if (showLabel) {
        ctx.fillStyle = b.color; ctx.globalAlpha = 0.75; ctx.font = font(b.type === 'planet' ? 11 : 10);
        ctx.fillText(b.type === 'planet' ? b.name.toUpperCase() : b.name, x + r + 4, y + 3);
        ctx.globalAlpha = 1;
      }
    }

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
    if (opts.showNav) for (const id of opts.showNav) add(world.get(id));
    for (const c of state.contracts.active) { const e = world.get(c.targetId); if (e && liveKnowledge(state, e)) add(e); }
    for (const c of state.sensors.contacts) add(world.get(c.id));
    for (const e of world.driven) if (e.type === 'ordnance' && e.ord.owner === 'player') add(e);
    const tracks = state.intel?.tracks || {};
    for (const id in tracks) if (tracks[id].kind === 'chart') add(world.get(id));    // wrecks in the news: charted
    if (this.showIntel && this.filter.ships) this._drawReports(ctx, state, view, sp, drawn, opts);

    // stations drawn last, over the traffic crowding them; filtered layers left out (but never what is picked)
    live.sort((a, b) => (a.type === 'station') - (b.type === 'station'));
    for (const e of live) {
      if (e.pos.x < view.x0 - 0.01 || e.pos.x > view.x1 + 0.01 || e.pos.y < view.y0 - 0.01 || e.pos.y > view.y1 + 0.01) continue;
      if (e.type === 'nav' && !opts.showNav?.has(e.id)) continue;
      const keep = e.id === opts.targetId || e.id === this.selected?.id;
      if (!keep && e.type === 'station' && !this.filter.stations) continue;
      if (!keep && e.type === 'ship' && !this.filter.ships) continue;
      const [x, y] = sp(e.pos.x, e.pos.y);
      const color = e.sos ? '#FF5555' : e.tags?.wreck ? '#5A5A5A' : factionColor(e.faction);
      if (e.type === 'ordnance') {
        const tgt = e.ord.target === 'player' ? state.flight.pos : world.get(e.ord.target)?.pos;
        const c = e.ord.target === 'player' ? 'rgba(255,85,85,' : e.ord.owner === 'player' ? 'rgba(79,209,197,' : 'rgba(226,163,85,';
        if (tgt && e.ord.kind === 'torpedo') {
          const [tx, ty] = sp(tgt.x, tgt.y);
          ctx.strokeStyle = c + '0.35)'; ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.fillStyle = c + '1)';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        continue;
      }
      if (e.type === 'station') {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill();
      } else if (e.type === 'nav') {
        ctx.strokeStyle = '#E8D56B'; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(x, y, Math.max(6, 0.001 * S), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        const hd = e.thrust > 0 ? e.heading : Math.atan2(e.vel.vy, e.vel.vx);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(-hd) * 5, y + Math.sin(-hd) * 5);
        ctx.lineTo(x + Math.cos(-hd + 2.5) * 3.5, y + Math.sin(-hd + 2.5) * 3.5);
        ctx.lineTo(x + Math.cos(-hd - 2.5) * 3.5, y + Math.sin(-hd - 2.5) * 3.5);
        ctx.closePath(); ctx.fill();
        if (e.thrust > 0) {
          ctx.strokeStyle = 'rgba(200,220,255,0.6)';
          ctx.beginPath(); ctx.moveTo(x - Math.cos(-hd) * 4, y - Math.sin(-hd) * 4); ctx.lineTo(x - Math.cos(-hd) * 12, y - Math.sin(-hd) * 12); ctx.stroke();
        }
      }
      if (e.sos) {
        const ph = (performance.now() / 1000) % 1;
        ctx.strokeStyle = `rgba(255,68,68,${0.7 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(x, y, 6 + ph * 10, 0, Math.PI * 2); ctx.stroke();
      }
      pick.push({ kind: 'entity', id: e.id, sx: x, sy: y, station: e.type === 'station' });
      const label = e.type === 'station' || e.sos || e.tags?.missionId || e.tags?.contract || S > 3e4 || e.id === opts.targetId;
      const named = e.type === 'station' || e.type === 'nav' || e.tags?.contract || contactName(state, e.id);
      if (label && named) {
        ctx.fillStyle = color; ctx.globalAlpha = 0.8; ctx.font = font(10);
        ctx.fillText(named === true ? e.name : named, x + 8, y + 3);
        ctx.globalAlpha = 1;
      }
    }

    // How far light gets: one light-second (the live window of a fight),
    // one light-minute (about our sensor reach), ten (news across the Belt)
    if (this.showIntel) {
      const [ux, uy] = sp(state.flight.pos.x, state.flight.pos.y);
      ctx.setLineDash([1, 5]);
      for (const [r, txt] of LIGHT_RINGS) {
        const rp = r * S;
        if (rp < 24 || rp > Math.hypot(W, H) * 1.5) continue;
        ctx.strokeStyle = 'rgba(232,213,107,0.28)';
        ctx.beginPath(); ctx.arc(ux, uy, rp, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(232,213,107,0.55)'; ctx.font = font(9);
        ctx.fillText(txt, ux + rp * 0.71 + 3, uy - rp * 0.71 - 3);
      }
      ctx.setLineDash([]);
    }

    // Planned paths
    const drawPath = (path, color, dash) => {
      if (!path || path.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
      ctx.beginPath();
      path.forEach((p, i) => { const [x, y] = sp(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    drawPath(this.routePath, 'rgba(226,85,85,0.75)', []);
    drawPath(this.preview, 'rgba(79,209,197,0.8)', [6, 4]);

    // Our ship
    {
      const f = state.flight;
      const [x, y] = sp(f.pos.x, f.pos.y);
      const ph = (performance.now() / 1000) % 2 / 2;
      ctx.fillStyle = `rgba(79,209,197,${0.15 + 0.2 * Math.sin(ph * Math.PI)})`;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4FD1C5';
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(-f.facing) * 7, y + Math.sin(-f.facing) * 7);
      ctx.lineTo(x + Math.cos(-f.facing + 2.5) * 5, y + Math.sin(-f.facing + 2.5) * 5);
      ctx.lineTo(x + Math.cos(-f.facing - 2.5) * 5, y + Math.sin(-f.facing - 2.5) * 5);
      ctx.closePath(); ctx.fill();
      ctx.font = font(11);
      ctx.fillText(state.ship.name.toUpperCase(), x + 10, y - 8);
    }

    // Hover + selection rings
    const ring = (sel, color, dash, r) => {
      if (!sel) return;
      const p = this._pickables.find(q => q.kind === sel.kind && q.id === sel.id);
      if (!p) return;
      ctx.strokeStyle = color; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    };
    ring(this.hover, 'rgba(79,209,197,0.4)', [], 11);
    ring(this.selected, '#4FD1C5', [4, 3], 14 + Math.sin(performance.now() / 300) * 1.5);

    // Scale bar
    const targetPx = 120;
    const raw = targetPx / S * AU_KM;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const nice = [1, 2, 5, 10].map(k => k * pow).find(v => v >= raw * 0.6) || pow;
    const len = nice / AU_KM * S;
    ctx.strokeStyle = 'rgba(79,209,197,0.6)';
    ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + len, H - 16); ctx.moveTo(14, H - 20); ctx.lineTo(14, H - 12); ctx.moveTo(14 + len, H - 20); ctx.lineTo(14 + len, H - 12); ctx.stroke();
    ctx.fillStyle = 'rgba(79,209,197,0.8)'; ctx.font = font(10);
    ctx.fillText(fmtKm(nice), 18 + len, H - 12);
  }
}


/** "12 min", "5 h", "3 d": how old a report is. */
export function ageLabel(min) {
  if (min < 90) return `${Math.max(0, Math.round(min))} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}
