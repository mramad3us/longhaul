// ============================================================
// LONGHAUL — The boarding window
//
// Choosing a party (who is fit to go, how good they are in a fight,
// whether there are suits for an EVA), then following the operation as
// it runs (sim/boarding.js): mustering at the lock, the crossing, the
// hatch, the fight, and once the ship is ours the orders aboard. The
// window can be closed and reopened; the boarding goes on either way.
// ============================================================

import { ui } from './context.js';
import { $, esc, show } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { bus } from '../core/events.js';
import { getWorld } from '../sim/world.js';
import { boardable, eligibleBoarders, startBoarding, boardingActions, orderAboard, recallParty } from '../sim/boarding.js';
import { overallHealth } from '../sim/crew.js';
import { lawfulTarget } from '../sim/law.js';

const emit = (t, p) => bus.emit(t, p);
let target = null, via = null, picked = new Set();

export function initBoarding() {
  const ov = $('#dialog-boarding');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeBoarding(); });
  ov.addEventListener('click', onClick);
}

export const boardingOpen = () => $('#dialog-boarding').style.display !== 'none';

export function openBoarding(id = null) {
  const s = ui.state;
  if (!s) return;
  if (s.boarding && s.boarding.phase !== 'done') target = s.boarding.target;
  else {
    target = id;
    const e = getWorld(s).get(id);
    const can = boardable(s, e);
    if (!can.ok) { toast(can.text, 'warn'); return; }
    via = can.via[0];
    // the best in a fight first: security, then health
    const fit = eligibleBoarders(s, via).filter(m => m.role !== 'Pilot').sort((a, b) => b.skills.security - a.skills.security);
    picked = new Set(fit.slice(0, Math.min(4, fit.length)).map(m => m.id));
  }
  show($('#dialog-boarding'), true, 'flex');
  render();
}

export function closeBoarding() {
  if (!boardingOpen()) return false;
  show($('#dialog-boarding'), false);
  return true;
}

function render() {
  const s = ui.state;
  const body = $('#dialog-boarding-body');
  const b = s.boarding && s.boarding.phase !== 'done' ? s.boarding : null;
  const e = getWorld(s).get(b ? b.target : target);
  if (!e) { body.innerHTML = '<p class="dialog-text">Nothing to board.</p><div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>'; return; }
  let html;
  if (!b) {
    const can = boardable(s, e);
    const crew = eligibleBoarders(s, via);
    const lawful = lawfulTarget(e) && !e.tags?.locksOpen && e.combat?.status !== 'surrendered';
    const suits = Object.values(s.lifeSupport.lockers).filter(l => l.hasSuit).length;
    html = `<h3 class="dialog-title">Board ${esc(e.transponder ? e.name : 'the contact')}</h3>
      <p class="dialog-text">${can.ok ? `${via === 'dock' ? 'Through the mated collar.' : `By EVA across ${Math.round(can.distM)} m of open space, on suit thrusters.`} ${suits} suits in the lockers.` : esc(can.text)}</p>
      ${can.ok && can.via.length > 1 ? `<div class="bd-actions">${can.via.map(v => `<button class="btn ${v === via ? 'btn-primary' : 'btn-secondary'}" data-act="via" data-v="${v}">${v === 'dock' ? 'THROUGH THE COLLAR' : 'EVA'}</button>`).join('')}</div>` : ''}
      ${lawful ? '<p class="dialog-text" style="color:var(--danger)">This is a lawful ship that has not invited us. Boarding it is piracy.</p>' : ''}
      <div class="bd-party">${crew.map(m => `<div class="bd-member ${picked.has(m.id) ? 'on' : ''}" data-act="pick" data-id="${m.id}">
        <span>${picked.has(m.id) ? '☑' : '☐'}</span><span>${esc(m.name)} <small>${esc(m.role)} · security ${Math.round(m.skills.security)} · health ${overallHealth(m)}%</small></span></div>`).join('') || '<p class="dialog-text">Nobody fit to go.</p>'}</div>
      <div class="form-actions"><button class="btn btn-secondary" data-act="close">Cancel</button><button class="btn btn-primary" data-act="go" ${can.ok && picked.size ? '' : 'disabled'}>SEND ${picked.size} ACROSS</button></div>`;
  } else {
    const acts = boardingActions(s);
    const PH = { muster: 'MUSTERING AT THE LOCK', cross: b.via === 'dock' ? 'IN THE COLLAR' : 'CROSSING', breach: 'CUTTING THE HATCH', fight: 'FIGHTING ABOARD', secured: 'SHIP SECURED', return: 'COMING BACK' };
    html = `<h3 class="dialog-title">Boarding · ${esc(b.name)}</h3>
      <div class="bd-phase">${PH[b.phase] || b.phase.toUpperCase()}${b.phase === 'fight' ? ` · ${b.defenders} resisting` : ''}${b.action ? ` · ${esc(b.action.id)} (${Math.max(0, b.action.until - s.clock.minute)} min)` : ''}</div>
      <p class="dialog-text">Party: ${b.party.map(id => s.ship.crew.find(m => m.id === id)).filter(Boolean).map(m => `${esc(m.name)}${m.dead ? ' (dead)' : m.away?.captured ? ' (captured)' : ''}`).join(', ')}</p>
      ${b.phase === 'secured' ? `<div class="bd-actions">${acts.map(a => `<button class="btn ${a.why ? 'btn-secondary' : 'btn-primary'}" data-act="order" data-a="${a.id}" title="${esc(a.desc)}" ${a.why || b.action ? 'disabled' : ''}>${esc(a.label)}${a.why ? ` · ${esc(a.why)}` : ''}</button>`).join('')}<button class="btn btn-secondary" data-act="order" data-a="withdraw">COME BACK</button></div>` : ''}
      <div class="bd-log">${b.log.slice().reverse().map(l => `<div>${esc(l.text)}</div>`).join('')}</div>
      <div class="form-actions">${b.phase !== 'return' ? '<button class="btn btn-secondary" data-act="recall">RECALL THE PARTY</button>' : ''}<button class="btn btn-secondary" data-act="close">Close</button></div>`;
  }
  body.innerHTML = html;
}

function onClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn || !ui.state) return;
  const s = ui.state;
  switch (btn.dataset.act) {
    case 'close': closeBoarding(); return;
    case 'via': via = btn.dataset.v; break;
    case 'pick': { const id = +btn.dataset.id; if (picked.has(id)) picked.delete(id); else picked.add(id); break; }
    case 'go': {
      const r = startBoarding(s, target, { party: [...picked], via }, emit);
      toast(r.text, r.ok ? 'nav' : 'warn');
      if (r.ok) logEntry(r.text, 'nav');
      break;
    }
    case 'order': { const r = orderAboard(s, btn.dataset.a, emit); if (!r.ok) toast(r.text, 'warn'); break; }
    case 'recall': recallParty(s, emit); break;
  }
  render();
}

/** While open, follow the operation. */
export function updateBoarding() {
  if (!boardingOpen() || !ui.state?.boarding) return;
  const now = ui.state.clock.minute;
  if (now !== updateBoarding.at) { updateBoarding.at = now; render(); }
}
