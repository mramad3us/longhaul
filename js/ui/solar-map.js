// ============================================================
// LONGHAUL — Solar map (canvas)
// Pan / zoom from the whole system down to a few hundred km. Bodies
// are drawn from the ephemeris; entities come from a spatial query of
// the viewport (huge populations fall back to a point cloud).
// ============================================================

import { AU_KM, DAY_MIN } from '../core/constants.js';
import { BODIES, bodyPos } from '../sim/ephemeris.js';
import { getWorld } from '../sim/world.js';
import { FACTION_COLORS } from '../sim/entities.js';
import { FitCanvas, fmtKm } from './dom.js';

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
  constructor(container, { onSelect, onHover } = {}) {
    this.fc = new FitCanvas(container, { className: 'map-canvas' });
    this.cx = 0; this.cy = 0;           // view center, AU
    this.scale = 60;                    // px per AU
    this.follow = 'ship';               // 'ship' | 'target' | null
    this.selected = null;               // { kind, id }
    this.hover = null;
    this.preview = null;                // [{x,y}] planned path to draw
    this.routePath = null;              // active route predicted path
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
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
        const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
        this.selected = hit;
        this.onSelect(hit);
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
    let best = null, bd = 14 * 14;
    for (const p of this._pickables) {
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { kind: best.kind, id: best.id } : null;
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

    // Entities in view
    _q.length = 0;
    world.queryRect(view.x0, view.y0, view.x1, view.y1, _q);
    const important = (e) => e.type === 'station' || e.sos || e.tags?.missionId || e.tags?.contract || e.id === opts.targetId || e.id === opts.lockedId || !e.tags?.traffic;
    const many = _q.length > 2500;
    if (many) {
      // Point cloud for the crowd (pixel writes on an offscreen layer, composited
      // over the map); vector glyphs only for what matters.
      const cloud = this._cloudLayer(W, H);
      const { buf, img, bw, bh } = cloud;
      buf.fill(0);
      const plume = 0xFFFFE0C0, coast = 0xFF8A7A6A;   // ABGR
      for (const e of _q) {
        if (important(e)) continue;
        const x = (W / 2 + (e.pos.x - this.cx) * S) | 0;
        const y = (H / 2 - (e.pos.y - this.cy) * S) | 0;
        if (x >= 0 && x < bw && y >= 0 && y < bh) buf[y * bw + x] = e.thrust > 0 ? plume : coast;
      }
      cloud.ctx.putImageData(img, 0, 0);
      ctx.drawImage(cloud.canvas, 0, 0, W, H);
    }
    for (const e of _q) {
      if (e.type === 'nav' && !opts.showNav?.has(e.id)) continue;
      if (many && !important(e)) continue;
      const [x, y] = sp(e.pos.x, e.pos.y);
      const color = e.sos ? '#FF5555' : (FACTION_COLORS[e.faction] || '#8A8A6A');
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
      pick.push({ kind: 'entity', id: e.id, sx: x, sy: y });
      const label = e.type === 'station' || e.sos || e.tags?.missionId || e.tags?.contract || S > 3e4 || e.id === opts.targetId;
      if (label && (e.transponder || e.type === 'nav' || e.id === opts.targetId)) {
        ctx.fillStyle = color; ctx.globalAlpha = 0.8; ctx.font = font(10);
        ctx.fillText(e.name, x + 8, y + 3);
        ctx.globalAlpha = 1;
      }
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

