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
import { openDistress, openRequest } from './dialogs.js';
import { RANGE } from '../core/constants.js';
import { getWorld } from '../sim/world.js';

let noFoodAt = null;

const HANDLERS = {
  'route-engaged': ({ target, unsecured, override, stance }) => {
    if (override && unsecured.length) {
      logEntry(`Helm: executing with ${unsecured.length} crew unsecured (${unsecured.join(', ')})`, 'danger');
      toast(`BURN — ${unsecured.length} CREW UNSECURED`, 'danger');
    } else if (stance) {
      logEntry(`Helm: all hands secured — taking up the stance on ${target}`, 'nav');
    } else {
      logEntry(`Helm: all hands secured — burning for ${target}`, 'nav');
      toast(`MANEUVER → ${target}`, 'nav');
    }
  },
  'stance-settled': ({ target, mode, rangeM, first }) => {
    const where = `${mode === 'hold' ? 'on station' : mode === 'out' ? 'outside' : 'inside'} ${fmtNum(rangeM / 1000)} km ${mode === 'hold' ? 'off' : 'of'} ${target}`;
    logEntry(first ? `Helm: ${where}` : `Helm: back ${where}`, 'nav');
    if (first) toast('STANCE TAKEN', 'ok');
  },
  'stance-evading': ({ etaS }) => {
    logEntry(`Helm: torpedo ${Math.round(etaS / 60)} min out — turning away and burning`, 'danger');
    toast('EVADING TORPEDO', 'danger');
  },
  'turn-held': ({ count, names }) => {
    logEntry(`Helm: holding the flip — ${count} crew still on their feet (${names.join(', ')}). All hands, secure for maneuvering`, 'danger');
    toast('FLIP HELD — SECURE ALL HANDS', 'danger');
  },
  'turn-forced': ({ count, captain }) => logEntry(`Helm: flipping with ${count} crew on their feet${captain ? ' — captain\'s order' : ''}`, 'danger'),
  'stance-lost': ({ target }) => { logEntry(`Lost the track on ${target} — stance released, drifting`, 'danger'); toast('STANCE LOST', 'danger'); },
  'route-arrived': ({ target, minutes, fuelUsed, intercept }) => {
    const what = intercept === 'formation' ? 'Formation established with' : intercept === 'dock' || intercept == null ? 'Arrived at' : 'In range of';
    logEntry(`${what} ${target} — ${formatDuration(minutes)}, ${fmtNum(fuelUsed)} kg burned. Holding station.`, 'nav');
    toast(`${what.toUpperCase()} ${target}`, 'ok');
  },
  'route-aborted': ({ target, stance }) => logEntry(stance ? `Stance on ${target} released — drive cut, drifting` : `Route to ${target} aborted — drive cut, drifting`, 'warn'),
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
  'crew-hangover': ({ member, minutes }) => logEntry(`${member.name}: ${member.juiceCrash ? 'high-dose crash' : 'juice hangover'}, ~${formatDuration(minutes)}`, member.juiceCrash ? 'danger' : 'warn'),
  'crew-stabilized': ({ member, medic }) => logEntry(`${medic.name} stabilized ${member.name}`, 'crew'),
  'crew-delivered': ({ member, medic }) => logEntry(`${medic.name} carried ${member.name} to the autodoc`, 'crew'),
  'crew-healed': ({ member }) => logEntry(`${member.name} discharged from the autodoc`, 'ok'),
  'crew-suited': ({ member }) => logEntry(`${member.name} donned an EVA suit`, 'crew'),
  'crew-work-done': ({ member, kind, result }) => {
    if (kind === 'maintain') logEntry(`${member.name}: ${result.message}`, 'system');
    else if (kind === 'fabricate') logEntry(`${member.name}: ${result.message}`, 'system');
    else if (!result.success) logEntry(`${member.name}: ${result.message}`, 'warn');
    else if (result.mode === 'jury') { logEntry(`${member.name}: ${result.message}`, 'warn'); toast(result.message, 'warn'); }
    else { logEntry(`${member.name}: ${result.message}`, 'ok'); toast(result.message, 'ok'); }
  },
  'crew-no-food': () => {
    const now = ui.state.clock.minute;
    if (now - (noFoodAt ?? -Infinity) < 360) return;
    noFoodAt = now;
    logEntry('The galley is empty — no rations left aboard', 'danger'); toast('NO FOOD ABOARD', 'danger');
  },
  'suit-depleted': ({ member }) => { logEntry(`${member.name}'s suit O₂ exhausted`, 'danger'); toast(`${member.name} — SUIT O₂ OUT`, 'danger'); },

  'system-fault': ({ id, name, fault, status, cause }) => {
    const failed = status === 'failed';
    const why = cause === 'meteoroid' ? ' (meteoroid damage)' : cause === 'combat' ? ' (battle damage)' : cause === 'power loss' ? ' (after power loss)' : '';
    logEntry(`${name}: ${fault.text}${why} — ${failed ? 'FAILED' : 'degraded'}`, failed ? 'danger' : 'warn');
    if (id === 'flightComputer' && failed) toast('FLIGHT COMPUTER DOWN — a pilot must fly from the helm', 'danger');
    else toast(`${name.toUpperCase()} ${failed ? 'FAILED' : 'DEGRADED'}`, failed ? 'danger' : 'warn');
  },
  'system-patch-failed': ({ name }) => { logEntry(`${name}: the jury-rig gave out — failed again`, 'danger'); toast(`${name.toUpperCase()} — PATCH FAILED`, 'danger'); },
  'meteoroid-strike': ({ deckName, breach, systemName }) => {
    const what = [breach ? `HULL BREACH on ${deckName}` : `hit near ${deckName}`, systemName ? `${systemName} damaged` : ''].filter(Boolean).join(', ');
    logEntry(`Micrometeoroid strike — ${what}`, 'danger');
    toast(breach ? `METEOROID — HULL BREACH (${deckName})` : 'METEOROID STRIKE', 'danger');
  },
  'damage-control': ({ on }) => on
    ? (logEntry('Damage control: hull breach — burn eased to 1G until it is sealed', 'danger'), toast('DAMAGE CONTROL — BURN EASED', 'danger'))
    : logEntry('Breach sealed — damage control stood down', 'ok'),
  'meteoroid-dodged': () => logEntry('Ops: debris on a collision course — nudged clear', 'nav'),
  'helm-status': ({ status, was, by }) => {
    if (status === 'unmanned') { logEntry('HELM UNMANNED — flight computer down, the ship is coasting', 'danger'); toast('HELM UNMANNED — COASTING', 'danger'); }
    else if (status === 'manual') logEntry(`${by} has the helm — flying by hand`, 'nav');
    else if (status === 'degraded') logEntry('Flight computer degraded — guidance wandering', 'warn');
    else if (was === 'manual' || was === 'degraded' || was === 'unmanned') { logEntry('Flight computer back online — autopilot has the helm', 'ok'); toast('Autopilot restored', 'ok'); }
  },

  'reactor-countdown': () => { logEntry('Reactor procedure complete — offline in 60 minutes', 'warn'); toast('Reactor shutdown — 1h', 'warn'); },
  'reactor-offline': () => { logEntry('Fusion reactor offline. Emergency batteries.', 'danger'); toast('REACTOR OFFLINE', 'danger'); },
  'reactor-online': () => { logEntry('Fusion reactor online. All systems nominal.', 'ok'); toast('Reactor online', 'ok'); },
  'reactor-patched': () => logEntry('Containment patched — reactor can be restarted', 'ok'),
  'reactor-scrammed': () => { logEntry('Emergency scram — reactor offline, containment breached', 'danger'); toast('REACTOR SCRAMMED', 'danger'); },
  'reactor-fuel-dumped': ({ remaining }) => { logEntry(`Fuel dumped to ${fmtNum(remaining)} kg — reactor offline`, 'danger'); toast('FUEL DUMPED', 'danger'); },
  'reactor-procedure-aborted': ({ work, reason }) => { logEntry(`Reactor ${work} aborted: ${reason}`, 'danger'); toast(`Reactor ${work} aborted`, 'danger'); },
  'reactor-supercritical': () => logEntry('REACTOR SUPERCRITICAL.', 'danger'),
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

  // ---- Combat
  'torpedo-launched': ({ owner, warhead }) => { if (owner === 'player') logEntry(`${warhead === 'nuke' ? 'Nuclear' : 'HE'} torpedo away`, 'danger'); },
  'ordnance-inbound': ({ kind, warhead, etaS }) => {
    const what = kind === 'slug' ? 'RAILGUN SLUG' : warhead === 'nuke' ? 'NUCLEAR TORPEDO' : 'TORPEDO';
    logEntry(`Ops: ${what.toLowerCase()} inbound${isFinite(etaS) ? `, impact in ${formatDuration(etaS / 60)}` : ''}`, 'danger');
    toast(`${what} INBOUND`, 'danger');
  },
  'torpedo-intercepted': ({ owner, target }) => {
    if (target === 'player') logEntry('PDCs: torpedo splashed', 'ok');
    else if (owner === 'player') logEntry(`Our torpedo was shot down by ${nameOf(target)}`, 'warn');
  },
  'torpedo-hit': ({ owner, target, warhead }) => {
    if (owner === 'player') { logEntry(`Torpedo hit on ${nameOf(target)}${warhead === 'nuke' ? ' — nuclear detonation' : ''}`, 'ok'); toast('TORPEDO HIT', 'ok'); }
  },
  'torpedo-missed': ({ owner, target }) => { if (owner === 'player') logEntry(`Torpedo missed ${nameOf(target)}`, 'warn'); else if (target === 'player') logEntry('Torpedo overshot us', 'ok'); },
  'torpedo-track-lost': ({ owner }) => { if (owner === 'player') logEntry('Torpedo lost its track — flying on dead reckoning', 'warn'); },
  'torpedo-reacquired': ({ target }) => { if (target !== 'player') logEntry('Torpedo seeker reacquired the target', 'nav'); },
  'ordnance-gone': ({ owner, why, kind }) => {
    if (owner !== 'player' || kind !== 'torpedo' || why === 'missed') return;
    const text = { expired: 'reactor burned out', lost: 'found nothing at the predicted point — self-destructed', spent: 'out of Δv, falling behind — self-destructed' }[why] || 'self-destructed: target gone';
    logEntry(`Torpedo ${text}`, 'system');
  },
  'slug-hit': ({ owner, target }) => { if (target === 'player') toast('RAILGUN HIT', 'danger'); else if (owner === 'player') logEntry(`Slug hit on ${nameOf(target)}`, 'ok'); },
  'player-hit': ({ kind, weapon, section, effects }) => {
    const what = kind === 'blast' ? 'Blast wave' : kind === 'pdc' ? 'PDC fire' : kind === 'slug' ? 'Railgun slug' : kind === 'he' ? 'Torpedo' : kind === 'gear' ? `Improvised fire (${weapon})` : 'Hit';
    const parts = [effects.breaches.length ? `breach: ${effects.breaches.join(', ')}` : '', effects.systems.length ? effects.systems.join(', ') : '', effects.containment ? 'REACTOR CONTAINMENT FAILING' : ''].filter(Boolean);
    logEntry(`${what} strikes the ${section === 'all' ? 'whole hull' : section} — hull ${Math.round(ui.state.hull.integrity)}%${parts.length ? ' · ' + parts.join(' · ') : ''}`, 'danger');
    toast(effects.containment ? 'HIT — CONTAINMENT FAILURE, SCRAM THE REACTOR' : `HIT — HULL ${Math.round(ui.state.hull.integrity)}%`, 'danger');
    document.body.classList.add('hit-flash');
    setTimeout(() => document.body.classList.remove('hit-flash'), 350);
  },
  'crew-wounded': ({ message }) => logEntry(message, 'danger'),
  'player-destroyed': ({ cause }) => { ui.onGameOver?.(cause === 'reactor' ? 'The reactor lost containment. For a moment the ship was a small sun.' : 'The hull broke apart under fire.'); },
  'ship-hit': ({ by, name, section }) => { if (by === 'player') logEntry(`Hit on ${name} — ${section === 'all' ? 'blast damage' : section}`, 'ok'); },
  'ship-disabled': ({ name, by }) => { logEntry(`${name} is dead in space`, by === 'player' ? 'ok' : 'warn'); if (by === 'player') toast(`${name} DISABLED`, 'ok'); },
  'ship-destroyed': ({ name, by, how }) => { logEntry(how === 'reactor' ? `${name} — reactor detonation` : `${name} breaks up`, 'danger'); if (by === 'player') toast(`${name.replace(' (wreck)', '')} DESTROYED`, 'ok'); },
  'ship-scrammed': ({ name }) => logEntry(`${name} scrammed its reactor`, 'warn'),
  'ship-surrendered': ({ name }) => { logEntry(`${name} has surrendered`, 'ok'); toast(`${name} SURRENDERS`, 'ok'); },
  'detonation': ({ kind }) => { if (kind === 'nuclear') logEntry('Nuclear detonation', 'danger'); },
  'target-destroyed': ({ name }) => logEntry(`Fire control: ${name} — target destroyed`, 'ok'),
  'under-attack': ({ name }) => { logEntry(`${name} is firing on us!`, 'danger'); toast(`UNDER ATTACK — ${name}`, 'danger'); },
  'agent-retreats': ({ name }) => logEntry(`${name} is breaking off`, 'nav'),
  'agent-left': () => {},
  'encounter': ({ kind, name }) => { if (kind === 'battle') logEntry(`Ops: warships maneuvering for a fight nearby — ${name}`, 'warn'); },

  // ---- Comms demands & the law
  'comm-request': ({ request }) => { logEntry(`[${request.fromName}] ${request.text}`, 'comms'); openRequest(request); },
  'comm-request-expired': ({ request }) => logEntry(`No answer to ${request.fromName}`, 'warn'),
  'inspection-started': ({ name }) => logEntry(`${name} alongside — inspection team boarding`, 'comms'),
  'inspection-complete': ({ name, text }) => { logEntry(`${name}: ${text}`, 'comms'); toast(text, 'info'); },
  'pirates-paid': ({ name, credits }) => logEntry(`Paid ${fmtNum(credits)} MCR to the ${name}`, 'warn'),
  'crime': ({ kind, victim, factions }) => { logEntry(`${factions.join(' / ')} record: ${kind === 'resisting' ? 'resisting inspection' : `attack on ${victim}`}`, 'danger'); toast('CRIME RECORDED', 'danger'); },
  'player-identified': ({ name, faction }) => logEntry(`${name} (${faction}) has identified us`, 'warn'),
  'zone-news': ({ text }) => logEntry(`Newsfeed: ${text}`, 'comms'),
  'zone-incident': ({ text }) => logEntry(`Newsfeed: ${text}`, 'comms'),
};

function nameOf(id) {
  if (id === 'player') return ui.state.ship.name;
  const e = getWorld(ui.state).get(id);
  return e ? (e.transponder ? e.name : 'contact') : 'target';
}

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

