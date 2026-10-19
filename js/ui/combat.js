// ============================================================
// LONGHAUL — Combat tab: threat board and fire control
//
// The threat board is ship-centred and nose-up like the scanner, but
// its range is logarithmic — 1 km to 10 million km on one screen —
// because a fight spans both: a torpedo launched from millions of km
// arrives in seconds of PDC fire at a few km. Contacts come from our
// own sensor picture; ordnance coming for us is red, ours teal.
//
// The fire-control panel drives sim/combat.js: target, torpedo
// warhead and profile, launch, PDC mode, aim, evasive maneuvers.
// ============================================================

import { ui } from './context.js';
import { esc, setHTML, fmtNum, fmtKm, fmtSpeed, FitCanvas } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { AU_KM } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { bus } from '../core/events.js';
import { getWorld } from '../sim/world.js';
import { factionColor, FACTIONS } from '../sim/factions.js';
import { classLabel } from '../sim/ship-classes.js';
import { PLAYER, profile, gunner } from '../sim/combatants.js';
import { timeToGo, launchedBy } from '../sim/ordnance.js';
import { hostilesOfPlayer } from '../sim/agents.js';
import { setFireTarget, setPdcMode, setAim, setEvasive, fireTorpedo, readyTubes, threats, PDC_MODES } from '../sim/combat.js';
import { AIM } from '../sim/damage.js';
import { WARHEADS, PROFILES } from '../sim/weapons.js';
import { WANTED_LABEL } from '../sim/law.js';
import { contactById, REVEAL } from '../sim/sensors.js';
import { relativeTo } from './hud.js';
import { fxList } from './fx.js';

const DECADES = 7;                 // 1 km … 10,000,000 km
const choice = { warhead: 'he', profile: 'fast' };

export class ThreatView {
  constructor(container, { onSelect } = {}) {
    this.fc = new FitCanvas(container, { className: 'threat-canvas' });
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
    const R = Math.min(cx, cy) - 20;
    const t = performance.now() / 1000;
    this._hits.length = 0;
    ctx.fillStyle = '#0A0608';
    ctx.fillRect(0, 0, W, H);
    if (state.reactor.blackout) {
      ctx.fillStyle = '#331111'; ctx.font = '10px "Press Start 2P", monospace'; ctx.textAlign = 'center';
      ctx.fillText('FIRE CONTROL OFFLINE — NO POWER', cx, cy);
      return;
    }
    const radius = (km) => R * Math.max(0, Math.min(1, Math.log10(Math.max(1, km)) / DECADES));

    // Decade rings, PDC envelope, torpedo launch range
    ctx.lineWidth = 1;
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    for (let d = 1; d <= DECADES; d++) {
      ctx.strokeStyle = `rgba(90,40,40,${0.35 + d * 0.05})`;
      ctx.beginPath(); ctx.arc(cx, cy, R * d / DECADES, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(160,90,90,0.7)';
      ctx.fillText(fmtKm(10 ** d), cx + R * d / DECADES + 3, cy - 3);
    }
    const p = profile(state, PLAYER);
    ctx.fillStyle = 'rgba(79,209,197,0.07)';
    ctx.beginPath(); ctx.arc(cx, cy, radius(p.pdc.rangeM / 1000), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(79,209,197,0.35)'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, radius(p.pdc.strafeM / 1000), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);

    // Own ship
    ctx.fillStyle = '#4FD1C5';
    ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4); ctx.closePath(); ctx.fill();

    const world = getWorld(state);
    const facing = state.flight.facing;
    const hostile = new Set(hostilesOfPlayer(state).map(e => e.id));
    const at = (c) => {
      const rel = c.bearing - facing;
      const r = radius(c.dist * AU_KM);
      return { x: cx - Math.sin(rel) * r, y: cy - Math.cos(rel) * r };
    };
    for (const c of state.sensors.contacts) {
      const { x, y } = at(c);
      const e = world.get(c.id);
      if (c.ordnance) {
        const inbound = e?.ord?.target === PLAYER, ours = e?.ord?.owner === PLAYER;
        const col = inbound ? '#FF5555' : ours ? '#4FD1C5' : '#E2A355';
        if (inbound) { ctx.strokeStyle = 'rgba(255,85,85,0.35)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx, cy); ctx.stroke(); }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.fill();
        if (inbound) {
          const eta = timeToGo(state, e);
          ctx.fillText(`${c.name}${isFinite(eta) ? ' ' + formatDuration(eta / 60) : ''}`, x + 6, y + 3);
        }
        continue;
      }
      if (c.station || e?.type === 'nav') continue;
      const col = c.wreck ? '#5A5A5A' : c.faction ? factionColor(c.faction) : '#8A8A6A';
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      if (hostile.has(c.id)) { ctx.strokeStyle = '#FF5555'; ctx.strokeRect(x - 7, y - 7, 14, 14); }
      if (state.combat.target === c.id) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(t);
        ctx.strokeStyle = '#FF8C42';
        ctx.beginPath(); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ctx.moveTo(Math.cos(a) * 7, Math.sin(a) * 7); ctx.lineTo(Math.cos(a) * 13, Math.sin(a) * 13); } ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = col; ctx.globalAlpha = 0.85;
      ctx.fillText(c.name || c.signature || 'CONTACT', x + 8, y + 3);
      ctx.globalAlpha = 1;
      this._hits.push({ id: c.id, x, y });
    }
    // Our own torpedoes on their way, toward their targets
    for (const o of launchedBy(state, PLAYER)) {
      const tk = world.get(o.ord.target);
      if (!tk) continue;
      const rel = (pos) => {
        const dx = pos.x - state.flight.pos.x, dy = pos.y - state.flight.pos.y;
        const r = radius(Math.hypot(dx, dy) * AU_KM), b = Math.atan2(dy, dx) - facing;
        return { x: cx - Math.sin(b) * r, y: cy - Math.cos(b) * r };
      };
      const a = rel(o.pos), b = rel(tk.pos);
      ctx.strokeStyle = 'rgba(79,209,197,0.3)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#4FD1C5'; ctx.fillRect(a.x - 1.5, a.y - 1.5, 3, 3);
    }
    // Point-defense fire right now
    for (const fx of fxList()) {
      if (fx.kind !== 'pdc' || fx.id !== PLAYER || fx.age >= 1) continue;
      ctx.strokeStyle = `rgba(255,214,140,${1 - fx.age})`;
      ctx.beginPath(); ctx.arc(cx, cy, radius(p.pdc.rangeM / 1000) * (0.3 + 0.7 * fx.age), 0, Math.PI * 2); ctx.stroke();
    }

    ctx.fillStyle = '#E25555'; ctx.font = '11px "Share Tech Mono", monospace'; ctx.textAlign = 'left';
    ctx.fillText('THREAT BOARD — LOG RANGE 1 km … 10M km', 10, 18);
    ctx.fillStyle = 'rgba(160,90,90,0.8)'; ctx.font = '10px "Share Tech Mono", monospace';
    ctx.fillText('filled: PDC envelope · dashed: PDC gun range · click a contact to target', 10, 31);
  }
}

// ---- FIRE CONTROL PANEL ----

export function renderFireControl(state, box) {
  const C = state.combat;
  const world = getWorld(state);
  const p = profile(state, PLAYER);
  const g = gunner(state);
  const now = state.clock.minute;
  const tgt = C.target ? world.get(C.target) : null;
  const c = tgt ? contactById(state, tgt.id) : null;
  const sec = (title, body) => `<div class="fc-section"><div class="fc-title">${title}</div>${body}</div>`;
  const btn = (act, label, active = false, extra = '') => `<button class="fc-btn ${active ? 'active' : ''}" data-fc="${act}" ${extra}>${label}</button>`;

  let target = '<div class="fc-dim">No target. Click a contact on the threat board, or TARGET it from the scanner.</div>';
  if (tgt) {
    const rel = relativeTo(state, { kind: 'entity', id: tgt.id });
    const known = c && (tgt.transponder || c.scan >= REVEAL.PROFILE);
    const hull = tgt.combat && c?.scan >= REVEAL.MASS ? `${Math.max(0, Math.round(tgt.combat.hp / tgt.combat.hpMax * 100))}%${tgt.combat.status !== 'ok' ? ' · ' + tgt.combat.status.toUpperCase() : ''}` : '…';
    target = `<div class="fc-target-name" style="color:${factionColor(known ? tgt.faction : null)}">${esc(known ? tgt.name : c?.signature || 'Unidentified contact')}</div>
      <div class="fc-row"><span>CLASS</span><b>${known ? `${esc(classLabel(tgt))} · TL${tgt.tl}` : '—'}</b></div>
      <div class="fc-row"><span>FLAG</span><b>${known ? esc(FACTIONS[tgt.faction]?.name || tgt.faction) : '—'}</b></div>
      <div class="fc-row"><span>RANGE</span><b>${rel ? fmtKm(rel.dist / 1000) : '—'}</b></div>
      <div class="fc-row"><span>CLOSING</span><b>${rel ? fmtSpeed(rel.closing) : '—'}</b></div>
      <div class="fc-row"><span>HULL</span><b>${hull}</b></div>
      <div class="fc-actions">${btn('clear', 'CLEAR TARGET')}</div>`;
  }

  const M = state.magazine;
  const tubes = C.tubes.map((t, i) => `<span class="fc-tube ${t <= now && p.tubes ? 'ready' : ''}">T${i + 1} ${p.tubes ? (t <= now ? 'READY' : `${t - now}m`) : 'DOWN'}</span>`).join('');
  const why = !tgt ? 'no target' : M[choice.warhead] <= 0 ? 'magazine empty' : readyTubes(state) === 0 ? 'tubes cycling' : '';
  const torps = `<div class="fc-row"><span>MAGAZINE</span><b>${M.he} HE · ${M.nuke} NUKE / ${M.capacity}</b></div>
    <div class="fc-tubes">${tubes}</div>
    <div class="fc-choice">${Object.values(WARHEADS).map(w => btn(`warhead:${w.id}`, w.short, choice.warhead === w.id)).join('')}
      ${Object.values(PROFILES).map(pr => btn(`profile:${pr.id}`, pr.label, choice.profile === pr.id)).join('')}</div>
    <div class="fc-desc">${esc(PROFILES[choice.profile].desc)}</div>
    <div class="fc-actions">${btn('fire', why ? `FIRE — ${why.toUpperCase()}` : 'FIRE TORPEDO', false, why ? 'disabled' : '')}</div>`;

  const pdc = `<div class="fc-choice">${Object.entries(PDC_MODES).map(([k, m]) => btn(`pdc:${k}`, m.label, C.pdc === k)).join('')}</div>
    <div class="fc-desc">${esc(PDC_MODES[C.pdc].desc)}</div>
    <div class="fc-row"><span>MOUNTS</span><b>${p.pdc.mounts.toFixed(1)} of ${p.cls.pdc} · TL${p.tl}</b></div>
    <div class="fc-row"><span>ROUNDS</span><b>${fmtNum(state.resources.pdcRounds.current)}</b></div>
    <div class="fc-row"><span>FIRE CONTROL</span><b class="${g ? '' : 'fc-warn'}">${g ? esc(g.name) : 'AUTOMATIC (−40%)'}</b></div>`;

  const aim = `<div class="fc-choice">${Object.values(AIM).map(a => btn(`aim:${a.id}`, a.label, C.aim === a.id)).join('')}</div>
    <div class="fc-desc">${esc(AIM[C.aim].desc)}</div>`;

  const helm = `<div class="fc-choice">${btn('stations', state.combatStations ? 'BATTLE STATIONS ●' : 'BATTLE STATIONS', state.combatStations)}
    ${btn('evasive', C.evasive ? 'EVASIVE ●' : 'EVASIVE', C.evasive, state.combatStations ? '' : 'disabled')}</div>
    <div class="fc-desc">Jinking throws off torpedo homing, railguns and PDC aim. Costs reaction mass and puts ${state.$jinkG ? state.$jinkG.toFixed(1) : '2.5'}G on the crew.</div>`;

  const inbound = threats(state);
  const hostiles = hostilesOfPlayer(state);
  const threatRows = inbound.map(th => `<div class="fc-threat"><span>${th.kind === 'slug' ? 'SLUG' : th.warhead === 'nuke' ? 'NUKE' : 'TORPEDO'}</span><b>${isFinite(th.etaS) ? formatDuration(th.etaS / 60) : 'opening'}</b></div>`).join('')
    + hostiles.map(h => `<div class="fc-threat fc-hostile"><span>${esc(h.transponder ? h.name : 'hostile contact')}</span><b>${fmtKm(Math.hypot(h.pos.x - state.flight.pos.x, h.pos.y - state.flight.pos.y) * AU_KM)}</b></div>`).join('');
  const record = ['UN', 'MCR', 'OPA'].map(f => `<span class="fc-law ${state.law.wanted[f] ? 'fc-warn' : ''}">${f} ${Math.round(state.law.standing[f])} · ${WANTED_LABEL[state.law.wanted[f]]}</span>`).join('');

  setHTML(box, `${sec('TARGET', target)}${sec('TORPEDOES', torps)}${sec('POINT DEFENSE', pdc)}${sec('AIM', aim)}${sec('HELM', helm)}
    ${sec('THREATS', threatRows || '<div class="fc-dim">Nothing inbound.</div>')}
    ${sec('STATUS', `<div class="fc-row"><span>HULL</span><b class="${state.hull.integrity < 50 ? 'fc-warn' : ''}">${Math.round(state.hull.integrity)}%</b></div><div class="fc-laws">${record}</div>`)}`);
}

/** Fire-control panel clicks. */
export function onFireControlClick(e) {
  const b = e.target.closest('[data-fc]');
  const s = ui.state;
  if (!b || !s) return;
  const [act, arg] = b.dataset.fc.split(':');
  const emit = (t, p) => bus.emit(t, p);
  switch (act) {
    case 'clear': setFireTarget(s, null); break;
    case 'warhead': choice.warhead = arg; break;
    case 'profile': choice.profile = arg; break;
    case 'pdc': setPdcMode(s, arg); logEntry(`PDCs: ${PDC_MODES[arg].label}`, 'system'); break;
    case 'aim': setAim(s, arg); break;
    case 'stations': ui.toggleCombat?.(); break;
    case 'evasive': { const r = setEvasive(s, !s.combat.evasive); toast(r.text, r.ok ? 'info' : 'warn'); if (r.ok) logEntry(r.text, 'nav'); break; }
    case 'fire': {
      const r = fireTorpedo(s, choice, emit);
      toast(r.text, r.ok ? 'danger' : 'warn');
      if (r.ok) logEntry(r.text, 'danger');
      break;
    }
  }
}

/** Select a contact as the fire-control target (from the board or the scanner). */
export function targetContact(state, id) {
  if (!id) return;
  const r = setFireTarget(state, id);
  toast(r.text, r.ok ? 'info' : 'warn');
  if (r.ok) logEntry(r.text, 'nav');
}

/** Distance to the nearest inbound torpedo, for the HUD chip. */
export function threatSummary(state) {
  const inbound = threats(state);
  if (!inbound.length) return null;
  const eta = inbound[0].etaS;
  return { count: inbound.length, eta, nuke: inbound.some(t => t.warhead === 'nuke') };
}
