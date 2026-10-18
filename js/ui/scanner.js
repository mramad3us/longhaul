// ============================================================
// LONGHAUL — Sensor display (canvas radar)
// Nose-up, ship-centred; contacts from the sim's sensor picture.
// ============================================================

import { AU_KM } from '../core/constants.js';
import { SENSOR_RANGES } from '../sim/sensors.js';
import { FACTION_COLORS } from '../sim/entities.js';
import { FitCanvas, fmtKm } from './dom.js';

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
    const R = Math.min(cx, cy) - 24;
    const s = state.sensors;
    const band = SENSOR_RANGES[s.range];
    const t = performance.now() / 1000;
    this._hits.length = 0;

    ctx.fillStyle = '#080C0F';
    ctx.fillRect(0, 0, W, H);
    if (state.reactor.blackout) {
      ctx.fillStyle = '#331111'; ctx.font = '10px "Press Start 2P", monospace'; ctx.textAlign = 'center';
      ctx.fillText('SENSORS OFFLINE — NO POWER', cx, cy);
      return;
    }

    // Rings, cross-hairs, sweep
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = `rgba(26,58,74,${0.5 + i * 0.15})`;
      ctx.beginPath(); ctx.arc(cx, cy, R * i / 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#3A6A7A'; ctx.font = '10px "Share Tech Mono", monospace'; ctx.textAlign = 'left';
      ctx.fillText(fmtKm(band.au * AU_KM * i / 3), cx + R * i / 3 + 3, cy - 3);
    }
    ctx.strokeStyle = 'rgba(26,58,74,0.7)';
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // Sweep turns clockwise; the afterglow trails behind the beam, brightest at the beam itself
    const sweep = (t * 0.8) % (Math.PI * 2);
    const TRAIL = 0.6;                                   // radians of afterglow
    const beam = sweep - Math.PI / 2;                    // canvas angle of the beam (0 = east)
    const g = ctx.createConicGradient ? ctx.createConicGradient(beam - TRAIL, cx, cy) : null;
    if (g) {
      const f = TRAIL / (Math.PI * 2);
      g.addColorStop(0, 'rgba(79,209,197,0)'); g.addColorStop(f * 0.999, 'rgba(79,209,197,0.2)');
      g.addColorStop(f, 'rgba(79,209,197,0)'); g.addColorStop(1, 'rgba(79,209,197,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(79,209,197,0.45)';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(beam) * R, cy + Math.sin(beam) * R); ctx.stroke();
    }

    // Own ship
    ctx.fillStyle = '#4FD1C5';
    ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4); ctx.closePath(); ctx.fill();
    ctx.font = '8px "Press Start 2P", monospace'; ctx.textAlign = 'center';
    ctx.fillText('FWD', cx, cy - R - 8);

    const facing = state.flight.facing;
    for (const c of s.contacts) {
      const frac = Math.min(1, c.dist / band.au);
      const rel = c.bearing - facing;                    // relative bearing (0 = nose, + = port)
      const px = cx - Math.sin(rel) * frac * R;
      const py = cy - Math.cos(rel) * frac * R;
      const color = c.sos ? '#E25555' : c.faction ? (FACTION_COLORS[c.faction] || '#8A8A6A') : c.station ? '#4FD1C5' : '#8A8A6A';
      const sz = c.station ? 4 : 3;
      if (c.sos) {
        const ph = (t % 2) / 2;
        ctx.strokeStyle = `rgba(226,85,85,${0.6 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(px, py, sz + ph * 16, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI * 2); ctx.fill();
      if (c.plume) { ctx.strokeStyle = color; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(px, py, sz + 3, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
      if (s.selected === c.id) {
        ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(px, py, sz + 6 + Math.sin(t * 3) * 1.5, 0, Math.PI * 2); ctx.stroke();
      }
      if (s.locked === c.id) {
        ctx.save(); ctx.translate(px, py); ctx.rotate(t * 1.5);
        ctx.strokeStyle = '#E2A355'; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.arc(0, 0, sz + 9, 0, Math.PI * 2); ctx.stroke();
        ctx.restore(); ctx.setLineDash([]);
      }
      const label = c.name || c.signature || 'UNKNOWN';
      if (frac < 0.9 && s.contacts.length < 60) {
        ctx.fillStyle = color; ctx.globalAlpha = 0.8; ctx.font = '10px "Share Tech Mono", monospace'; ctx.textAlign = 'left';
        ctx.fillText(label + (c.sos ? '  SOS' : ''), px + sz + 4, py + 3);
        ctx.globalAlpha = 1;
      }
      this._hits.push({ id: c.id, x: px, y: py });
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#4FD1C5'; ctx.font = '11px "Share Tech Mono", monospace';
    ctx.fillText(`${band.name} RANGE — ${band.label}`, 10, 18);
    ctx.fillStyle = '#3A6A7A'; ctx.font = '10px "Share Tech Mono", monospace';
    ctx.fillText(band.description, 10, 31);
    ctx.textAlign = 'right';
    ctx.fillText(`${s.contacts.length} CONTACT${s.contacts.length === 1 ? '' : 'S'}`, W - 10, 18);
  }
}
