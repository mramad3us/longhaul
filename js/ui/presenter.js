// ============================================================
// LONGHAUL — Event presenter
// Turns sim events into the ship's log, toasts, dialogs and screen
// effects. The only place that decides how a fact is shown.
// ============================================================

import { bus } from '../core/events.js';
import { formatDuration } from '../core/clock.js';
import { ui, inGame } from './context.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { fmtNum } from './dom.js';
import { openDistress } from './dialogs.js';
import { RANGE } from '../core/constants.js';

const HANDLERS = {
  'route-engaged': ({ target, unsecured, override }) => {
    if (override && unsecured.length) {
      logEntry(`Helm: executing with ${unsecured.length} crew unsecured (${unsecured.join(', ')})`, 'danger');
      toast(`BURN — ${unsecured.length} CREW UNSECURED`, 'danger');
    } else {
      logEntry(`Helm: all hands secured — burning for ${target}`, 'nav');
      toast(`MANEUVER → ${target}`, 'nav');
    }
  },
  'route-arrived': ({ target, minutes, fuelUsed, intercept }) => {
    const what = intercept === 'formation' ? 'Formation established with' : intercept === 'dock' || intercept == null ? 'Arrived at' : 'In range of';
    logEntry(`${what} ${target} — ${formatDuration(minutes)}, ${fmtNum(fuelUsed)} kg burned. Holding station.`, 'nav');
    toast(`${what.toUpperCase()} ${target}`, 'ok');
  },
  'route-aborted': ({ target }) => logEntry(`Route to ${target} aborted — drive cut, drifting`, 'warn'),
  'route-target-lost': () => { logEntry('Route target lost — autopilot disengaged', 'danger'); toast('TARGET LOST', 'danger'); },
  'hold-lost': ({ reason }) => { logEntry(`Lost station-keeping: ${reason}`, 'danger'); toast('STATION-KEEPING LOST', 'danger'); },
  'fuel-exhausted': () => { logEntry('Reaction mass exhausted — drive cold', 'danger'); toast('FUEL EXHAUSTED', 'danger'); },
  'speed-limited': ({ speed }) => toast(speed === 1 ? 'Time warp limited — maneuver in progress' : 'Time warp limited', 'warn'),
  'crew-policy': ({ policy }) => logEntry(policy === 'secure' ? 'All hands: secure for maneuvering' : 'Crew released from couches', policy === 'secure' ? 'nav' : 'crew'),

  'inertia-start': ({ type, count }) => {
    toast(type === 'flip' ? 'FLIP — UNSECURED CREW THROWN' : 'INERTIAL EVENT', 'danger');
    logEntry(`${count} crew thrown by the ${type.replace('-', ' ')}`, 'danger');
    document.body.classList.add('inertia-active');
  },
  'inertia-impact': (h) => { logEntry(h.message, h.severity === 'bruise' ? 'warn' : 'danger'); if (h.severity !== 'bruise') toast(h.message, 'danger'); },
  'inertia-end': () => document.body.classList.remove('inertia-active'),

  'crew-died': ({ member }) => { logEntry(`${member.name} (${member.role}) — DECEASED`, 'danger'); toast(`${member.name} has died`, 'danger'); },
  'crew-critical': ({ member }) => { logEntry(`${member.name} in cardiac arrest — critical`, 'danger'); toast(`${member.name} CRITICAL`, 'danger'); },
  'crew-brain-damage': ({ member }) => logEntry(`${member.name} — severe head trauma, brain damage`, 'danger'),
  'crew-stroke': ({ member }) => { logEntry(`${member.name} suffered a stroke under high-dose juice`, 'danger'); toast(`${member.name} — STROKE`, 'danger'); },
  'drive-overstress': ({ g }) => { logEntry(`Drive overstress at ${g.toFixed(1)}G — CONTAINMENT FAILURE. Scram the reactor!`, 'danger'); toast('CONTAINMENT FAILURE — DRIVE OVERSTRESS', 'danger'); },
  'crew-hangover': ({ member, minutes }) => logEntry(`${member.name}: juice hangover, ~${formatDuration(minutes)}`, 'warn'),
  'crew-stabilized': ({ member, medic }) => logEntry(`${medic.name} stabilized ${member.name}`, 'crew'),
  'crew-delivered': ({ member, medic }) => logEntry(`${medic.name} carried ${member.name} to the autodoc`, 'crew'),
  'crew-healed': ({ member }) => logEntry(`${member.name} discharged from the autodoc`, 'ok'),
  'crew-suited': ({ member }) => logEntry(`${member.name} donned an EVA suit`, 'crew'),
  'crew-repair': ({ member, result }) => {
    if (result?.success) { logEntry(`${member.name}: ${result.message}`, 'ok'); toast(result.message, 'ok'); }
    else logEntry(`${member.name}: ${result?.message || 'repair failed'}`, 'warn');
  },
  'suit-depleted': ({ member }) => { logEntry(`${member.name}'s suit O₂ exhausted`, 'danger'); toast(`${member.name} — SUIT O₂ OUT`, 'danger'); },

  'ls-failure': ({ deck, status }) => { const n = ui.state.ship.decks[deck].name; logEntry(`Life support ${status} (${n})`, 'danger'); toast(`LIFE SUPPORT ${status.toUpperCase()}`, 'danger'); },
  'ls-patch-expired': ({ deck }) => { logEntry(`Life support patch failed (${ui.state.ship.decks[deck].name})`, 'danger'); toast('LS PATCH FAILED', 'danger'); },

  'reactor-countdown': () => { logEntry('Reactor procedure complete — offline in 60 minutes', 'warn'); toast('Reactor shutdown — 1h', 'warn'); },
  'reactor-offline': () => { logEntry('Fusion reactor offline. Emergency batteries.', 'danger'); toast('REACTOR OFFLINE', 'danger'); },
  'reactor-online': () => { logEntry('Fusion reactor online. All systems nominal.', 'ok'); toast('Reactor online', 'ok'); },
  'reactor-patched': () => logEntry('Containment patched — reactor can be restarted', 'ok'),
  'reactor-scrammed': () => { logEntry('Emergency scram — reactor offline, containment breached', 'danger'); toast('REACTOR SCRAMMED', 'danger'); },
  'reactor-fuel-dumped': ({ remaining }) => { logEntry(`Fuel dumped to ${fmtNum(remaining)} kg — reactor offline`, 'danger'); toast('FUEL DUMPED', 'danger'); },
  'reactor-procedure-aborted': ({ work, reason }) => { logEntry(`Reactor ${work} aborted: ${reason}`, 'danger'); toast(`Reactor ${work} aborted`, 'danger'); },
  'reactor-supercritical': () => { logEntry('REACTOR SUPERCRITICAL. Ship lost.', 'danger'); ui.onGameOver?.('The reactor went supercritical.'); },
  'blackout': () => { logEntry('Emergency power exhausted — total blackout', 'danger'); toast('TOTAL BLACKOUT', 'danger'); },
  'blackout-end': () => logEntry('Power restored', 'ok'),

  'sos-offered': (p) => {
    logEntry(`MAYDAY — ${p.entity.name}, ${p.entity.shipClass}`, 'danger');
    openDistress(p);
  },
  'sos-chatter': ({ from, text }) => logEntry(`[${from}] ${text}`, 'comms'),
  'sos-heard': ({ entity, distanceAU }) => { if (!entity.tags?.missionId && distanceAU > RANGE.LONG) logEntry(`Distress beacon on long range: ${entity.name}`, 'comms'); },
  'sos-failed': ({ mission, reason }) => { logEntry(`${mission.title} — ${reason}`, 'danger'); toast(`Mission failed: ${mission.title}`, 'danger'); },
  'sos-lost': ({ mission }) => logEntry(`${mission.title.replace('SOS — ', '')} — distress beacon fell silent`, 'comms'),
  'sos-auto': () => logEntry('Blackout: automatic distress beacon activated', 'danger'),

  'contract-progress': ({ text }) => { logEntry(text, 'nav'); toast(text, 'nav'); },
  'contract-failed': ({ contract, reason }) => { logEntry(`Contract failed: ${contract.title} — ${reason}`, 'danger'); toast('Contract failed', 'danger'); },
};

export function initPresenter() {
  bus.on('*', (type, payload) => {
    if (!inGame()) return;
    const h = HANDLERS[type];
    if (h) {
      try { h(payload); } catch (e) { console.error('[presenter]', type, e); }
    }
  });
}

export function resourceAlert(name, level, pct) {
  if (level === 'critical') { toast(`${name} CRITICAL`, 'danger'); logEntry(`${name} critical — ${Math.round(pct)}%`, 'danger'); }
  else { toast(`${name} running low`, 'warn'); logEntry(`${name} low — ${Math.round(pct)}%`, 'warn'); }
}

