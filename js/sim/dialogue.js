// ============================================================
// LONGHAUL — Talking to other ships and stations
//
// Hailing opens a channel, and a channel is a conversation: a list of
// topics we can raise, and what the other side says back. The topics
// depend on who they are (a station's traffic control, a hauler's
// bridge, a police cutter, a warship, a pirate, a crew that has struck),
// how they see us (attitude, below), and where we stand: docked or not,
// wanted or not, in need or not.
//
// Answers are not flavour only. Through a channel we ask for clearances
// (traffic-control.js), learn a ship's manifest (manifest.js), ask for
// and hear news that is on the plot (intel.js), arrange a rendezvous to
// dock and trade, warn a ship of pirates, order one to heave to (a crime
// against a lawful ship), haggle with a pirate, pay fines, ask a navy for
// passage through its zone, take a beaten crew's surrender terms, apply
// for a power's military license at its stations or hand one back, and
// report in to our command ship (service.js). Some answers ask the UI to
// open something (the contract board, services, the hiring hall, trade,
// boarding).
//
// ATTITUDE (−1 … 1) is what the other side makes of us: its power's
// standing with us (under a flag, our relation: our power's with it, and
// a tenth of our own) and whether it wants us, whether we fired on it,
// whether our transponder is on, and its trade (pirates and navies trust
// nobody; civilians and stations take most callers at their word).
//
// Voices: a Belter station speaks Lang Belta in its English, a UN
// controller reads back idents, a Martian one is clipped, a pirate is a
// pirate. The words are picked from the rng, so seeded runs read the same.
// ============================================================

import { AU_M } from '../core/constants.js';
import { pick, chance, random } from '../core/rng.js';
import { getWorld } from './world.js';
import { CLASSES, classOf, classLabel } from './ship-classes.js';
import { FACTIONS, POWERS } from './factions.js';
import { PLAYER, isOutOfFight, profile, strength } from './combatants.js';
import { leaseSummary, extendLease } from './leases.js';
import { requestApproach, requestHolding, requestDocking, requestDeparture, cancelClearance, clearanceFor, stationTraffic, voice as stationVoice } from './traffic-control.js';
import { isDocked, dockedTo } from './docking.js';
import { crewAboard, passengersAboard, declaredSouls, learn, freeBerths } from './manifest.js';
import { heldGroups, ransomOffer, ransom, turnOver } from './prisoners.js';
import { finesOwed, payFines, recordOffense, adjustStanding, wantedBy, WANTED_LABEL } from './law.js';
import { wake, makeHostile, respondToRequest } from './agents.js';
import { STATIONS } from './stations.js';
import { hullOf } from './hulls.js';
import { PRICES, inPort } from './contracts.js';
import { licenseOf, flagOf, applyForLicense, resignLicense, rankName, openCallups, effectiveRelation, navyOf } from './service.js';

// ---- WHO THEY ARE ----

/** What kind of counterpart a hail reaches. */
export function persona(e) {
  if (e.type === 'station') return e.combat?.status === 'wreck' ? 'dead' : 'station';
  if (e.tags?.wreck || e.tags?.blown) return 'dead';
  if (e.combat?.status === 'surrendered') return 'struck';
  const c = classOf(e);
  if (e.faction === 'pirate' || c?.category === 'irregular') return 'pirate';
  if (c?.category === 'military') return 'navy';
  if (c?.category === 'authority') return 'police';
  if (e.combat && (e.combat.status === 'disabled' || e.combat.drive < 0.25)) return 'crippled';
  return 'civilian';
}

/** How they see us, −1 … 1. */
export function attitude(state, e) {
  const L = state.law;
  let a = (e.faction === 'pirate' ? 0 : effectiveRelation(state, e.faction) / 100) * 0.8;    // (pirates trust nobody anyway: below)
  a -= 0.35 * (L.wanted[e.faction] ?? 0);
  if (!state.comms.transponder) a -= 0.25;
  if (e.agent?.hostile?.includes(PLAYER) || e.combat?.hostile?.includes(PLAYER)) a -= 1;
  const p = persona(e);
  a += { station: 0.15, civilian: 0.1, police: 0, navy: -0.15, pirate: -0.4, struck: 0, crippled: 0.2 }[p] ?? 0;
  if (e.tags?.helped) a += 0.4;
  return Math.max(-1, Math.min(1, a));
}

const VOICE = { OPA: 'belter', UN: 'un', MCR: 'mcr' };
const voiceOf = (e) => e.type === 'station' ? stationVoice(e) : persona(e) === 'pirate' ? 'pirate' : VOICE[e.faction] || 'independent';

const BELTA = ['kopeng', 'beratna', 'sabaka', 'ke', 'mi pampa', 'oye'];
const flavour = (v, text) => v === 'belter' && chance(0.5) ? text.replace(/([.!?])$/, `, ${pick(BELTA)}$1`) : text;

// ---- CHANNELS ----

/**
 * Open a channel. Returns the conversation { id, with, persona, voice,
 * lines: [{ who: 'them' | 'us' | 'sys', text }] } or { error }.
 * (Runtime only: a channel is not saved.)
 */
export function openChannel(state, entityId) {
  const e = getWorld(state).get(entityId);
  if (!e) return { error: 'No such contact.' };
  const p = persona(e);
  const conv = { id: `ch-${state.clock.minute}-${entityId}`, with: entityId, name: e.name, persona: p, voice: voiceOf(e), lines: [], opened: state.clock.minute, done: {} };
  state.comms.$channel = conv;
  conv.lines.push({ who: 'them', text: greeting(state, e, p) });
  return conv;
}

export const channel = (state) => state.comms.$channel || null;
export function closeChannel(state) { state.comms.$channel = null; }

function greeting(state, e, p) {
  const v = voiceOf(e);
  const tag = e.name.split(' ')[0];
  const att = attitude(state, e);
  if (p === 'dead') return e.type === 'station' ? 'Nothing on any channel. Carrier wave only.' : 'Dead air. If anyone is aboard, they are not answering.';
  if (!e.transponder && p !== 'pirate' && p !== 'struck') return 'Silence, then a click: someone is listening and not talking.';
  if (p === 'station') {
    if (isDocked(state) && dockedTo(state)?.id === e.id) return flavour(v, `${tag} Dock. Go ahead.`);
    return flavour(v, pick({
      belter: [`${tag} Traffic. Oye, we see you. State your business.`, `${tag} Traffic here. What you need, kopeng?`],
      un: [`${tag} Traffic Control, reading your ident. State intentions.`, `${tag} Traffic Control. Go ahead with your traffic.`],
      mcr: [`${tag} Control. Your transponder is logged. State your purpose.`, `${tag} Control. Identify and state intentions.`],
      independent: [`${tag} Traffic. Go ahead.`, `${tag} Traffic, receiving. What can we do for you?`],
    }[v] || [`${tag} Traffic. Go ahead.`]));
  }
  if (p === 'struck') return pick(['"We are not resisting. Drive is cold, tubes open. Tell us what you want."', '"We\'ve struck. Please. We have people hurt."']);
  if (p === 'crippled') return pick(['"Thank god, someone. Our drive is gone. Go ahead."', '"We read you. We\'re dead in space, so be kind."']);
  if (p === 'pirate') return att < -0.5 ? pick(['"You again. Talk fast."', '"Keep talking. We\'re measuring you for a cargo net."']) : pick(['"You lost, friend? Or shopping?"', 'A laugh, then: "Go ahead. Make it interesting."']);
  if (p === 'navy' && e.tags?.command) {
    const ours = flagOf(state) === e.faction;
    return ours ? `"${e.name}, ${FACTIONS[e.faction].navy} forward command. Go ahead, ${rankName(state) || 'contractor'}."` : `"${e.name}. This is a command ship of the ${FACTIONS[e.faction].navy}. State your business and keep clear."`;
  }
  if (p === 'navy') return { mcr: '"MCRN vessel. We have your ident. State your intent and keep your distance."', un: `"${e.name}, UN Navy. Go ahead, and keep your hands off your weapons board."`, belter: '"OPA. We hear you. Make it quick, ke."' }[v] || `"${e.name}. Go ahead."`;
  if (p === 'police') return att < -0.3 ? '"We know who you are. Go ahead."' : pick([`"${FACTIONS[e.faction]?.police || 'Patrol'} vessel ${e.name}. Go ahead."`, '"Patrol receiving. What is it?"']);
  return flavour(v, att < -0.3 ? pick(['"Yeah? What do you want?"', 'A long pause. "...Go ahead."']) : pick([`"${e.name} here. Go ahead."`, '"Receiving you. Go ahead with your traffic."', '"We hear you. What do you need?"']));
}

// ---- TOPICS ----

const T = (id, label, o = {}) => ({ id, label, ...o });

/** What handing back our license costs, said before it is done (the topic's confirmation). */
function resignCost(state) {
  const L = licenseOf(state);
  const hull = navyOf(state.ship.classId) === L;
  return `Yes, hand it back: no flag, no call-ups${hull ? `, and our ${FACTIONS[L].navy} hull becomes illegal to fly` : ''}`;
}

/** What we can say now: [{ id, label, why? (disabled), group }]. */
export function topics(state, conv = channel(state)) {
  if (!conv) return [];
  const e = getWorld(state).get(conv.with);
  if (!e) return [T('bye', 'Close the channel')];
  const p = persona(e);
  const out = [];
  const docked = isDocked(state) && dockedTo(state)?.id === e.id;
  if (p === 'dead') return [T('bye', 'Close the channel')];
  if (!e.transponder && p !== 'pirate' && p !== 'struck') return [T('ident', 'Demand they identify themselves'), T('bye', 'Close the channel')];

  if (p === 'station') {
    const cl = clearanceFor(state, e.id);
    out.push(T('approach', cl.approach ? 'Confirm our approach clearance' : 'Request approach clearance', { group: 'traffic', why: docked ? 'docked' : null }));
    out.push(T('hold', cl.hold ? `Renew our holding slot (${cl.hold.slot})` : 'Request a holding slot', { group: 'traffic', why: docked ? 'docked' : null }));
    out.push(T('dock', cl.dock ? `Confirm berth ${cl.dock.berth}` : 'Request docking clearance', { group: 'traffic', why: docked ? 'docked' : null }));
    if (inNeed(state)) out.push(T('emergency', 'Declare an emergency: priority berth', { group: 'traffic', why: docked ? 'docked' : null }));
    out.push(T('depart', cl.depart ? 'Confirm our departure clearance' : 'Request departure clearance', { group: 'traffic', why: docked || state.dock?.target.id === e.id ? null : 'not at the station' }));
    if (cl.approach || cl.dock) out.push(T('cancel', 'Cancel our clearance', { group: 'traffic' }));
    out.push(T('traffic', 'Ask for the traffic board', { group: 'info' }));
    out.push(T('news', 'Ask for news', { group: 'info' }));
    out.push(T('ask-ship', 'Ask the registry about a ship', { group: 'info', sub: shipsToAskAbout(state, e) }));
    const lease = docked && leaseSummary(state);
    if (lease) out.push(T('lease', `Extend our berth lease (${lease.label})`, { group: 'station', sub: lease.options.map(o => ({ id: String(o.hours), label: `${o.hours} h · ${o.cost.toLocaleString()} MCR` })), why: lease.options.length ? null : 'a week ahead already' }));
    out.push(T('board', 'Open the contract board', { group: 'station' }));
    out.push(T('services', 'Station services', { group: 'station', why: docked ? null : 'dock first' }));
    if (STATIONS[e.id]?.services.includes('hiring')) out.push(T('hire', 'The hiring hall', { group: 'station', why: docked ? null : 'dock first' }));
    if (STATIONS[e.id]?.services.includes('leave')) out.push(T('leave', 'Shore leave for the crew', { group: 'station', why: docked ? null : 'dock first' }));
    const owed = finesOwed(state, e.faction);
    if (owed.length) out.push(T('fines', `Pay citations (${owed.reduce((s, f) => s + f.amount, 0).toLocaleString()} MCR)`, { group: 'station' }));
    const held = heldGroups(state);
    if (held.length) {
      // turned over to the authority here; their officers ransomed to their own side, through the brokers
      const sub = [{ id: 'turn', label: `Turn them over to ${FACTIONS[e.faction]?.police || 'station security'}` }];
      held.forEach((g, i) => { const o = ransomOffer(state, e, i); if (o.ok) sub.push({ id: `ransom:${i}`, label: `Ransom the ${o.notables === 1 ? 'captain' : `${o.notables} officers`} of the ${g.name} to ${o.who} (${o.amount.toLocaleString()} MCR)` }); });
      out.push(T('prisoners', `Prisoners aboard (${held.reduce((s, g) => s + g.count, 0)})`, { group: 'station', sub, why: docked ? null : 'dock first' }));
    }
    // Military licenses are a power's business, at any of its stations
    if (POWERS.includes(e.faction) && licenseOf(state) !== e.faction) out.push(T('license-apply', `Apply for a ${FACTIONS[e.faction].navy} contractor's license`, { group: 'service', why: inPort(state, e) ? null : 'come into port' }));
    // (not a click to make by mistake: the topic opens on what it costs, and only that confirms it)
    if (licenseOf(state) === e.faction) out.push(T('license-resign', `Hand back our ${FACTIONS[e.faction].short} license…`, { group: 'service', sub: [{ id: 'confirm', label: resignCost(state) }] }));
  } else if (p === 'pirate') {
    out.push(T('ident', 'Who are you?'));
    const rq = state.comms.requests.find(r => r.from === e.id && r.kind === 'demand');
    if (rq) out.push(T('haggle', 'Make a counter-offer: half'));
    out.push(T('bribe', 'Pay them to leave us alone', { why: state.resources.credits.current < 500 ? 'no money' : null }));
    out.push(T('threaten', 'Tell them to clear off'));
  } else if (p === 'struck' || p === 'crippled') {
    out.push(T('souls', 'How many are aboard?'));
    out.push(T('open-locks', 'Open your locks, stand by to be boarded'));
    out.push(T('rescue', 'Offer to take survivors off', { why: freeBerths(state) <= 0 ? 'no free berths' : null }));
    out.push(T('dock-request', 'Hold still: we are coming alongside'));
  } else {
    out.push(T('ident', 'Identify yourselves'));
    out.push(T('souls', 'How many are aboard?'));
    if (p === 'civilian') {
      out.push(T('route', 'Where are you bound?'));
      out.push(T('news', 'Seen anything out there?'));
      out.push(T('dock-request', 'Request a rendezvous to dock'));
      out.push(T('trade', 'Offer to buy supplies', { why: docked ? null : null }));
      if (inNeed(state)) out.push(T('assist', 'Ask for help: we are in trouble'));
      if (knownPirates(state, e).length) out.push(T('warn', 'Warn them about pirates nearby'));
      out.push(T('heave-to', 'Order them to heave to', { group: 'threat' }));
    } else if (p === 'police') {
      out.push(T('status', 'Ask about our record'));
      if (finesOwed(state, e.faction).length || wantedBy(state, e.faction) === 1) out.push(T('fines', 'Settle our record here'));
      if (knownPirates(state, e).length) out.push(T('report', 'Report a pirate contact'));
      if (wantedBy(state, e.faction) >= 2) out.push(T('give-up', 'Surrender to them'));
      out.push(T('dock-request', 'Request a rendezvous to dock'));
    } else if (p === 'navy' && e.tags?.command && flagOf(state) === e.faction) {
      // Our forward command: orders, the board, supplies alongside
      out.push(T('orders', 'Report in: what are our orders?', { group: 'service' }));
      out.push(T('board', 'Open the mission board', { group: 'service' }));
      out.push(T('services', 'Supplies and repairs', { group: 'service', why: docked ? null : 'come alongside first' }));
      out.push(T('news', 'Ask how the fight is going'));
    } else if (p === 'navy') {
      out.push(T('passage', 'Request passage through your zone', { why: e.agent?.zone ? null : 'not in a zone' }));
      out.push(T('news', 'Ask what is happening here'));
    }
  }
  if (docked && persona(e) !== 'station' && shipOffer(state, e)) out.push(T('trade-now', 'Trade (we are docked)', { group: 'station' }));
  out.push(T('bye', 'Close the channel'));
  return out.map(t => conv.done[t.id] && ONCE.has(t.id) ? { ...t, why: 'asked' } : t);
}

/** Topics that are answered once a channel. */
const ONCE = new Set(['ident', 'souls', 'route', 'news', 'traffic', 'status', 'haggle', 'threaten', 'warn', 'report', 'passage']);


/** Are we in real trouble (fuel, hull, someone dying, a reactor)? */
function inNeed(state) {
  const R = state.resources;
  return R.fuel.current < R.fuel.max * 0.1 || state.hull.integrity < 40 || state.ship.crew.some(m => m.conditions.includes('critical'))
    || !!state.reactor.containment || state.ship.decks.some(d => d.atmosphere?.breached);
}

/** Ships near a station that its registry can tell us about (the board's own traffic first). */
function shipsToAskAbout(state, st) {
  const world = getWorld(state);
  return state.sensors.contacts.filter(c => !c.ordnance && !c.station && c.dist * AU_M < 3e7)
    .map(c => world.get(c.id)).filter(e => e?.type === 'ship').slice(0, 8).map(e => ({ id: e.id, label: e.transponder ? e.name : `contact ${e.signature}` }));
}

/** Pirate hulls we hold or have on the plot near this ship (≤ 0.05 AU). */
function knownPirates(state, e) {
  const world = getWorld(state);
  const out = [];
  for (const c of state.sensors.contacts) {
    const o = world.get(c.id);
    if (o?.faction === 'pirate' && !isOutOfFight(o) && Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 0.05) out.push(o);
  }
  return out;
}

// ---- SAYING SOMETHING ----

/**
 * Raise a topic (`arg`: a sub-choice, e.g. which ship to ask about).
 * Returns { lines, open?: 'board'|'services'|'hire'|'leave'|'trade'|'boarding', close? }.
 */
export function say(state, topicId, arg = null, emit = () => {}) {
  const conv = channel(state);
  if (!conv) return { lines: [] };
  const e = getWorld(state).get(conv.with);
  const t = topics(state, conv).find(x => x.id === topicId);
  if (!e || !t) return { lines: [] };
  if (t.why) return { lines: [{ who: 'sys', text: `(${t.why})` }] };
  conv.done[topicId] = true;
  const r = (TALK[topicId] || TALK.bye)(state, e, conv, arg, emit) || {};
  const lines = [{ who: 'us', text: t.label + (arg && t.sub ? `: ${t.sub.find(s => s.id === arg)?.label || ''}` : '') }, ...(r.lines || [])];
  for (const l of lines) conv.lines.push(l);
  if (conv.lines.length > 60) conv.lines.splice(0, conv.lines.length - 60);
  if (r.close) closeChannel(state);
  emit('hail-said', { with: e.id, name: e.name, topic: topicId, lines });
  return { ...r, lines };
}

const them = (text) => ({ who: 'them', text });
const sys = (text) => ({ who: 'sys', text });

const TALK = {
  bye: () => ({ lines: [sys('Channel closed.')], close: true }),

  // ---- traffic control ----
  approach(state, e) {
    const r = requestApproach(state, e.id);
    return { lines: [them(flavour(voiceOf(e), r.text))], clearance: r.ok };
  },
  hold(state, e) {
    const r = requestHolding(state, e.id);
    return { lines: [them(flavour(voiceOf(e), r.text))], clearance: r.ok, slot: r.slot, route: r.ok ? { kind: 'slot', id: e.id, slot: r.slot } : null };
  },
  dock(state, e) {
    const r = requestDocking(state, e.id);
    return { lines: [them(flavour(voiceOf(e), r.text))], clearance: r.ok, berth: r.berth, dock: r.ok && !isDocked(state) ? e.id : null };
  },
  emergency(state, e) {
    const r = requestDocking(state, e.id, { emergency: true });
    return { lines: [them(r.ok ? `Emergency acknowledged. ${r.text} Crash crews standing by.` : r.text)], clearance: r.ok, berth: r.berth, dock: r.ok && !isDocked(state) ? e.id : null };
  },
  depart(state, e) {
    const r = requestDeparture(state, e.id);
    return { lines: [them(flavour(voiceOf(e), r.text))] };
  },
  cancel(state, e) {
    cancelClearance(state, e.id);
    return { lines: [them('Copy, clearance cancelled. Clear our approach.')] };
  },
  traffic(state, e, conv, arg, emit) {
    const t = stationTraffic(state, e);
    // the board lists the souls aboard everything berthed and anchored here: manifests
    const world = getWorld(state);
    let learned = 0;
    const listed = [];
    for (const [berth, id] of Object.entries(e.berths || {})) {
      const o = id !== 'player' && world.get(id);
      const souls = o && declaredSouls(o);
      if (souls) {
        learn(state, o, { crew: souls.crew, pax: souls.pax, from: e.id }, 'manifest', { by: `${e.name} TC` });
        learned++;
        listed.push(`${berth} ${o.name} (${CLASSES[o.cls]?.name || 'ship'}): ${souls.crew} crew${souls.pax ? `, ${souls.pax} pax` : ''}`);
      } else if (o) listed.push(`${berth} ${o.transponder ? o.name : 'unregistered hull'}: no manifest filed`);
    }
    if (learned) emit('dossier', { src: 'manifest', text: `${e.name} traffic board: manifests for ${learned} berthed ship${learned > 1 ? 's' : ''}.` });
    return { lines: [them(`${t.used} of ${t.total} berths occupied, ${t.holding} ship${t.holding === 1 ? '' : 's'} in the holding pattern${t.anchored ? `, ${t.anchored} at the anchorage` : ''}, ${t.inbound} inbound.`), ...(listed.length ? [sys(listed.join(' · '))] : [])] };
  },
  news(state, e) {
    return { lines: [them(newsFor(state, e))] };
  },
  'ask-ship'(state, e, conv, arg, emit) {
    const o = getWorld(state).get(arg);
    if (!o) return { lines: [them('Nothing on that one.')] };
    if (!o.transponder) return { lines: [them('No transponder, no registry. Could be anyone.')] };
    const souls = declaredSouls(o);
    if (souls) learn(state, o, { crew: souls.crew, pax: souls.pax }, 'manifest', { by: `${e.name} registry` });
    const where = o.tags?.at ? `${o.tags.berth ? 'berthed' : o.tags.slot ? `holding (${o.tags.slot})` : 'at the anchorage'} at ${getWorld(state).get(o.tags.at)?.name}` : o.transit ? `on a filed plan to ${getWorld(state).get(o.tags?.to || o.transit.to)?.name || 'somewhere'}` : 'no plan filed with us';
    emit('dossier', { id: o.id, src: 'manifest', text: `Registry: ${o.name}, ${classLabel(o)}${souls ? `, ${souls.crew} crew declared` : ''}.` });
    return { lines: [them(`${o.name}: ${classLabel(o)} under ${FACTIONS[o.faction]?.short || o.faction} flag, ${where}.${souls ? ` Declared ${souls.crew} crew${souls.pax ? ` and ${souls.pax} passengers` : ''}.` : ' Nothing declared.'}`)] };
  },
  board: () => ({ lines: [sys('The contract board is up.')], open: 'board' }),
  'license-apply'(state, e, conv, arg, emit) {
    const r = applyForLicense(state, e.faction, emit);
    return { lines: [them(r.ok ? `Your application is approved. ${r.text}` : r.text)] };
  },
  'license-resign'(state, e, conv, arg, emit) {
    if (arg !== 'confirm') return { lines: [them('Say again? Confirm you are handing back your license.')] };
    const r = resignLicense(state, emit);
    return { lines: [them(r.ok ? `Understood. ${r.text}` : r.text)] };
  },
  orders(state, e) {
    const zone = state.politics.zones.find(z => z.id === e.tags.command?.zone);
    const cu = openCallups(state).find(x => x.ship === e.id);
    const n = e.board?.missions.length || 0;
    const what = zone ? `We are holding the rear of the ${zone.kind === 'front' ? 'front' : zone.kind} at ${zone.body}.` : 'The fight here is over; we are standing down.';
    return { lines: [them(`"${what} ${n ? `${n} mission${n > 1 ? 's' : ''} on the board for you.` : 'Nothing on the board right now: stand by.'} ${cu?.reported || state.dock?.target.id === e.id ? 'Supplies alongside at a tenth of the price while this lasts.' : 'Come alongside to draw supplies at a tenth of the price.'}"`)] };
  },
  services: () => ({ lines: [sys('Station services.')], open: 'services' }),
  hire: () => ({ lines: [sys('The hiring hall.')], open: 'hire' }),
  leave: () => ({ lines: [sys('Shore leave.')], open: 'leave' }),
  lease(state, e, conv, arg) {
    const r = extendLease(state, +arg || 12);
    return { lines: [them(flavour(voiceOf(e), r.text))] };
  },
  fines(state, e) {
    const r = payFines(state, e.faction);
    if (wantedBy(state, e.faction) === 1 && r.paid >= 0 && state.resources.credits.current >= 1500 && persona(e) === 'police') {
      state.resources.credits.current -= 1500;
      state.law.wanted[e.faction] = 0;
      return { lines: [them(`${r.paid ? r.text + ' ' : ''}And 1,500 for the open warrant. You're clean with us.`)] };
    }
    return { lines: [them(r.text)] };
  },
  prisoners(state, e, conv, arg, emit) {
    if (String(arg || '').startsWith('ransom:')) {
      const r = ransom(state, e, +arg.slice(7), emit);
      return { lines: [them(r.text)] };
    }
    return { lines: [them(turnOver(state, e, emit).text)] };
  },

  // ---- ships ----
  ident(state, e, conv) {
    const p = persona(e);
    if (!e.transponder && p !== 'pirate') {
      if (attitude(state, e) < -0.2 || chance(0.5)) return { lines: [them('No answer.')] };
      e.transponder = true;
      return { lines: [them(`"...${e.name}. Transponder coming on."`)] };
    }
    if (p === 'pirate') return { lines: [them(pick([`"Names are for tombstones. Call us the ${e.name}."`, '"We\'re the ones asking questions here."']))] };
    learn(state, e, {}, 'registry');
    const where = e.tags?.from || e.tags?.at ? ` out of ${getWorld(state).get(e.tags.at || e.tags.from)?.name || 'port'}` : '';
    return { lines: [them(`"${e.name}, ${classLabel(e)}, ${FACTIONS[e.faction]?.short || e.faction} registry${where}."`)] };
  },
  souls(state, e, conv, arg, emit) {
    const p = persona(e);
    const n = crewAboard(e), pax = passengersAboard(e);
    if (p === 'pirate' || (p === 'navy' && attitude(state, e) < 0.2)) return { lines: [them(p === 'navy' ? '"That is not your concern."' : '"Enough of us. Come and count."')] };
    const lie = attitude(state, e) < -0.3 && chance(0.5);
    const said = lie ? Math.max(1, Math.round(n * (1.4 + random()))) : n;
    learn(state, e, { crew: said, pax }, 'hail');
    emit('dossier', { id: e.id, src: 'hail', text: `${e.name} says ${said} aboard${pax ? `, ${pax} passengers` : ''}.` });
    return { lines: [them(p === 'struck' || p === 'crippled' ? `"${said} of us${n < CLASSES[e.cls]?.crewStd ? ', what\'s left' : ''}.${pax ? ` And ${pax} passengers.` : ''}"` : `"${said} crew${pax ? `, ${pax} passengers` : ''}. Why?"`)] };
  },
  route(state, e) {
    const world = getWorld(state);
    const to = world.get(e.tags?.to || e.transit?.to);
    const name = to?.type === 'station' ? to.name : to?.tags?.gate ? world.get(to.tags.gate)?.name : null;
    if (attitude(state, e) < -0.3) return { lines: [them('"Away from you."')] };
    if (name) learn(state, e, { to: to.id }, 'registry');
    return { lines: [them(name ? `"${name}. Filed plan, if you want to check."` : e.tags?.at ? `"Sitting here at ${world.get(e.tags.at)?.name} a while yet."` : '"Wherever the work is."')] };
  },
  news(state, e) { return { lines: [them(newsFor(state, e))] }; },
  'dock-request'(state, e) {
    const p = persona(e);
    const ok = p === 'struck' || p === 'crippled' || (attitude(state, e) >= 0 && (p === 'civilian' || p === 'police'));
    if (!ok) return { lines: [them(p === 'navy' ? '"Negative. Keep your distance."' : '"No. Stand off."')] };
    holdForUs(state, e);
    const ports = (hullOf(e.cls)?.ports || []).map(x => `${x.size} ${x.face === 'x+' ? 'nose' : x.face === 'y-' ? 'port' : 'starboard'}`).join(', ');
    return { lines: [them(`"Holding for you. We have ${ports || 'a collar'}. Come in slow."`), sys(`${e.name} is holding still. Plot a docking from the contact panel.`)] };
  },
  trade(state, e) {
    const offer = shipOffer(state, e, true);
    if (!offer) return { lines: [them('"We\'ve nothing to spare."')] };
    holdForUs(state, e);
    return { lines: [them(`"We can let you have ${offer.items.map(i => `${i.qty.toLocaleString()} ${i.unit} of ${i.name}`).join(', ')}. Come alongside and dock, and bring money."`)] };
  },
  'trade-now': () => ({ lines: [sys('Trading over the collar.')], open: 'trade' }),
  assist(state, e) {
    const a = attitude(state, e);
    if (a < 0 || chance(0.3)) return { lines: [them('"Sorry. We can\'t risk it."')] };
    holdForUs(state, e);
    e.tags.charity = true;
    return { lines: [them('"We\'ll hold for you. Dock, and we\'ll give you what we can spare."')] };
  },
  warn(state, e) {
    if (e.faction in state.law.standing) adjustStanding(state, e.faction, 1);
    e.tags.helped = true;
    return { lines: [them('"...Thank you. We\'ll keep our transponder quiet and our eyes open."')] };
  },
  'heave-to'(state, e, conv, arg, emit) {
    const ours = strength(profile(state, PLAYER)), theirs = strength(profile(state, e.id));
    if (!e.tags.threatened) { e.tags.threatened = true; recordOffense(state, e.faction, 'threatening a lawful ship', 1, emit, e.name); }
    if (ours > theirs * 1.5 && chance(0.75)) {
      holdForUs(state, e);
      return { lines: [them('"All right! All right. Drive is cold. Don\'t shoot."'), sys(`${e.name} has cut its drive. Boarding a lawful ship is piracy.`)] };
    }
    if (e.agent || wake(state, e, 'civilian')) { makeHostile(state, e, PLAYER); getWorld(state).setSos(e, true); }
    return { lines: [them('"Like hell. Mayday, mayday, we are being threatened —"'), sys(`${e.name} is running and calling for help.`)] };
  },

  // ---- police ----
  status(state, e) {
    const w = wantedBy(state, e.faction);
    const owed = finesOwed(state, e.faction).reduce((s, f) => s + f.amount, 0);
    return { lines: [them(`"Your record with ${FACTIONS[e.faction]?.short}: ${WANTED_LABEL[w]}.${owed ? ` ${owed.toLocaleString()} MCR in citations outstanding.` : ''} Standing ${Math.round(state.law.standing[e.faction] ?? 0)}."`)] };
  },
  report(state, e) {
    const p = knownPirates(state, e)[0];
    if (!p) return { lines: [them('"We don\'t see it."')] };
    adjustStanding(state, e.faction, 2);
    if (e.agent && ['patrol', 'picket'].includes(e.agent.role)) makeHostile(state, e, p.id);
    return { lines: [them(`"Copy. We have it. Moving to intercept."`)] };
  },
  'give-up'(state, e, conv, arg, emit) {
    if (!e.agent) return { lines: [them('"Stand by."')] };
    e.agent.hostile = e.agent.hostile.filter(x => x !== PLAYER);
    e.agent.mode = 'search-approach';
    e.agent.target = PLAYER;
    return { lines: [them('"Cut your drive and stand by to be boarded. Any move and we fire."'), sys('They are coming alongside to arrest the ship. Your record will be settled by what they find, and what you can pay.')] };
  },

  // ---- navy ----
  passage(state, e) {
    const s = state.law.standing[e.faction] ?? 0;
    if (s >= 10 && wantedBy(state, e.faction) === 0 && state.comms.transponder) {
      if (e.agent) e.agent.flags.passage = true;
      return { lines: [them('"Passage granted. Hold your course and your fire."')] };
    }
    return { lines: [them(state.comms.transponder ? '"Denied. Turn back."' : '"Turn your transponder on before you ask us for anything."')] };
  },

  // ---- pirates ----
  haggle(state, e, conv, arg, emit) {
    const rq = state.comms.requests.find(r => r.from === e.id && r.kind === 'demand');
    if (!rq) return { lines: [them('"Haggle about what?"')] };
    const ours = strength(profile(state, PLAYER)), theirs = strength(profile(state, e.id));
    if (ours > theirs * 0.7 && chance(0.6)) {
      e.agent.flags.demand = Math.round((e.agent.flags.demand || 0) / 2 / 100) * 100;
      respondToRequest(state, rq.id, 'pay', emit);
      return { lines: [them(`"...Fine. Half. ${e.agent.flags.demand.toLocaleString()}, and you never saw us."`), sys('Paid. They are leaving.')] };
    }
    return { lines: [them('"Funny. The price just went up."')] };
  },
  bribe(state, e, conv, arg, emit) {
    const amount = Math.max(500, Math.round(state.resources.credits.current * 0.15 / 100) * 100);
    state.resources.credits.current -= Math.min(state.resources.credits.current, amount);
    if (e.agent) { e.agent.mode = 'leave'; e.agent.threat = null; e.agent.hostile = e.agent.hostile.filter(x => x !== PLAYER); }
    const rq = state.comms.requests.find(r => r.from === e.id);
    if (rq) state.comms.requests = state.comms.requests.filter(r => r !== rq);
    return { lines: [them(`"${amount.toLocaleString()}. Pleasure doing business."`), sys('They are peeling away.')] };
  },
  threaten(state, e, conv, arg, emit) {
    const ours = strength(profile(state, PLAYER)), theirs = strength(profile(state, e.id));
    if (ours > theirs * 1.5) {
      if (e.agent) { e.agent.mode = 'leave'; e.agent.threat = null; e.agent.hostile = e.agent.hostile.filter(x => x !== PLAYER); }
      return { lines: [them('"...Not worth it. We\'re gone."')] };
    }
    if (e.agent) makeHostile(state, e, PLAYER);
    return { lines: [them('"Big words. Let\'s see your guns, then."')] };
  },

  // ---- a beaten crew ----
  'open-locks'(state, e) {
    e.tags.locksOpen = true;
    holdForUs(state, e);
    return { lines: [them('"Locks are open. Nobody aboard is armed. Please."')] };
  },
  rescue(state, e, conv, arg, emit) {
    const n = Math.min(crewAboard(e) + passengersAboard(e), freeBerths(state));
    if (n <= 0) return { lines: [them('"There\'s no one left to take."')] };
    holdForUs(state, e);
    e.tags.rescue = n;
    return { lines: [them(`"${n} of us. God bless you. We'll be at the lock."`), sys('Dock with them (or board by EVA) to take them aboard.')] };
  },
};

/** A ship agrees to hold still for us: woken off its rails if it was traffic, drive cold. */
function holdForUs(state, e) {
  if (!e.agent) wake(state, e, 'civilian');
  if (!e.agent) return;
  if (e.agent.mode !== 'surrendered') e.agent.mode = 'dock-hold';
  e.agent.cmd = null;
  e.agent.since = state.clock.minute;
}

// ---- NEWS ----

/** What a station or a ship has heard: real zones on our plot, real pirates near it, or nothing much. */
function newsFor(state, e) {
  const zones = Object.values(state.intel?.zones || {});
  const lines = [];
  const near = zones.filter(z => z.body).slice(0, 3);
  for (const z of near) {
    const who = (z.factions || []).map(f => FACTIONS[f]?.short || f).join(' and ');
    lines.push(z.kind === 'pirate' ? `Pirates working the lanes near ${z.body}.` : z.kind === 'blockade' ? `${who} blockade at ${z.body}: expect to be stopped.` : z.kind === 'skirmish' ? `Shooting at ${z.body}, ${who}. Stay clear.` : z.kind === 'insurgency' ? `Trouble at ${z.body}: ${who}.` : `${who} standing off at ${z.body}.`);
  }
  const pirates = [...getWorld(state).forces].filter(f => f.tags.force?.role === 'pirate' && Math.hypot(f.pos.x - e.pos.x, f.pos.y - e.pos.y) < 0.03);
  if (pirates.length && chance(0.6)) lines.push(`Someone saw a cold hull ${Math.round(Math.hypot(pirates[0].pos.x - e.pos.x, pirates[0].pos.y - e.pos.y) * AU_M / 1e6) * 1000 || 'a few hundred'} thousand km out. No transponder.`);
  if (!lines.length) return pick(['"Quiet. Too quiet, my old captain used to say."', '"Nothing worth repeating."', '"Same as always: prices up, wages down."']);
  return `"${lines.join(' ')}"`;
}

// ---- TRADE WITH A SHIP ----

/**
 * What a ship will sell us (it has to be docked with us to hand it over):
 * { items: [{ key, name, qty, unit, price }] } priced well over the
 * station rate. A charity case gives it away.
 */
export function shipOffer(state, e, quote = false) {
  const c = classOf(e);
  if (!c || c.category === 'military') return null;
  const size = { S: 1, M: 3, L: 8, XL: 20 }[c.size];
  const mark = e.tags?.charity ? 0 : 1.8 + (e.faction === 'pirate' ? 1 : 0);
  const items = [
    { key: 'fuel', name: 'reaction mass', qty: 400 * size, unit: 'kg' },
    { key: 'water', name: 'water', qty: 200 * size, unit: 'L' },
    { key: 'food', name: 'rations', qty: 60 * size, unit: 'rations' },
    { key: 'parts', name: 'spare parts', qty: Math.max(1, Math.round(size * (0.5 + (e.id.length % 3)))), unit: 'parts' },
    { key: 'medSupplies', name: 'medical supplies', qty: 2 * size, unit: 'units' },
  ].map(i => ({ ...i, price: +(PRICES[i.key] * mark).toFixed(2) }));
  if (!quote && !(isDocked(state) && dockedTo(state)?.id === e.id)) return null;
  return { items, charity: !!e.tags?.charity };
}

/** Buy one item over the collar (docked with the ship). */
export function buyFromShip(state, e, key) {
  const offer = shipOffer(state, e);
  const it = offer?.items.find(i => i.key === key);
  if (!it) return { ok: false, text: 'Not docked with them.' };
  const r = state.resources[key];
  const room = Math.max(0, r.max - r.current);
  const qty = Math.min(it.qty, room, it.price > 0 ? state.resources.credits.current / it.price : Infinity);
  if (qty <= 0) return { ok: false, text: room <= 0 ? 'Our tanks are full.' : 'Not enough credits.' };
  r.current += qty;
  state.resources.credits.current -= qty * it.price;
  e.tags.sold ??= {};
  e.tags.sold[key] = (e.tags.sold[key] || 0) + qty;
  return { ok: true, text: `${Math.round(qty).toLocaleString()} ${it.unit} of ${it.name} across the collar${it.price ? ` for ${Math.round(qty * it.price).toLocaleString()} MCR` : ', free'}.` };
}

