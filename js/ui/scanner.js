// ============================================================
// LONGHAUL — Sensor display
// Nose-up, ship-centred; contacts from the sim's sensor picture: the
// fused board, so no sweeping beam (nothing on the ship scans in a
// circle), range rings in the band's units, bearing ticks, contacts in
// their faction's colours, a target box round the selection, the lock
// as an amber ring, what is coming at us in red with its time to impact.
// ============================================================

import { AU_KM } from '../core/constants.js';
import { SENSOR_RANGES } from '../sim/sensors.js';
import { factionColor } from '../sim/factions.js';
import { getWorld } from '../sim/world.js';
import { PLAYER } from '../sim/combatants.js';
import { timeToGo } from '../sim/ordnance.js';
import { hostilesOfPlayer } from '../sim/agents.js';
import { formatDuration } from '../core/clock.js';
import { FitCanvas, fmtKm } from './dom.js';

const C = { void: '#05070A', line: '#1C2632', line2: '#2A3846', text: '#D8E1EA', text2: '#94A3B2', text3: '#5E6D7C', own: '#5FD38D', sel: '#3EC7E6', caution: '#F0A93A', warn: '#EF5350' };
const UI = (px, w = 500) => `${w} ${px}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`;
const MONO = (px) => `${px}px "IBM Plex Mono", ui-monospace, monospace`;

export class ScannerView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'scanner-canvas' });
    this.onSelect = onSelect || (() => {});
    this._hits = [];
    container.addEventListener('pointerdown', (e) => {
      const r = container.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 18 * 18;
      for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h; } }
      this.onSelect(best ? best.id : null);
    });
  }

  render(state) {
    const fc = this.fc;
    if (!fc.fit()) return;
    const ctx = fc.ctx, W = fc.w, H = fc.h;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(cx, cy) - 30;
    const s = state.sensors;
    const band = SENSOR_RANGES[s.range];
    const t = performance.now() / 1000;
    this._hits.length = 0;

    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, W, H);
    if (state.reactor.blackout) return;

    // Range rings and the ship's axes (the display is nose-up)
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = i === 3 ? C.line2 : C.line;
      ctx.beginPath(); ctx.arc(cx, cy, R * i / 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.text3; ctx.font = MONO(10); ctx.textAlign = 'left';
      ctx.fillText(fmtKm(band.au * AU_KM * i / 3), cx + R * i / 3 + 4, cy - 4);
    }
    ctx.strokeStyle = C.line;
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.setLineDash([]);
    // bearing ticks every 30°
    for (let a = 0; a < 360; a += 30) {
      const r = a * Math.PI / 180;
      ctx.strokeStyle = C.line2;
      ctx.beginPath(); ctx.moveTo(cx + Math.sin(r) * R, cy - Math.cos(r) * R); ctx.lineTo(cx + Math.sin(r) * (R + 6), cy - Math.cos(r) * (R + 6)); ctx.stroke();
      if (a % 90 === 0) { ctx.fillStyle = C.text3; ctx.font = MONO(10); ctx.textAlign = 'center'; ctx.fillText(a === 0 ? 'NOSE' : `${a}°`, cx + Math.sin(r) * (R + 16), cy - Math.cos(r) * (R + 16) + 3); }
    }

    // Our ship
    ctx.fillStyle = C.own;
    ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4); ctx.closePath(); ctx.fill();

    const facing = state.flight.facing;
    const world = getWorld(state);
    const hostile = new Set(hostilesOfPlayer(state).map(e => e.id));
    for (const c of s.contacts) {
      const frac = Math.min(1, c.dist / band.au);
      const rel = c.bearing - facing;                    // relative bearing (0 = nose, + = port)
      const px = cx - Math.sin(rel) * frac * R;
      const py = cy - Math.cos(rel) * frac * R;
      if (c.ordnance) {
        // Ordnance: a small diamond — red when it is coming for us
        const o = world.get(c.id)?.ord;
        const inbound = o?.target === PLAYER;
        ctx.fillStyle = inbound ? C.warn : o?.owner === PLAYER ? C.own : C.caution;
        ctx.beginPath(); ctx.moveTo(px, py - 4); ctx.lineTo(px + 3, py); ctx.lineTo(px, py + 4); ctx.lineTo(px - 3, py); ctx.closePath(); ctx.fill();
        if (inbound) {
          const eta = timeToGo(state, world.get(c.id));
          ctx.font = MONO(11); ctx.textAlign = 'left';
          ctx.fillText(`${c.name} ${isFinite(eta) ? formatDuration(eta / 60) : ''}`, px + 7, py + 4);
        }
        this._hits.push({ id: c.id, x: px, y: py });
        continue;
      }
      const color = c.sos ? C.warn : c.faction ? factionColor(c.faction) : c.station ? C.text : C.text2;
      const sz = c.station ? 4 : 3;
      if (hostile.has(c.id)) {
        ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5;
        ctx.strokeRect(px - sz - 4, py - sz - 4, (sz + 4) * 2, (sz + 4) * 2);
        ctx.lineWidth = 1;
      }
      if (state.combat.target === c.id) {
        ctx.strokeStyle = C.warn;
        ctx.beginPath(); ctx.moveTo(px - 12, py); ctx.lineTo(px - 6, py); ctx.moveTo(px + 6, py); ctx.lineTo(px + 12, py);
        ctx.moveTo(px, py - 12); ctx.lineTo(px, py - 6); ctx.moveTo(px, py + 6); ctx.lineTo(px, py + 12); ctx.stroke();
      }
      if (c.sos) {
        const ph = (t % 2) / 2;
        ctx.strokeStyle = `rgba(239,83,80,${0.6 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(px, py, sz + ph * 16, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = color;
      if (c.station) ctx.fillRect(px - sz, py - sz, sz * 2, sz * 2);
      else { ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI * 2); ctx.fill(); }
      if (c.plume) { ctx.strokeStyle = color; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(px, py, sz + 3, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
      if (s.selected === c.id) {
        const r = sz + 8, k = 4;
        ctx.strokeStyle = C.sel; ctx.lineWidth = 1.5; ctx.beginPath();
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const qx = px + dx * r, qy = py + dy * r; ctx.moveTo(qx - dx * k, qy); ctx.lineTo(qx, qy); ctx.lineTo(qx, qy - dy * k); }
        ctx.stroke(); ctx.lineWidth = 1;
      }
      if (s.locked === c.id) {
        ctx.strokeStyle = C.caution; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.arc(px, py, sz + 11, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      const label = c.name || c.signature || 'Unknown';
      if (frac < 0.9 && s.contacts.length < 60) {
        ctx.fillStyle = color; ctx.globalAlpha = 0.85; ctx.font = UI(11); ctx.textAlign = 'left';
        ctx.fillText(label + (c.sos ? '  SOS' : ''), px + sz + 5, py + 4);
        ctx.globalAlpha = 1;
      }
      this._hits.push({ id: c.id, x: px, y: py });
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = C.text; ctx.font = UI(12, 600);
    ctx.fillText(`${band.name} RANGE · ${band.label}`, 12, 20);
    ctx.fillStyle = C.text3; ctx.font = UI(11);
    ctx.fillText(band.description, 12, 35);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.text2; ctx.font = MONO(11);
    ctx.fillText(`${s.contacts.length} contact${s.contacts.length === 1 ? '' : 's'}`, W - 12, 20);
  }
}
