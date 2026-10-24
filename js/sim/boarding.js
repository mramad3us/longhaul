// ============================================================
// LONGHAUL — Boarding: our people aboard another hull
//
// A boarding is an operation with a party of our crew. It goes:
//   muster   the party suits up and goes to the airlock (crew-ai.js:
//            the 'board' task): the collar we are docked by, or for an
//            EVA the nearest lock
//   cross    through the mated collar (two minutes), or across open
//            space on suit thrusters (at most EVA_RANGE_M, 2 m/s)
//   breach   a hatch nobody opens for us is cut (EVA: ten minutes; a
//            mated collar's inner hatch: six)
//   fight    if anyone aboard resists (below)
//   secured  the ship is ours to search, strip, take prisoners from or
//            scuttle (actions, each taking time); a wreck's to salvage
//            (run after run, each giving less: scrap, spares, stores),
//            and any ship's computer to crack for its credit store
//   return   back across, and the party is aboard again.
// While away the party is off our ship: not in its rooms, not breathing
// its air, not at its stations, and we cannot leave without them.
//
// THE FIGHT. Who resists depends on who they are and how they got here:
// a navy crew fights for every compartment, pirates nearly as hard, a
// police crew hard; a civilian crew mostly hides. A crew that struck its
// colours mostly doesn't fight at all, though a few holdouts might. Each
// minute both sides trade hits in proportion to their strength (a
// boarder's is their security skill, health and spirits; the defenders
// have the cover). Our wounded take real injuries (crew.js). Defenders
// give up when most of them are down; the party falls back when most of
// it is, and anyone it can't carry is taken prisoner.
//
// THE LAW. Boarding a lawful ship that hasn't invited us is piracy.
// Boarding pirates, the wanted, or a ship that fought us and struck is
// not, and nor is salvaging a wreck. Taking a lawful ship's credits is
// theft, wreck or not.
//
// SALVAGE. Each run is three-quarters of an hour of cutting; what comes
// out is chance, better with a good engineer in the party, and less each
// time (the easy pickings go first: SALVAGE_DECAY). A wreck is dangerous
// to work in: a party member can be hurt by what shifts.
//
// What can be boarded is a question for BOARDABLE: ships today; stations
// (a docking ring, a hab section) come later, through the same phases.
// ============================================================

import { AU_M } from '../core/constants.js';
import { random, randInt, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { classOf } from './ship-classes.js';
import { isAble, applyImpact, overallHealth, mourn } from './crew.js';
import { efficiency } from './needs.js';
import { crewAboard, passengersAboard, setCrewAboard, learn, freeCells } from './manifest.js';
import { prisonerGroup } from './prisoners.js';
import { PLAYER, ensureHull } from './combatants.js';
import { lawfulTarget, recordOffense } from './law.js';
import { isDocked, dockedTo } from './docking.js';
import { shipGeometry, airlockFor } from './ship-layout.js';
import { ourName } from './service.js';

export const EVA_RANGE_M = 2_000;
const EVA_SPEED_MS = 2;
const COLLAR_MIN = 2;
const BREACH_EVA_MIN = 10;
const BREACH_COLLAR_MIN = 6;
const MUSTER_LIMIT_MIN = 25;
const SEARCH_MIN = 20, STRIP_MIN = 40, PRISONERS_MIN = 15, SCUTTLE_MIN = 10, SALVAGE_MIN = 45, ACCOUNTS_MIN = 30;
const SALVAGE_DECAY = 0.55;           // what a wreck still holds after a run, of what it held

/** How hard a crew resists boarders (share that fights · quality of each). */
const RESIST = {
  military: [1, 0.75], authority: [0.85, 0.6], irregular: [0.9, 0.55], civilian: [0.3, 0.3],
};

// ---- WHAT CAN BE BOARDED ----

/**
 * Can this target be boarded, and how? Returns { ok, via: ['dock'|'eva'],
 * text }. Stations are a later update: the answer says so.
 */
export function boardable(state, e) {
  if (!e) return { ok: false, text: 'Nothing there.' };
  if (e.type === 'station') return { ok: false, text: 'Boarding a station is a marine operation: not yet.' };
  if (e.type !== 'ship') return { ok: false, text: 'Nothing to board.' };
  if (e.tags?.blown) return { ok: false, text: 'There is nothing left to board.' };
  const via = [];
  if (isDocked(state) && dockedTo(state)?.id === e.id) via.push('dock');
  const dM = Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y) * AU_M;
  const still = Math.hypot(e.vel.vx - state.flight.vel.vx, e.vel.vy - state.flight.vel.vy) < 2 && (e.thrust || 0) < 0.01;
  if (dM <= EVA_RANGE_M && still) via.push('eva');
  if (!via.length) return { ok: false, text: dM > EVA_RANGE_M ? `Too far for an EVA crossing (${(dM / 1000).toFixed(1)} km; ${EVA_RANGE_M / 1000} km at most). Close in or dock.` : 'Match its motion first: nobody crosses to a ship under way.' };
  return { ok: true, via, distM: dM };
}

/** Is our boarding invited (they asked for help, or are being inspected)? */
const invited = (e) => !!e.tags?.invite || !!e.tags?.locksOpen;

/** Who would take a party aboard: the able, suited if crossing open space. */
export function eligibleBoarders(state, via) {
  const suits = Object.values(state.lifeSupport.lockers).filter(l => l.hasSuit).length;
  return state.ship.crew.filter(m => isAble(m) && !m.away && (via === 'dock' || m.suit.wearing || suits > 0));
}

// ---- STARTING ----

/**
 * Send a party. opts: { party: [crew ids], via: 'dock'|'eva' }.
 * Returns { ok, text }.
 */
export function startBoarding(state, targetId, { party, via }, emit = () => {}) {
  if (state.boarding && state.boarding.phase !== 'done') return { ok: false, text: 'A boarding is already under way.' };
  const e = getWorld(state).get(targetId);
  const can = boardable(state, e);
  if (!can.ok) return can;
  if (!can.via.includes(via)) via = can.via[0];
  const members = party.map(id => state.ship.crew.find(m => m.id === id)).filter(m => m && isAble(m) && !m.away);
  if (!members.length) return { ok: false, text: 'Pick who goes.' };
  if (via === 'eva') {
    const suits = Object.values(state.lifeSupport.lockers).filter(l => l.hasSuit).length + members.filter(m => m.suit.wearing).length;
    if (suits < members.length) return { ok: false, text: `Only ${suits} suits aboard for a party of ${members.length}.` };
  }
  const h = ensureHull(e);
  const c = classOf(e);
  const [share, quality] = RESIST[c?.category] || RESIST.civilian;
  const aboard = crewAboard(e);
  const struck = h.status === 'surrendered' || h.status === 'wreck';      // (a wreck's survivors don't fight)
  const beaten = struck || h.status === 'disabled' || h.drive < 0.25;
  const pirate = e.faction === 'pirate' || c?.category === 'irregular';
  const fight = invited(e) ? 0 : struck ? (chance(pirate ? 0.3 : 0.12) ? Math.max(1, Math.round(aboard * 0.15)) : 0)
    : Math.round(aboard * share * (beaten ? 0.6 : 1) * (0.8 + 0.4 * random()));
  state.boarding = {
    id: `bd-${state.clock.minute}`, target: e.id, name: e.name, via,
    party: members.map(m => m.id), phase: 'muster', since: state.clock.minute, startedAt: state.clock.minute,
    defenders: fight, defendersStart: fight, quality, hatchOpen: invited(e) || struck,
    crossMin: via === 'dock' ? COLLAR_MIN : Math.max(1, Math.ceil(can.distM / EVA_SPEED_MS / 60)),
    secured: false, done: {}, action: null, log: [], lawful: !lawfulTarget(e) || invited(e) || struck && !!e.agent?.aggressor,
  };
  if (!state.boarding.lawful && !e.tags?.boardedCrime) {
    e.tags.boardedCrime = true;
    recordOffense(state, e.faction, 'piracy', 3, emit, `boarded ${e.name}`);
  }
  note(state, `Boarding party (${members.map(m => m.name).join(', ')}) mustering for ${e.name}, ${via === 'dock' ? 'through the collar' : 'by EVA'}.`, emit);
  emit('boarding', { phase: 'muster', target: e.name });
  return { ok: true, text: `Boarding party mustering at the lock: ${members.length} going across ${via === 'dock' ? 'the collar' : 'by EVA'}.` };
}

function note(state, text, emit, level = 'info') {
  const b = state.boarding;
  if (b) { b.log.push({ at: state.clock.minute, text }); if (b.log.length > 30) b.log.shift(); }
  emit('boarding-log', { text, level });
}

// ---- PER MINUTE ----

const membersOf = (state, b) => b.party.map(id => state.ship.crew.find(m => m.id === id)).filter(Boolean);

export function boardingTick(state, emit = () => {}) {
  const b = state.boarding;
  if (!b || b.phase === 'done') return;
  const e = getWorld(state).get(b.target);
  const now = state.clock.minute;
  const party = membersOf(state, b);
  if (!e || e.tags?.blown) {
    // the ship is gone: anyone aboard went with it
    for (const m of party) if (m.away && !m.dead) { m.away = null; m.dead = true; m.conditions.push('dead'); emit('crew-died', { member: m }); }
    note(state, `${b.name} is gone, and the party with it.`, emit, 'danger');
    b.phase = 'done';
    return;
  }
  switch (b.phase) {
    case 'muster': {
      // (an EVA crosses open space: nobody goes without a suit; and nobody ashore is waited for)
      const ready = party.filter(m => m.task?.type === 'board' && m.task.phase === 'ready' && (b.via !== 'eva' || m.suit.wearing));
      const able = party.filter(m => isAble(m) && !m.away);
      if ((ready.length && ready.length === able.length) || now - b.since > MUSTER_LIMIT_MIN && ready.length) {
        b.party = ready.map(m => m.id);
        for (const m of ready) { m.away = { op: b.id, aboard: e.id }; m.task = null; m.seat = null; m.path = []; m.activity = 'away'; }
        b.phase = 'cross'; b.since = now;
        note(state, `Party through the lock: ${ready.length} ${b.via === 'dock' ? 'in the collar' : 'crossing on suit thrusters'}.`, emit);
      } else if (!able.length) { b.phase = 'done'; note(state, 'Nobody fit to go: boarding called off.', emit, 'warn'); }
      return;
    }
    case 'cross':
      if (now - b.since >= b.crossMin) {
        b.since = now;
        if (b.hatchOpen) { b.phase = b.defenders > 0 ? 'fight' : 'secured'; arrive(state, b, e, emit); }
        else { b.phase = 'breach'; note(state, `At their hatch. It's locked: cutting.`, emit); }
      }
      return;
    case 'breach':
      if (now - b.since >= (b.via === 'dock' ? BREACH_COLLAR_MIN : BREACH_EVA_MIN)) {
        b.since = now;
        b.phase = b.defenders > 0 ? 'fight' : 'secured';
        note(state, 'Hatch cut through. Party inside.', emit);
        arrive(state, b, e, emit);
      }
      return;
    case 'fight': fightMinute(state, b, e, party, emit); return;
    case 'secured': actionMinute(state, b, e, party, emit); return;
    case 'return':
      // (they can only come back across what they can cross: our collar still on theirs, or suit range)
      if (!withinReach(state, b, e)) {
        b.since = now;
        if (!b.waitNoted) { b.waitNoted = true; note(state, `Party ready to come back: bring us within ${EVA_RANGE_M / 1000} km of ${e.name}.`, emit, 'warn'); }
        return;
      }
      if (now - b.since >= b.crossMin) comeHome(state, b, emit);
      return;
  }
}

/** Can the party cross between the hulls now: still mated at the collar, or within suit range? */
function withinReach(state, b, e) {
  if (b.via === 'dock' && state.dock?.target.id === e.id && state.dock.phase === 'docked') return true;
  return Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y) * AU_M <= EVA_RANGE_M;
}

function arrive(state, b, e, emit) {
  if (b.phase === 'secured') secure(state, b, e, emit);
  else note(state, `Contact: ${b.defenders} aboard ${b.name} are fighting.`, emit, 'danger');
}

/** One minute of a fight aboard. */
function fightMinute(state, b, e, party, emit) {
  const ours = party.filter(m => m.away && isAble(m));
  if (!ours.length || ours.length <= Math.floor(b.party.length * 0.3)) {
    // fall back: the able carry who they can; the rest are taken
    const left = party.filter(m => m.away && !isAble(m) && !m.dead);
    const carried = left.slice(0, ours.length);
    for (const m of left.slice(ours.length)) { m.away.captured = true; m.away.by = e.id; note(state, `${m.name} is left behind, a prisoner aboard ${e.name}.`, emit, 'danger'); }
    b.party = party.filter(m => !m.away?.captured).map(m => m.id);
    b.phase = 'return'; b.since = state.clock.minute;
    note(state, `The party falls back${carried.length ? `, carrying ${carried.map(m => m.name).join(', ')}` : ''}.`, emit, 'danger');
    return;
  }
  const power = ours.reduce((s, m) => s + (0.3 + 0.7 * m.skills.security / 100) * overallHealth(m) / 100 * (0.6 + 0.4 * efficiency(m)), 0);
  const theirs = b.defenders * b.quality * 1.3;
  // their losses
  const down = poisson(power * 0.22);
  if (down > 0) {
    b.defenders = Math.max(0, b.defenders - down);
    const n = crewAboard(e);
    setCrewAboard(e, n - Math.min(n, down * (chance(0.4) ? 1 : 0)));        // some of the downed are dead
    note(state, `${down} of them down. ${b.defenders} still fighting.`, emit);
  }
  // ours
  const hits = poisson(theirs * 0.18);
  for (let i = 0; i < hits; i++) {
    const m = ours[randInt(0, ours.length - 1)];
    const r = applyImpact(m, 2.5 + random() * 9);
    if (!r) continue;
    const what = m.dead ? 'killed' : r.severity === 'bruise' ? 'grazed' : r.severity === 'hard-impact' ? 'wounded' : 'badly hurt';
    note(state, `${m.name} ${what}.`, emit, 'danger');
    if (m.dead) { mourn(state.ship.crew, m); emit('crew-died', { member: m }); }
    else emit('crew-wounded', { member: m, message: `${m.name} ${what} in the fighting aboard ${e.name}` });
  }
  // they give up when most are down
  if (b.defenders === 0 || (b.defenders <= Math.ceil(b.defendersStart * (b.quality > 0.7 ? 0.1 : 0.35)) && chance(0.5))) {
    if (b.defenders > 0) note(state, `The last ${b.defenders} throw down their weapons.`, emit);
    b.defenders = 0;
    b.phase = 'secured';
    secure(state, b, e, emit);
  }
}

function poisson(lambda) {
  let n = 0, p = Math.exp(-lambda), s = p, u = random();
  while (u > s && n < 50) { n++; p *= lambda / n; s += p; }
  return n;
}

/** The ship is ours: its crew are counted, its colours struck. */
function secure(state, b, e, emit) {
  b.secured = true;
  b.since = state.clock.minute;
  const h = ensureHull(e);
  if (h.status === 'ok' || h.status === 'disabled') h.status = 'surrendered';
  if (e.agent) { e.agent.mode = 'surrendered'; e.agent.cmd = null; e.agent.hostile = []; }
  e.thrust = 0;
  const crew = crewAboard(e), pax = passengersAboard(e);
  learn(state, e, { crew, pax, note: 'Boarded and secured' }, 'boarded', { by: ourName(state) });
  // freed: anyone of ours held aboard
  for (const m of state.ship.crew) if (m.away?.captured && m.away.by === e.id) { m.away = { op: b.id, aboard: e.id }; if (!b.party.includes(m.id)) b.party.push(m.id); note(state, `${m.name} found and freed.`, emit); }
  note(state, `${b.name} secured. ${crew} crew${pax ? ` and ${pax} passengers` : ''} aboard.`, emit, 'ok');
  emit('boarding', { phase: 'secured', target: e.name, crew, pax });
}

// ---- ACTIONS ABOARD ----

export const BOARDING_ACTIONS = {
  search: { label: 'SEARCH', min: SEARCH_MIN, desc: 'Go through the ship: manifest, cargo, logs, anything hidden.' },
  strip: { label: 'TAKE STORES', min: STRIP_MIN, desc: 'Carry over reaction mass, spares, food, water, medical supplies and ammunition, as much as we hold.' },
  cargo: { label: 'TAKE CARGO', min: STRIP_MIN, desc: 'Move their hold into ours (docked only: nobody carries tonnes by EVA).' },
  prisoners: { label: 'TAKE PRISONERS', min: PRISONERS_MIN, desc: 'Bring their crew aboard as prisoners: into the brig\'s cells (a warship has them), then any empty berths.' },
  scuttle: { label: 'SCUTTLE', min: SCUTTLE_MIN, desc: 'Set their reactor to lose containment in half an hour, and get off.' },
  salvage: { label: 'SALVAGE', min: SALVAGE_MIN, repeat: true, desc: 'Cut what is still good out of the wreck: scrap for the machine shop, spare parts, stores from tanks that held. Each run gives less. Wrecks shift: someone can get hurt.' },
  accounts: { label: 'CRACK ITS ACCOUNTS', min: ACCOUNTS_MIN, desc: 'Into the computer core for its credit store: a good engineer gets in more often, and a core can wipe itself. Theft, unless it was a pirate.' },
};

/** What the party can do aboard now, and why not. */
export function boardingActions(state) {
  const b = state.boarding;
  if (!b || b.phase !== 'secured') return [];
  const e = getWorld(state).get(b.target);
  return Object.entries(BOARDING_ACTIONS).map(([id, a]) => {
    let why = (b.done[id] || ONCE_PER_HULL.has(id) && e.tags?.taken?.[id]) && !a.repeat ? 'done' : null;
    if (!why && id === 'salvage' && ensureHull(e).status !== 'wreck') why = 'not a wreck: take stores';
    if (!why && id === 'salvage' && (e.tags.salvageLeft ?? 1) < 0.05) why = 'stripped bare';
    if (!why && id === 'cargo' && !(b.via === 'dock' && state.dock?.target.id === b.target && state.dock.phase === 'docked')) why = 'dock first';
    if (!why && id === 'prisoners' && freeCells(state) <= 0) why = 'no free cells or berths';
    if (!why && id === 'prisoners' && crewAboard(e) <= 0) why = 'nobody left aboard';
    return { id, ...a, why, running: b.action?.id === id };
  });
}

/** Orders that empty a hull once, whoever boards it after (its stores, its hold, its credit store). */
const ONCE_PER_HULL = new Set(['strip', 'cargo', 'accounts']);


/** Give the party an order aboard. */
export function orderAboard(state, actionId, emit = () => {}) {
  const b = state.boarding;
  if (!b || b.phase !== 'secured') return { ok: false, text: 'Nothing secured.' };
  if (actionId === 'withdraw') { b.phase = 'return'; b.since = state.clock.minute; b.action = null; note(state, 'Party returning.', emit); return { ok: true, text: 'Party coming back across.' }; }
  const a = boardingActions(state).find(x => x.id === actionId);
  if (!a) return { ok: false, text: 'No such order.' };
  if (a.why) return { ok: false, text: a.why };
  b.action = { id: actionId, until: state.clock.minute + a.min };
  note(state, `${a.label.toLowerCase()} — ${a.min} minutes.`, emit);
  return { ok: true, text: `${a.label}: ${a.min} minutes.` };
}

function actionMinute(state, b, e, party, emit) {
  const a = b.action;
  if (!a || state.clock.minute < a.until) return;
  b.action = null;
  b.done[a.id] = true;
  // (the hull remembers what was taken from it, or wiped: boarding it again finds it gone)
  if (ONCE_PER_HULL.has(a.id)) (e.tags.taken ||= {})[a.id] = true;
  const R = state.resources;
  const c = classOf(e);
  switch (a.id) {
    case 'search': {
      const crew = crewAboard(e), pax = passengersAboard(e);
      const fill = 0.2 + 0.7 * random();
      b.found = { crew, pax, holdT: Math.round((c?.cargoT || 0) * fill), contraband: e.faction === 'pirate' || chance(0.08) };
      learn(state, e, { crew, pax, note: `Searched: ${b.found.holdT.toLocaleString()} t in the hold${b.found.contraband ? ', contraband among it' : ''}` }, 'boarded');
      note(state, `Search done: ${crew} crew, ${pax} passengers, ${b.found.holdT.toLocaleString()} t in the hold${b.found.contraband ? ' — some of it contraband' : ''}.`, emit, 'ok');
      return;
    }
    case 'strip': {
      const h = ensureHull(e);
      const take = (key, n) => { const r = R[key]; if (!r) return 0; const got = Math.max(0, Math.min(n, r.max - r.current)); r.current += got; return got; };
      const size = { S: 1, M: 3, L: 8, XL: 20 }[c?.size || 'M'];
      const got = {
        fuel: take('fuel', 600 * size), water: take('water', 300 * size), food: take('food', 120 * size),
        medSupplies: take('medSupplies', 4 * size), parts: take('parts', randInt(1, 3) * size), pdcRounds: take('pdcRounds', Math.min(h.rounds, 5000)),
      };
      h.rounds = Math.max(0, h.rounds - got.pdcRounds);
      const M = state.magazine;
      let torps = 0;
      for (const w of ['he', 'nuke']) while (h.magazine[w] > 0 && M.he + M.nuke < M.capacity) { h.magazine[w]--; M[w]++; torps++; }
      const words = Object.entries(got).filter(([, v]) => Math.round(v) > 0).map(([k, v]) => `${Math.round(v).toLocaleString()} ${k === 'pdcRounds' ? 'PDC rounds' : k === 'medSupplies' ? 'med units' : k}`);
      if (torps) words.push(`${torps} torpedo${torps > 1 ? 'es' : ''}`);
      note(state, words.length ? `Stores carried over: ${words.join(', ')}.` : 'Nothing worth carrying, or nowhere to put it.', emit, 'ok');
      return;
    }
    case 'cargo': {
      const holdT = b.found?.holdT ?? Math.round((c?.cargoT || 0) * 0.5);
      const roomKg = state.cargoCapacity - state.cargo.reduce((s, x) => s + x.mass, 0);
      const mass = Math.max(0, Math.min(roomKg, holdT * 1000));
      if (mass <= 0) { note(state, 'No room in our hold.', emit, 'warn'); return; }
      state.cargo.push({ name: `Seized cargo (${e.name})`, mass, value: Math.round(mass * 0.4), seized: true, from: e.id, contraband: !b.lawful || b.found?.contraband, illegalIn: !b.lawful ? null : undefined });
      note(state, `${Math.round(mass / 1000).toLocaleString()} t moved into our hold.`, emit, 'ok');
      return;
    }
    case 'prisoners': {
      const n = Math.min(crewAboard(e), freeCells(state));
      if (n <= 0) return;
      const g = prisonerGroup(state, e, n);           // (its officers first: prisoners.js)
      setCrewAboard(e, crewAboard(e) - n);
      state.passengers.push(g);
      note(state, `${n} prisoner${n > 1 ? 's' : ''} brought aboard${g.notables ? `, ${g.notables === 1 ? 'its captain' : `${g.notables} of its officers`} among them` : ''}${state.ship.decks.some(d => d.id === 'brig') ? ', and locked in the brig' : ''}.`, emit, 'ok');
      return;
    }
    case 'salvage': {
      const left = e.tags.salvageLeft ?? 1;
      const size = { S: 1, M: 3, L: 8, XL: 20 }[c?.size || 'M'];
      const eng = Math.max(0, ...party.map(m => m.skills.engineering || 0));
      const luck = (0.5 + eng / 200) * left;
      const take = (key, n) => { const r = R[key]; if (!r || n <= 0) return 0; const got = Math.floor(Math.max(0, Math.min(Math.round(n), r.max - r.current))); r.current += got; return got; };
      const found = [];
      const scrap = chance(Math.min(0.95, 0.4 + left)) ? take('scrap', randInt(2, 6) * size * Math.max(luck, 0.2)) : 0;
      if (scrap) found.push(`${scrap} scrap`);
      const parts = chance(0.5 * luck) ? take('parts', randInt(1, 3) * Math.ceil(size / 2)) : 0;
      if (parts) found.push(`${parts} spare part${parts > 1 ? 's' : ''}`);
      if (chance(0.6 * left)) {
        for (const [k, per, word] of [['fuel', 300, 'kg of reaction mass'], ['water', 150, 'L of water'], ['o2Tank', 20, 'kg of oxygen'], ['food', 40, 'rations'], ['medSupplies', 2, 'med units']]) {
          if (!chance(0.5)) continue;
          const got = take(k, per * size * luck * (0.3 + random()));
          if (got) found.push(`${got.toLocaleString()} ${word}`);
        }
      }
      e.tags.salvageLeft = left * SALVAGE_DECAY;
      note(state, found.length ? `Salvage run: ${found.join(', ')}.` : 'Salvage run: nothing worth the cutting (or nowhere to put it).', emit, found.length ? 'ok' : 'warn');
      // a wreck works back: something shifts
      if (chance(0.08 * (1.2 - eng / 100))) {
        const m = party[randInt(0, party.length - 1)];
        const r = m && applyImpact(m, randInt(8, 25));
        if (r) note(state, `${m.name} hurt when a bulkhead shifted.`, emit, 'danger');
      }
      return;
    }
    case 'accounts': {
      const eng = Math.max(0, ...party.map(m => m.skills.engineering || 0));
      const pirate = e.faction === 'pirate' || c?.category === 'irregular';
      if (!chance(Math.min(0.9, 0.25 + eng / 150))) { note(state, 'The core locked us out and wiped its accounts.', emit, 'warn'); return; }
      const size = { S: 1, M: 2, L: 4, XL: 6 }[c?.size || 'M'];
      const credits = Math.round(randInt(300, 2500) * size * (pirate ? 1.5 : 1) / 10) * 10;
      R.credits.current += credits;
      note(state, `Into the core: ${credits.toLocaleString()} MCR transferred from its credit store.`, emit, 'ok');
      if (!pirate && e.faction in state.law.standing) recordOffense(state, e.faction, 'theft', 1, emit, `took ${e.name}'s credits`);
      return;
    }
    case 'scuttle': {
      const h = ensureHull(e);
      h.containment = 30;
      h.scrammed = false;
      h.lastHitBy = PLAYER;
      e.tags.scuttled = true;
      note(state, `Charges set on ${e.name}'s reactor: thirty minutes. Get clear.`, emit, 'danger');
      b.phase = 'return'; b.since = state.clock.minute;
      return;
    }
  }
}

/** The party is home: through our airlock, back at their posts. */
function comeHome(state, b, emit) {
  const geo = shipGeometry(state.ship);
  const lock = airlockFor(state.ship, state.dock?.port);
  const node = lock?.access != null ? geo.nodes[lock.access] : geo.nodes[0];
  for (const m of membersOf(state, b)) {
    if (!m.away || m.away.captured) continue;
    m.away = null;
    m.pos = { sx: node.sx, sy: node.sy };
    m.$px = node.sx; m.$py = node.sy;
    m.task = null; m.path = []; m.seat = null;
  }
  b.phase = 'done';
  b.endedAt = state.clock.minute;
  note(state, 'Party back aboard.', emit, 'ok');
  emit('boarding', { phase: 'done', target: b.name });
}

/** Call the party back (from any phase). */
export function recallParty(state, emit = () => {}) {
  const b = state.boarding;
  if (!b || b.phase === 'done') return false;
  if (b.phase === 'muster') {
    for (const m of membersOf(state, b)) if (m.task?.type === 'board') { m.task = null; m.path = []; }
    b.phase = 'done';
    note(state, 'Boarding called off.', emit);
    return true;
  }
  if (b.phase === 'fight' || b.phase === 'secured' || b.phase === 'breach' || b.phase === 'cross') {
    b.phase = 'return'; b.since = state.clock.minute; b.action = null;
    note(state, 'Party recalled.', emit);
  }
  return true;
}

/** Is anyone of ours over there? */
export const partyAway = (state) => state.ship.crew.some(m => m.away && !m.away.captured);

