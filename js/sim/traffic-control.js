// ============================================================
// LONGHAUL — Traffic control: the space around a station is managed
//
// A port with a few hundred ships coming and going does not let
// strangers wander about it. Around every station, nested:
//
//   CONTROL SPACE (30,000 km). Traffic control watches everything in
//     it. A transponder is required; running dark here gets a warning,
//     then a citation.
//   THE APPROACH (2,000 km). Nobody comes inside without approach
//     clearance (hail the station and ask). Loiter here uncleared and
//     you are warned, cited, and in the end reported to the police.
//   KEEP-OUT (the approach gate: 50–100 km). Only ships cleared to dock,
//     and leaving on a departure clearance, come inside it, below the
//     speed limit. A trespasser gets a final warning, then it is a
//     crime, and the station's guns lock on: a naval yard fires.
//   THE BERTH CORRIDOR (the last kilometre), flown in docking mode
//     (docking.js).
//
// Clearances are granted by hailing (dialogue.js, or the nav computer's
// one-click request): approach (good for 6 hours), holding (a slot in the
// port's holding pattern, holding.js: good for a day, and renewed by
// asking again), docking (a berth assigned, good for 2 hours), departure
// (30 minutes). Port space (the approach) is where the radio side of a
// station is worked: a ship there with a clearance is in port. A docking request
// may be refused: a power that wants us, standing under −20, a naval
// yard that doesn't know us, no berth free (then we wait at the
// anchorage and are called), docks shot out.
//
// Citations are fines owed to the station's power (law.js keeps them);
// a week unpaid makes us SUSPECT there.
//
// Near a hub the radio is busy, and it is real traffic: traffic control
// clearing the ships actually berthed and inbound, the advisories of the
// day, and our own nav computer calling out ranges, zones and timers.
// All of it is one bounded query round the nearest station a minute.
// ============================================================

import { AU_M } from '../core/constants.js';
import { randInt, pick, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { FACTIONS } from './factions.js';
import { PLAYER_CLASS } from './ship-classes.js';
import { hullOf } from './hulls.js';
import { STATIONS, stationModel, freeBerth, berthFits, berthCounts, berthOccupant, gateId } from './stations.js';
import { cite, recordOffense } from './law.js';
import { holdingPattern, freeSlot, claimSlot, releaseSlot, slotOccupant, slotDescription, slotCounts, PORT_M } from './holding.js';

export const CONTROL_M = 30_000_000;
export const APPROACH_M = 2_000_000;
export const CORRIDOR_M = 1_000;
export const APPROACH_CLEARANCE_MIN = 6 * 60;
export const DOCK_CLEARANCE_MIN = 2 * 60;
export const DEPART_CLEARANCE_MIN = 30;
export const HOLD_CLEARANCE_MIN = 24 * 60;
export const KEEPOUT_SPEED_MS = 200;       // the speed limit inside the gate, coming in
export const APPROACH_SPEED_MS = 3_000;    // …and on the approach
export const KEEPOUT_DRIVE_G = 0.1;        // no torch inside the gate: the nav computer holds the drive to this

const CONTROL_AU = CONTROL_M / AU_M;
const CHATTER_MIN = [5, 13];               // minutes between traffic control's transmissions near a hub
const CALLOUTS_KM = [1000, 500, 200, 100, 50, 20, 10, 5, 2];

/** How deep inside a station's managed space a distance is. */
export function zoneAt(st, dM) {
  const keep = (STATIONS[st.id]?.gateKm || 50) * 1000;
  // (the gate itself, where routes end and ships hold, is just outside)
  return dM < keep * 0.97 ? 'keepout' : dM <= APPROACH_M ? 'approach' : dM <= CONTROL_M ? 'control' : 'none';
}

export const keepOutM = (stationId) => (STATIONS[stationId]?.gateKm || 50) * 1000;

export function createTrafficControl() {
  return { station: null, zone: 'none', since: 0, clear: {}, warned: {}, nextChatter: 0, callout: null, speedWarned: 0, outbound: null };
}

// ---- CLEARANCES ----

/** Our clearances with a station: { approach, hold: { slot, until }, dock: { berth, port, until }, depart } (minutes they run to). */
export function clearanceFor(state, stationId) {
  const c = state.tc?.clear[stationId];
  const now = state.clock.minute;
  if (!c) return { approach: false, hold: null, dock: null, depart: false };
  const hold = c.hold && c.hold.until > now ? c.hold : null;
  return {
    approach: (c.approach ?? -1) > now || (c.dock?.until ?? -1) > now || !!hold,
    hold,
    dock: c.dock && c.dock.until > now ? c.dock : null,
    depart: (c.depart ?? -1) > now,
  };
}

function clear(state, stationId) {
  state.tc ??= createTrafficControl();
  return (state.tc.clear[stationId] ||= {});
}

/** Why a station won't have us at all, or null. */
export function refusal(state, st) {
  const L = state.law;
  if (st.combat?.status === 'wreck') return 'The station is silent.';
  if ((L.wanted[st.faction] ?? 0) >= 2) return `Your registry is flagged by ${FACTIONS[st.faction]?.short || st.faction}. Hold your position and await the police.`;
  if ((L.standing[st.faction] ?? 0) < -20) return 'You are not welcome here. Clear our control space.';
  if (st.combat?.hostile?.includes('player')) return 'Weapons are locked on you. Leave.';
  return null;
}

/** Our collar sizes (the classes' hulls: hulls.js). */
export function ourPorts(state) {
  return hullOf(state.ship.classId || PLAYER_CLASS)?.ports || [];
}

/** Approach clearance: in to the gate. */
export function requestApproach(state, stationId) {
  const st = getWorld(state).get(stationId);
  if (!st) return { ok: false, text: 'No such station.' };
  const no = refusal(state, st);
  if (no) return { ok: false, text: no };
  const c = clear(state, stationId);
  c.approach = state.clock.minute + APPROACH_CLEARANCE_MIN;
  const gate = STATIONS[stationId]?.gateKm || 50;
  return { ok: true, text: `Cleared to approach. Hold at the gate, ${gate} km out on the local vertical, and request your berth from there. No torch inside the gate.` };
}

/**
 * Docking clearance: a berth that takes one of our collars. `emergency`
 * jumps the queue (a berth from the reserve, and a refused one is rare).
 */
export function requestDocking(state, stationId, { emergency = false } = {}) {
  const st = getWorld(state).get(stationId);
  if (!st) return { ok: false, text: 'No such station.' };
  const no = refusal(state, st);
  if (no && !(emergency && (state.law.wanted[st.faction] ?? 0) < 3)) return { ok: false, text: no };
  const spec = STATIONS[stationId];
  if (spec?.military && !emergency && (state.law.standing[st.faction] ?? 0) < 30) {
    return { ok: false, text: `${st.name} berths ${FACTIONS[st.faction]?.navy || 'navy'} hulls and contractors with standing. Request denied. You may hold at the anchorage.` };
  }
  if ((st.combat?.docks ?? 1) < 0.25) return { ok: false, text: 'Our docks are out of action. We cannot take you.' };
  const ports = ourPorts(state);
  const sizes = [...new Set(ports.map(p => p.size))];
  const held = clearanceFor(state, stationId).dock;
  const berth = held ? stationModel(stationId).berths.find(b => b.id === held.berth) : freeBerth(state, st, sizes);
  if (!berth) {
    const eta = nextFreeing(state, st);
    return { ok: false, full: true, text: `All berths that take your collars are full.${eta != null ? ` One should clear in about ${Math.max(10, Math.round(eta / 10) * 10)} minutes.` : ''} Hold at the anchorage and call again.` };
  }
  const port = ports.find(p => p.use === 'crew' && p.face !== 'x+' && berthFits(berth, p.size)) || ports.find(p => berthFits(berth, p.size));
  const c = clear(state, stationId);
  c.dock = { berth: berth.id, port: port.id, until: state.clock.minute + DOCK_CLEARANCE_MIN };
  c.approach = Math.max(c.approach ?? 0, c.dock.until);
  return { ok: true, berth: berth.id, port: port.id, text: `Cleared to dock, ${berth.label} (${berth.accepts.join('/')} collar). Come down the corridor from the gate below ${KEEPOUT_SPEED_MS} m/s. Clearance good for two hours.` };
}

/** Minutes until a traffic ship in a berth is due to leave (null if none is). */
function nextFreeing(state, st) {
  const world = getWorld(state);
  let best = null;
  for (const id of Object.values(st.berths || {})) {
    const e = id !== 'player' && world.get(id);
    if (!e?.tags?.until) continue;
    const m = e.tags.until - state.clock.minute;
    if (m > 0 && (best == null || m < best)) best = m;
  }
  return best;
}

/** Departure clearance (docked, or holding off the station). */
export function requestDeparture(state, stationId) {
  const st = getWorld(state).get(stationId);
  if (!st) return { ok: false, text: 'No such station.' };
  if ((state.law.wanted[st.faction] ?? 0) >= 2) return { ok: false, text: 'Departure denied. Remain at your berth: security is on its way.' };
  const c = clear(state, stationId);
  c.depart = state.clock.minute + DEPART_CLEARANCE_MIN;
  return { ok: true, text: `Cleared for departure. Out through the gate at ${STATIONS[stationId]?.gateKm || 50} km before you light your torch. Safe flight.` };
}

export function cancelClearance(state, stationId) {
  const c = state.tc?.clear[stationId];
  if (!c) return;
  if (c.hold) { const st = getWorld(state).get(stationId); if (st) releaseSlot(st, c.hold.slot, 'player'); }
  delete state.tc.clear[stationId];
}

/**
 * Holding clearance: a slot in the port's holding pattern (holding.js),
 * the free one nearest us, for a day; asking again renews it.
 */
export function requestHolding(state, stationId) {
  const st = getWorld(state).get(stationId);
  if (!st) return { ok: false, text: 'No such station.' };
  const no = refusal(state, st);
  if (no) return { ok: false, text: no };
  if (!holdingPattern(stationId)) return { ok: false, text: 'We have no holding pattern. Hold at the gate.' };
  const c = clear(state, stationId);
  const now = state.clock.minute;
  const held = c.hold && slotOccupant(getWorld(state), st, c.hold.slot) === 'player' ? c.hold.slot : null;
  const slot = held || freeSlot(state, st, state.flight.pos)?.id;
  if (!slot) return { ok: false, text: 'Our holding pattern is full. Hold at the anchorage and call again.' };
  claimSlot(st, slot, 'player');
  c.hold = { slot, until: now + HOLD_CLEARANCE_MIN };
  return { ok: true, slot, text: `${held ? 'Holding renewed' : 'Cleared to hold'}: slot ${slotDescription(stationId, slot)}. Good for twenty-four hours. You are in port: the board is open to you there.` };
}

/** Docking used its clearance: the berth is ours, the clearance spent. */
export function clearanceUsed(state, stationId) {
  const c = clear(state, stationId);
  c.dock = null;
}

// ---- PER MINUTE ----

const _q = [];

/**
 * The station whose control space we are in (the nearest), with its
 * distance (m). The station index is small (a few per body); the spatial
 * hash round a busy port holds thousands of ships, so it isn't asked.
 */
export function nearestStation(state) {
  const pos = state.flight.pos;
  let best = null, bd = CONTROL_AU;
  for (const e of getWorld(state).stations) {
    const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y;
    if (Math.abs(dx) > bd || Math.abs(dy) > bd) continue;
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = e; }
  }
  return best ? { st: best, dM: bd * AU_M } : null;
}

/** Relative speed to a station (m/s). */
const relSpeed = (state, st) => Math.hypot(state.flight.vel.vx - st.vel.vx, state.flight.vel.vy - st.vel.vy);

/** Closing on a station (m/s; negative opening). */
function closingOn(state, st) {
  const f = state.flight;
  const dx = (st.pos.x - f.pos.x) * AU_M, dy = (st.pos.y - f.pos.y) * AU_M;
  const d = Math.hypot(dx, dy) || 1;
  return ((f.vel.vx - st.vel.vx) * dx + (f.vel.vy - st.vel.vy) * dy) / d;
}

/** Leaving a station we were docked at (until we are clear of its control space). */
export function markOutbound(state, stationId) {
  (state.tc ??= createTrafficControl()).outbound = stationId;
}

/** Inside a station's gate the nav computer holds the drive down (KEEPOUT_DRIVE_G), battle stations aside. */
export const keepOutDriveCap = (state) => state.tc?.zone === 'keepout' && !state.combatStations ? KEEPOUT_DRIVE_G : Infinity;

export function trafficControlTick(state, emit = () => {}) {
  const tc = (state.tc ??= createTrafficControl());
  const now = state.clock.minute;
  const near = nearestStation(state);
  const docked = state.dock?.phase === 'docked' ? state.dock.target.id : null;
  const st = near?.st || null;
  const zone = docked && st?.id === docked ? 'docked' : st ? zoneAt(st, near.dM) : 'none';
  if ((st?.id ?? null) !== tc.station || zone !== tc.zone) {
    const was = tc.zone, wasSt = tc.station;
    tc.station = st?.id ?? null;
    tc.zone = zone;
    tc.since = now;
    tc.warned = {};
    if (tc.outbound && (zone === 'none' || st?.id !== tc.outbound)) tc.outbound = null;
    if (st) emit('tc-zone', { station: st.id, name: st.name, zone, was: wasSt === st.id ? was : 'none', voice: voice(st), text: zoneLine(state, st, zone, was) });
    else if (wasSt) emit('tc-zone', { station: wasSt, name: getWorld(state).get(wasSt)?.name, zone: 'none', was, text: 'Leaving traffic control space.' });
    if (st && zone !== 'docked') tc.nextChatter = now + randInt(2, 6);
  }
  expireHolds(state, emit);
  if (!st || st.combat?.status === 'wreck') return;

  if (zone !== 'docked') enforce(state, st, near.dM, zone, emit);
  callouts(state, st, near.dM, zone, emit);
  if (now >= tc.nextChatter) {
    tc.nextChatter = now + randInt(CHATTER_MIN[0], CHATTER_MIN[1]) * (zone === 'control' ? 2 : 1);
    const line = chatter(state, st);
    if (line) emit('tc-chatter', { station: st.id, name: st.name, voice: voice(st), ...line });
  }
}

/** A holding clearance run out: the slot goes back to the pattern. */
function expireHolds(state, emit) {
  const now = state.clock.minute;
  for (const [id, c] of Object.entries(state.tc.clear)) {
    if (!c.hold) continue;
    if (c.hold.until - now === 60) emit('nav-callout', { level: 'warn', text: `Holding clearance at ${getWorld(state).get(id)?.name} runs out in an hour. Ask again to renew it.` });
    if (c.hold.until > now) continue;
    const st = getWorld(state).get(id);
    if (st) releaseSlot(st, c.hold.slot, 'player');
    c.hold = null;
  }
}

/** The rules, minute by minute, with a warning before each step. */
function enforce(state, st, dM, zone, emit) {
  const tc = state.tc;
  const now = state.clock.minute;
  const inZone = now - tc.since;
  const cl = clearanceFor(state, st.id);
  const leaving = cl.depart || tc.outbound === st.id && closingOn(state, st) <= 1 || state.dock?.phase === 'undock' || state.dock?.phase === 'separate' || state.dock?.phase === 'holding' || state.dock?.phase === 'outbound';
  const warn = (key, text, level = 'warn') => {
    if (tc.warned[key]) return false;
    tc.warned[key] = now;
    emit('tc-warning', { station: st.id, name: st.name, voice: voice(st), key, level, text });
    return true;
  };
  const since = (key) => tc.warned[key] != null ? now - tc.warned[key] : -1;

  // Running dark in control space
  if (!state.comms.transponder && zone !== 'none') {
    if (inZone >= 5) warn('dark', `Unidentified ship in ${st.name} control space: squawk your transponder now.`);
    if (since('dark') >= 25 && !tc.warned.darkCited) {
      tc.warned.darkCited = now;
      cite(state, st.faction, { station: st.id, kind: 'running dark in control space', amount: 500 }, emit);
    }
  }

  // Loitering on the approach without clearance
  if ((zone === 'approach' || zone === 'keepout') && !cl.approach && !leaving && !state.dock) {
    warn('approach', `Ship on our approach, you have no clearance. State your intentions or clear to ${Math.round(APPROACH_M / 1e6) * 1000} km.`);
    if (since('approach') >= 15 && !tc.warned.loiterCited) {
      tc.warned.loiterCited = now;
      cite(state, st.faction, { station: st.id, kind: 'loitering on the approach', amount: 300 }, emit);
    }
    if (since('approach') >= 45 && !tc.warned.reported) {
      tc.warned.reported = now;
      if ((state.law.wanted[st.faction] ?? 0) < 1) state.law.wanted[st.faction] = 1;
      emit('tc-warning', { station: st.id, name: st.name, voice: voice(st), key: 'reported', level: 'danger', text: 'You have been reported to station security. Expect to be stopped.' });
    }
  }

  // Inside the gate without a berth
  if (zone === 'keepout' && !cl.dock && !leaving && !(state.dock && state.dock.target.id === st.id)) {
    warn('keepout', `FINAL WARNING. You are inside ${st.name}'s keep-out zone without docking clearance. Turn back now.`, 'danger');
    if (since('keepout') >= 5 && !tc.warned.trespass) {
      tc.warned.trespass = now;
      recordOffense(state, st.faction, 'trespass', STATIONS[st.id]?.military ? 2 : 1, emit, `inside the keep-out zone of ${st.name}`);
      emit('station-alert', { id: st.id, name: st.name, level: STATIONS[st.id]?.military ? 'hostile' : 'alert' });
    }
  }

  // Speed limits coming in
  const v = relSpeed(state, st);
  const limit = zone === 'keepout' ? KEEPOUT_SPEED_MS : zone === 'approach' ? APPROACH_SPEED_MS : Infinity;
  if (closingOn(state, st) > 0 && v > limit * 1.15 && now - tc.speedWarned > 10) {
    tc.speedWarned = now;
    emit('tc-warning', { station: st.id, name: st.name, voice: voice(st), key: 'speed', level: 'warn', text: `You are making ${Math.round(v)} m/s relative. The limit here is ${limit.toLocaleString()} m/s. Slow down.` });
    if (v > limit * 1.6) cite(state, st.faction, { station: st.id, kind: 'speeding in controlled space', amount: 250 }, emit);
  }

  // Clearances running out
  const dk = cl.dock;
  if (dk && dk.until - now === 15) emit('nav-callout', { text: `Docking clearance at ${st.name} expires in 15 minutes.`, level: 'warn' });
}

/** What our own nav computer calls out close to a hub: zones, range, the berth. */
function callouts(state, st, dM, zone, emit) {
  const tc = state.tc;
  if (zone === 'docked' || zone === 'none') { tc.callout = null; return; }
  const km = dM / 1000;
  let mark = null;
  for (const m of CALLOUTS_KM) if (km <= m) mark = m;          // the smallest mark we are inside
  if (closingOn(state, st) <= 0 || tc.outbound === st.id) { tc.callout = mark; return; }   // only coming in
  if (mark != null && mark !== tc.callout && (tc.callout == null || mark < tc.callout)) {
    tc.callout = mark;
    const v = relSpeed(state, st);
    const cl = clearanceFor(state, st.id);
    const what = cl.dock ? `berth ${cl.dock.berth} assigned` : cl.approach ? 'cleared to approach' : 'no clearance';
    emit('nav-callout', { text: `${st.name}: ${mark.toLocaleString()} km, ${Math.round(v)} m/s relative — ${what}.`, level: cl.approach || cl.dock ? 'info' : 'warn' });
  } else if (mark == null && tc.callout != null) tc.callout = null;
}

// ---- WORDS ----

/** Whose voice a station's traffic control speaks in. */
export function voice(st) {
  return { OPA: 'belter', UN: 'un', MCR: 'mcr' }[st.faction] || 'independent';
}

function zoneLine(state, st, zone, was) {
  const cl = clearanceFor(state, st.id);
  const tag = st.name.split(' ')[0];
  if (state.tc.outbound === st.id && zone !== 'docked') {
    return zone === 'approach' ? `${tag} Approach: you are outside the gate. Torch at your discretion.` : zone === 'control' ? `${tag} Traffic: clear of the approach. Good flight.` : '';
  }
  switch (zone) {
    case 'control': return was === 'approach' ? `${tag} Traffic: you are clear of the approach.` : `${tag} Traffic: entering ${st.name} control space. Transponder on, state your intentions on this channel.`;
    case 'approach': return cl.approach ? `${tag} Approach: we have you. Proceed to the gate.` : `${tag} Approach: you are on our approach without clearance. Hail us.`;
    case 'keepout': return cl.dock ? `${tag} Approach: inside the gate, ${cl.dock.berth} is waiting for you. Keep it under ${KEEPOUT_SPEED_MS} m/s.` : `${tag} Approach: you are inside the keep-out zone.`;
    case 'docked': return `${tag} Dock: hard seal confirmed. Welcome to ${st.name}.`;
    default: return '';
  }
}

const BELTER = ['kopeng', 'beratna', 'sabaka', 'ke'];

/**
 * One transmission of the station's traffic: clearing a real ship that is
 * due out of its berth or inbound to it, the berth board, an advisory.
 */
function chatter(state, st) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const tag = st.name.split(' ')[0];
  // Departures from the berth table, arrivals from the filed plans on the plot:
  // both small, where a spatial query round a busy port is not
  const departing = [], arriving = [];
  for (const id of [...Object.values(st.berths || {}), ...Object.values(st.holding || {})]) {
    const e = id !== 'player' && world.get(id);
    if (e?.transponder && e.tags?.until - now < 40 && e.tags.until - now > 0 && e.tags.call?.phase !== 'wait') departing.push(e);
    if (departing.length > 12) break;
  }
  const tracks = state.intel?.tracks || {};
  for (const id in tracks) {
    const r = tracks[id];
    if (r.kind !== 'plan' || (r.plan.to !== st.id && r.plan.to !== gateId(st.id)) || r.plan.t1 - now > 90 || r.plan.t1 < now) continue;
    const e = world.get(id);
    if (e?.transit) arriving.push(e);
    if (arriving.length > 6) break;
  }
  const b = berthCounts(state, st);
  const choices = [];
  if (departing.length) {
    const e = pick(departing);
    const leaving = e.tags.call?.phase === 'work' && e.tags.call.lay > 0;
    const where = e.tags.berth ? `${e.tags.berth}` : e.tags.slot ? `holding ${e.tags.slot}` : 'the anchorage';
    choices.push(leaving
      ? { kind: 'departure', ship: e.id, text: `"${e.name}", ${tag} Dock: clear ${where} when your transfer's done. Take holding ${freeSlot(state, st)?.id || 'at the anchorage'} for your layover.` }
      : { kind: 'departure', ship: e.id, text: `"${e.name}", ${tag} Traffic: cleared for departure from ${where}. Out through the gate, torch when clear.` });
  }
  if (arriving.length) {
    const e = pick(arriving);
    const free = freeBerthLabel(state, st, e);
    const slot = freeSlot(state, st);
    choices.push({ kind: 'arrival', ship: e.id, text: free
      ? `"${e.name}", ${tag} Approach: if you're working cargo, cleared to ${free}. Down the corridor under ${KEEPOUT_SPEED_MS} m/s. Otherwise take holding ${slot?.id || 'at the anchorage'}.`
      : `"${e.name}", ${tag} Approach: all berths taken. Take holding ${slot?.id || 'at the anchorage'}, we'll call you down.` });
  }
  const h = slotCounts(state, st);
  choices.push({ kind: 'board', text: `${tag} Traffic, all stations: ${b.used} of ${b.total} berths occupied, ${h.used} in the holding pattern. Report traffic to this channel.` });
  if (chance(0.35)) choices.push({ kind: 'advisory', text: pick(ADVISORIES).replace('{tag}', tag).replace('{gate}', STATIONS[st.id]?.gateKm || 50) });
  const line = pick(choices);
  if (voice(st) === 'belter' && chance(0.4)) line.text = line.text.replace(/\.$/, `, ${pick(BELTER)}.`);
  return line;
}

function freeBerthLabel(state, st, e) {
  const m = stationModel(st.id);
  const world = getWorld(state);
  const ports = hullOf(e.cls)?.ports || [];
  const b = m?.berths.find(b => !berthOccupant(world, st, b.id) && ports.some(p => berthFits(b, p.size)));
  return b ? b.label.toLowerCase() : null;
}

const ADVISORIES = [
  '{tag} Traffic, all stations: drive plumes are prohibited inside the gate at {gate} km. Violators will be cited.',
  '{tag} Traffic, all stations: keep transponders squawking in control space.',
  '{tag} Traffic, all stations: debris reported on the outbound corridor. Use caution.',
  '{tag} Traffic, all stations: holding traffic, keep your assigned slots. No drive plumes in the pattern.',
  '{tag} Traffic, all stations: speed limit inside the gate is 200 metres per second.',
  '{tag} Traffic, all stations: customs inspections in progress on the approach.',
];

/**
 * A station's traffic board for the UI: berths, the holding pattern, the
 * anchorage, ships inbound. From its tables and the plot's filed plans,
 * not a search of a busy port's space.
 */
export function stationTraffic(state, st) {
  const world = getWorld(state);
  const b = berthCounts(state, st), h = slotCounts(state, st);
  const now = state.clock.minute;
  let inbound = 0;
  const tracks = state.intel?.tracks || {};
  for (const id in tracks) {
    const r = tracks[id];
    if (r.kind === 'plan' && (r.plan.to === st.id || r.plan.to === gateId(st.id) || r.plan.port === st.id) && r.plan.t1 > now) inbound++;
  }
  // the anchorage: what overflowed the pattern (a short query: few ships, far out)
  _q.length = 0;
  world.query(st.pos, STATIONS[st.id] ? (STATIONS[st.id].anchorKm + 200) * 1000 / AU_M : 0.001, _q);
  let anchored = 0;
  for (const e of _q) if (e.type === 'ship' && e.tags?.at === st.id && !e.tags.berth && !e.tags.slot) anchored++;
  return { ...b, berthed: b.used, holding: h.used, holdingTotal: h.total, anchored, inbound };
}
