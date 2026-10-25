// ============================================================
// LONGHAUL — VIGIL: the ship's computer, minding the captain's business
//
// The console keeps one line at its foot for the ship's computer. It
// reads the whole game state and says what the captain should know now,
// most urgent first, each with one-click actions. This module is its
// brain: pure logic over the state, no DOM. The UI calls advise() a few
// times a second, shows the top advisory on the line, lists the rest in
// the AI's window, and runs the actions it picks (ai-line.js).
//
// THE NAME. VIGIL: a vigil is the watch kept through the night, and
// that is the job. The crew sleep in shifts; the watch computer never
// does. It reads as a callsign, fits the line, and promises nothing
// cute.
//
// LEVELS (LEVELS):
//   warning (3)  the ship or someone aboard is in danger now: ordnance
//                inbound, a fire, a breach, containment failing, someone
//                dying, a navy gone weapons-free on us, falling onto a
//                rock, a hull we scuttled about to go with us too close
//   caution (2)  something wants an answer or will cost us soon: a hail
//                with a deadline, a lease running out, a flip held for the
//                crew, a distress call, orders from command, the law
//   advice  (1)  a sensible next step: the board here, a top-up, the
//                contract we are not yet flying to, shore leave
//   info    (0)  what we are doing (course, flip, arrival), only when
//                nothing else is said: a quiet line is a good line
// Within a level, a rank orders them (a request that expires sooner comes
// first). At most MAX_SHOWN are returned.
//
// KEYS. Every advisory has a key that names the situation, not the
// sentence: 'fire' while anything burns, 'request:rq-7' for one hail,
// 'stores:water' for the water. The same situation gives the same key
// on every call, so the UI can dedupe, animate only what is new, and
// dismiss by key. Each also carries a signature (internal): what about
// the situation would make it news again (a fire spreading to another
// deck, a second torpedo, a lease passing from "soon" to "over").
//
// MEMORY. The UI keeps one plain object across calls and passes it in;
// nothing here is written into the game state. The UI writes
// memory.dismissed[key] = minute when the captain dismisses one. The
// advisor keeps its own bookkeeping beside it, under keys starting with
// an underscore: the signature last shown for each key, the signature the
// captain dismissed, when each key was last raised, threshold latches
// (hysteresis, so a value hovering on a line doesn't flicker), and a
// cache of slow lookups. A dismissed advisory stays quiet until
//   - its signature gains something new (a new threat, another deck),
//   - a call found it gone, and it came back GONE_MIN or more after
//     (a new occurrence; at time warp calls are hours apart, so "gone" is
//     what a call saw, not how long it was since the last), or
//   - QUIET_MIN for its level has passed (warnings come back soonest).
//
// VOICE. One short sentence (≤ 90 characters), first person plural for
// the ship ("We have…"), the facts and the number that matters, in the
// units the console shows (km, G, MCR; durations by formatDuration).
// Never cute, least of all in an emergency. A longer `detail` says why
// and what the rules are (what silence means, what an action costs).
//
// ACTIONS are plain descriptors the UI executes (act.type):
//   plot { target, dock? }    open the route planner on a target
//   open { window, id?, tab? } windows: station (tabs board, deliver,
//        market, services, berth, hire, leave, traffic), missions, comms, systems,
//        roster, service, library, boarding, shuttles, markets, jobs, weapons, map;
//        crew (id: that hand's panel)
//   toggle { what }           'combat' (battle stations) | 'suits'
//   respond { request, option } answer a comm request
//   hail { id }               open a channel (also completes a rescue or
//                             a contract's rendezvous in formation)
//   request-docking { id } · request-departure { id } · dock { id } ·
//   speed { value }           traffic control, the dock, time warp (a bare
//                             undock is never offered: a route plotted from
//                             a berth undocks and climbs out by itself)
//   select { target }         show it on the map
//   order { what }            a captain's order the sim has a call for:
//        'scram' (reactor.orderShutdown in a containment failure),
//        'execute' (autopilot.overrideSecure), 'flip-now'
//        (autopilot.forceTurn), 'pdc-auto' (combat.setPdcMode auto),
//        'evasive' (combat.setEvasive on), 'transponder-on'
//
// COST. Called about four times a second, at any time warp: it looks only
// at bounded things (sensor contacts, the driven agents and ordnance, comm
// requests, our contracts and distress calls, the handful of stations, our
// decks, crew and machinery), never the world's population. The political
// map lookup is cached per game minute.
// ============================================================

import { AU_M, DAY_MIN, MIN_S, G0 } from '../core/constants.js';
import { formatDuration } from '../core/clock.js';
import { fmtMeters, fmtG, fmtNum } from './dom.js';
import { getWorld } from '../sim/world.js';
import { PLAYER } from '../sim/combatants.js';
import { threats } from '../sim/combat.js';
import { blastClearM } from '../sim/damage.js';
import { hostilesOfPlayer } from '../sim/agents.js';
import { isIdentified } from '../sim/sensors.js';
import { CLASSES, playerClass } from '../sim/ship-classes.js';
import { FACTIONS, POWERS, controlAt } from '../sim/factions.js';
import { zonesAt, zonePos, ZONE_KINDS } from '../sim/conflict.js';
import { ReactorState, isReactorOnline } from '../sim/reactor.js';
import { atmoStatus } from '../sim/life-support.js';
import { shipGeometry, isSecureSeat } from '../sim/ship-layout.js';
import { SYSTEMS, Status, shipSystems, partsFor, waterRecovery } from '../sim/systems.js';
import { JobType } from '../sim/jobs.js';
import { needsMedical } from '../sim/crew.js';
import { FUEL_PER_G_MIN } from '../sim/flight.js';
import { nearestSurface } from '../sim/gravity.js';
import { timeToImpact } from '../sim/terrain.js';
import { targetName, PREP_MINUTES, DEPART_OUT } from '../sim/nav.js';
import { maxSpeed, possessive } from '../sim/autopilot.js';
import { STATIONS, berthOf } from '../sim/stations.js';
import { clearanceFor, refusal, APPROACH_M } from '../sim/traffic-control.js';
import { FREE_LEASE_MIN, LEASE_RATE } from '../sim/leases.js';
import { dockedStationEntity, dockedTo } from '../sim/docking.js';
import { contractor, hullLegal, navyOf, openCallups, flagOf } from '../sim/service.js';
import { commandOnStation } from '../sim/forces.js';
import { milRefusal } from '../sim/military.js';
import { dockedPort, deliverable, inPort, needsBerth, contractsAt, CONTRACT_LABEL } from '../sim/contracts.js';
import { activeRuns, runReadout, runRefusal } from '../sim/shuttles.js';
import { marketHere, quote, tradeRefusal } from '../sim/market.js';
import { GOODS } from '../sim/goods.js';
import { turnOverHere } from '../sim/law.js';
import { promotionDue, payroll, ageOf, PAY_DAYS, CABIN_FEVER_DAYS } from '../sim/careers.js';

export const AI_NAME = 'VIGIL';
export const LEVELS = { warning: 3, caution: 2, advice: 1, info: 0 };
const { warning: WARNING, caution: CAUTION, advice: ADVICE, info: INFO } = LEVELS;

const MAX_SHOWN = 8;
const MAX_TEXT = 90;
const MAX_ACTIONS = 3;
/** Game minutes a dismissed advisory stays quiet, by level (unless its situation changes). */
const QUIET_MIN = { 3: 30, 2: 6 * 60, 1: 24 * 60, 0: 24 * 60 };
/** Gone this long and back, a situation is a new one (a dismissal no longer holds). */
const GONE_MIN = 30;

// The figures the HUD's stores panel uses (hud.js), so our days-left match the panel's
const WATER_GROSS_PER_MIN = 0.004 + 12 / 1440;   // L a head: drinking, galley, a shower a day
const FOOD_PER_MIN = 0.001;                       // rations a head
const DRAIN_PER_MIN = 1 / 60;                     // battery % a minute with the reactor down (reactor.js)
const EVICT_MIN = 6 * 60;                         // over the lease this long, the dock lets go (leases.js)
const FINE_GRACE_MIN = 7 * DAY_MIN;               // a citation unpaid this long makes us SUSPECT (law.js)
const RESCUE_M = 10_000;                          // formation for a rescue or a rendezvous hail (missions.js)
/** Machines whose failure changes what the ship can do (the rest the crew fix without fuss). */
const KEY_SYSTEMS = new Set(['flightComputer', 'drive', 'coolant', 'rcs', 'lifeSupport', 'sensors', 'comms', 'pdc', 'launcher']);
/** Hot zones where ships shoot. */
const SHOOTING_ZONES = new Set(['skirmish', 'front', 'pirates', 'proxy']);

// ---- PUBLIC ----

/**
 * Everything worth the captain's attention now, most urgent first:
 * [{ key, level, text, detail?, actions: [{ id, label, act }] }].
 * `memory` is the UI's object kept across calls (dismissals, latches).
 */
export function advise(state, memory = {}) {
  if (!state?.ship || state.lost) return [];
  const now = state.clock.minute;
  const mem = prepare(memory, now);
  const c = context(state, mem);
  const raised = [];
  const add = (a) => { raised.push(a); c.keys.add(a.key); if (a.level === WARNING) c.loud = true; };
  for (const rule of RULES) rule(state, c, add);

  const seen = new Set();
  let shown = [];
  for (const a of raised) {
    if (seen.has(a.key)) continue;           // (first wins: rules run in order of authority)
    seen.add(a.key);
    if (passes(mem, a, now)) shown.push(a);
  }
  // Nothing to say: say what we are doing (and that, too, can be dismissed)
  if (!shown.length) {
    const st = status(state, c);
    if (st) { seen.add(st.key); if (passes(mem, st, now)) shown.push(st); }
  }
  // A dismissed situation not raised this call has gone away (for now): note since when
  for (const k of Object.keys(mem.dismissed)) if (!seen.has(k)) mem._absent[k] ??= now;
  shown.sort((a, b) => b.level - a.level || b.rank - a.rank || (a.key < b.key ? -1 : 1));
  shown = shown.slice(0, MAX_SHOWN);
  return shown.map(a => {
    const out = { key: a.key, level: a.level, text: say(a.text), actions: (a.actions || []).filter(Boolean).slice(0, MAX_ACTIONS) };
    if (a.detail) out.detail = a.detail;
    return out;
  });
}

// ---- MEMORY & DISMISSAL ----

function prepare(memory, now) {
  memory.dismissed ??= {};
  memory._sig ??= {};      // key → signature last raised
  memory._dsig ??= {};     // key → signature when the captain dismissed it
  memory._seen ??= {};     // key → minute last raised (shown or held quiet)
  memory._absent ??= {};   // dismissed key → minute a call first found it gone
  memory._latch ??= {};    // threshold latches
  // (now and then, forget situations long gone, so the memory can't grow with the game)
  const hour = Math.floor(now / 60);
  if (memory._pruned !== hour) {
    memory._pruned = hour;
    for (const k of Object.keys(memory._seen)) {
      if (now - memory._seen[k] > 2 * DAY_MIN) { delete memory._seen[k]; delete memory._sig[k]; delete memory._dsig[k]; delete memory._latch[k]; }
    }
    for (const k of Object.keys(memory.dismissed)) if (now - memory.dismissed[k] > 7 * DAY_MIN) { delete memory.dismissed[k]; delete memory._dsig[k]; delete memory._absent[k]; }
  }
  return memory;
}

/** Is a signature news against the one dismissed? (A list is news when it gains a member.) */
function isNews(sig, was) {
  if (Array.isArray(sig)) return !Array.isArray(was) || sig.some(x => !was.includes(x));
  return sig !== was;
}

/** Raise an advisory: record it, and say whether it is shown (not held quiet by a dismissal). */
function passes(mem, a, now) {
  const k = a.key;
  const sig = a.sig ?? '';
  let show = true;
  const at = mem.dismissed[k];
  if (at != null) {
    // the captain dismissed what was on the line then: its signature at that moment
    if (!(k in mem._dsig)) mem._dsig[k] = k in mem._sig ? mem._sig[k] : sig;
    const quiet = a.quiet ?? QUIET_MIN[a.level];
    const expired = now - at >= quiet;
    // (gone means a call found it missing, GONE_MIN before this one: at time warp calls are hours apart,
    // and a situation still there at every call is the same situation however much time passed between)
    const back = mem._absent[k] != null && now - mem._absent[k] >= GONE_MIN;
    if (expired || back || isNews(sig, mem._dsig[k])) { delete mem.dismissed[k]; delete mem._dsig[k]; }
    else show = false;
  }
  delete mem._absent[k];
  mem._seen[k] = now;
  mem._sig[k] = sig;
  return show;
}

/** A threshold with hysteresis: on below `on`, off again only above `off`. */
function latch(mem, key, value, on, off) {
  const was = !!mem._latch[key];
  const now = was ? value < off : value < on;
  if (now) mem._latch[key] = true; else delete mem._latch[key];
  return now;
}

// ---- WORDS ----

// (whole minutes, and whole hours past a day: formatDuration rounds, and "3h 60m" or "6d 24h" reads badly)
const dur = (min) => { const m = Math.max(0, min); return formatDuration(m >= DAY_MIN ? Math.floor(m / 60) * 60 : m >= 1 ? Math.floor(m) : m); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lcFirst = (s) => s ? s[0].toLowerCase() + s.slice(1) : s;
const short = (f) => FACTIONS[f]?.short || f;
const list = (names, max = 3) => names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;

/** One line, never longer than the line: cut at a word, with an ellipsis. */
function say(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.slice(0, MAX_TEXT - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 50 ? cut.slice(0, sp) : cut).replace(/[\s,:;.—-]+$/, '')}…`;
}

/** What we call a ship: its name once we know it (sensors.js isIdentified), else what it is to us. */
function knownName(state, e) {
  if (!e) return 'an unknown ship';
  if (isIdentified(state, e)) return `the ${e.name}`;
  return 'an unidentified ship';
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---- ACTIONS ----

const act = (id, label, a) => ({ id, label, act: a });
const A = {
  battle: () => act('battle-stations', 'BATTLE STATIONS', { type: 'toggle', what: 'combat' }),
  suits: () => act('suits', 'SUITS ON', { type: 'toggle', what: 'suits' }),
  weapons: () => act('weapons', 'WEAPONS', { type: 'open', window: 'weapons' }),
  systems: () => act('systems', 'SYSTEMS', { type: 'open', window: 'systems' }),
  roster: () => act('roster', 'ROSTER', { type: 'open', window: 'roster' }),
  crew: (m, label = m.name.toUpperCase()) => act(`crew-${m.id}`, label, { type: 'open', window: 'crew', id: m.id }),
  jobs: () => act('jobs', 'JOBS', { type: 'open', window: 'jobs' }),
  missions: () => act('missions', 'MISSIONS', { type: 'open', window: 'missions' }),
  service: () => act('service', 'SERVICE RECORD', { type: 'open', window: 'service' }),
  boarding: () => act('boarding', 'BOARDING', { type: 'open', window: 'boarding' }),
  shuttles: (air = null) => act('shuttles', 'SHUTTLES', { type: 'open', window: 'shuttles', id: air }),
  map: () => act('map', 'OPEN MAP', { type: 'open', window: 'map' }),
  station: (id, tab, label) => act(`station-${tab}`, label, { type: 'open', window: 'station', id, tab }),
  hail: (id, label = 'HAIL') => act('hail', label, { type: 'hail', id }),
  plot: (id, label, dock = false) => act('plot', label, { type: 'plot', target: { kind: 'entity', id }, ...(dock ? { dock: true } : {}) }),
  select: (target) => act('select', 'SHOW ON MAP', { type: 'select', target }),
  requestDocking: (id) => act('request-docking', 'REQUEST DOCKING', { type: 'request-docking', id }),
  requestDeparture: (id) => act('request-departure', 'CLEAR TO DEPART', { type: 'request-departure', id }),
  dock: (id) => act('dock', 'DOCK', { type: 'dock', id }),
  order: (what, label) => act(what, label, { type: 'order', what }),
  speed: (value, label) => act(`speed-${value}`, label, { type: 'speed', value }),
};

// ---- CONTEXT (shared lookups, once a call) ----

function context(state, mem) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const tcSt = state.tc?.station ? world.get(state.tc.station) : null;
  const docked = dockedTo(state);
  const c = {
    now, world, mem, f: state.flight, ap: state.autopilot, dock: state.dock,
    tcSt, zone: state.tc?.zone || 'none',
    docked, dockedSt: dockedStationEntity(state), port: dockedPort(state),
    crew: state.ship.crew.filter(m => !m.dead),
    pax: state.passengers.reduce((s, p) => s + p.count, 0),
    keys: new Set(),           // keys raised so far this call (a later rule can leave out what is said)
    loud: false,               // a warning is up (the small advice keeps quiet under it)
    _eta: undefined, _near: undefined,
  };
  c.aboard = c.crew.filter(m => !m.away);
  // whose space we are in: the influence map, cached per game minute
  if (mem._ctl?.minute !== now) mem._ctl = { minute: now, v: controlAt(c.f.pos.x, c.f.pos.y, now) };
  c.ctl = mem._ctl.v;
  return c;
}

/** Minutes until the route arrives, or null: the plotted estimate, else range over closing speed. */
function routeEta(state, c) {
  if (c._eta !== undefined) return c._eta;
  const ap = c.ap;
  let eta = null;
  if (ap && ap.plan.kind !== 'stance') {
    if (ap.estimate?.minutes != null) {
      const start = ap.engagedAt ?? c.now + PREP_MINUTES;     // (not under way yet: the crew are still strapping in)
      const left = start + ap.estimate.minutes - c.now;
      if (left > 0) eta = left;
    }
    if (eta == null && ap.d != null && ap.vClose > 1) eta = (ap.d - (ap.plan.standoff || 0)) / ap.vClose / 60;
  }
  return (c._eta = eta != null && eta > 0 ? eta : null);
}

/** The nearest station that would have us (a handful to look at), or null. */
function nearestPort(state, c) {
  if (c._near !== undefined) return c._near;
  let best = null, bd = Infinity;
  const p = c.f.pos;
  for (const st of c.world.stations) {
    if (st.combat?.status === 'wreck' || refusal(state, st)) continue;
    const d = Math.hypot(st.pos.x - p.x, st.pos.y - p.y);
    if (d < bd) { bd = d; best = st; }
  }
  return (c._near = best);
}

/** A station we can buy from where we are (docked at it, or our command ship alongside). */
function supplier(state, c) {
  const port = c.port;
  if (!port) return null;
  if (port.tags?.command) return port;
  return STATIONS[port.id]?.services.some(x => x === 'fuel' || x === 'market') ? port : null;
}

/** "Fill up here" if we can, else the way to the nearest port. */
function resupplyActions(state, c, label = 'SUPPLIES') {
  const sup = supplier(state, c);
  if (sup) return [A.station(sup.id, 'services', label)];
  const near = nearestPort(state, c);
  return near ? [A.plot(near.id, `PLOT TO ${near.name.toUpperCase()}`, true)] : [A.map()];
}

/** Are we flying to (or docking with, or held on) this entity? */
function headingFor(state, c, id) {
  return c.ap?.plan.target.id === id || c.ap?.plan.target.id === `${id}-gate` || c.dock?.target.id === id || c.f.hold?.id === id;
}

const distM = (c, e) => Math.hypot(e.pos.x - c.f.pos.x, e.pos.y - c.f.pos.y) * AU_M;

// ============================================================
// RULES. Each looks at one part of the ship's world and adds what it
// finds. They run in this order; a key raised twice keeps the first.
// ============================================================

// ---- WEAPONS FREE: ordnance and ships shooting at us ----

function ruleOrdnance(state, c, add) {
  const inbound = threats(state);
  if (!inbound.length) return;
  const first = inbound[0];
  const n = inbound.length;
  const nukes = inbound.filter(t => t.warhead === 'nuke').length;
  const slugs = inbound.filter(t => t.kind === 'slug').length;
  const eta = isFinite(first.etaS) ? dur(first.etaS / 60) : null;
  const what = n === 1 ? (slugs ? 'a railgun slug' : nukes ? 'a nuclear torpedo' : 'a torpedo')
    : slugs === n ? `${n} railgun slugs` : nukes === n ? `${n} nuclear torpedoes` : `${n} torpedoes${nukes ? ` (${nukes} nuclear)` : ''}`;
  const cls = playerClass(state);
  const C = state.combat;
  const notes = [];
  if (!cls.pdc) notes.push('We have no point defense: only evasion or distance will save us.');
  else if (C.pdc === 'hold') notes.push('Point defense is on HOLD: it will not fire, even at torpedoes.');
  else notes.push('Point defense engages them inside its envelope; a gunner at the weapons console shoots far better.');
  if (state.combatStations && !C.evasive) notes.push('Evasive jinking throws off terminal homing, at the cost of reaction mass and G on the crew.');
  const evasiveOK = state.combatStations && !C.evasive && isFinite(first.etaS) && first.etaS < 30 * 60 && isReactorOnline(state) && state.resources.fuel.current > 0;
  add({
    key: 'ordnance', level: WARNING, rank: 95 + (first.etaS < 10 * 60 ? 8 : 0), sig: inbound.map(t => t.id),
    text: `We have ${what} inbound${eta ? `, first impact in ${eta}` : ''}.`,
    detail: notes.join(' '),
    actions: [
      !state.combatStations && A.battle(),
      cls.pdc > 0 && C.pdc === 'hold' && A.order('pdc-auto', 'PDC AUTO'),
      evasiveOK && A.order('evasive', 'EVASIVE'),
      A.weapons(),
    ],
  });
}

function ruleHostiles(state, c, add) {
  const tracked = state.sensors.$seen;
  const held = hostilesOfPlayer(state).filter(e => tracked?.has(e.id) || state.sensors.contacts.some(x => x.id === e.id));
  // (one running from us isn't attacking: it is getting away, as long as its crew can take the burn)
  const running = (e) => e.agent.mode === 'leave' || e.agent.mode === 'flee';
  const hs = held.filter(e => !running(e));
  if (!hs.length) {
    const r = held.sort((a, b) => distM(c, a) - distM(c, b))[0];
    if (r) add({
      key: 'hostiles', level: CAUTION, rank: 62, sig: ['running', r.id], text: `${cap(knownName(state, r))} is running from us, ${fmtMeters(distM(c, r))} out${r.thrust > 0.05 ? ` at ${r.thrust.toFixed(1)}G` : ', drive cold'}.`,
      detail: 'Nobody holds a high-G burn for long with people aboard: past 6G every hour costs its crew strokes, and it will ease off. Out of our reach it may cut its drive and coast dark; its last fix can be flown to. Fire control\'s REACH says whether a torpedo would catch it.',
      actions: [A.weapons()],
    });
    return;
  }
  hs.sort((a, b) => distM(c, a) - distM(c, b));
  const e = hs[0];
  const d = fmtMeters(distM(c, e));
  const cat = CLASSES[e.cls]?.category;
  const name = knownName(state, e);
  let text;
  if (hs.length > 1) text = `${hs.length} ships are engaging us; the nearest is ${d} out.`;
  else if (cat === 'military' || cat === 'authority') text = `${cap(name)} has gone weapons-free on us, ${d} out.`;
  else text = `${cap(name)} is attacking us, ${d} out.`;
  add({
    key: 'hostiles', level: WARNING, rank: 80, sig: hs.map(x => x.id), text,
    detail: 'At battle stations the crew are strapped in, the best shot takes the weapons console and the drive may jink.',
    actions: [!state.combatStations && A.battle(), A.weapons()],
  });
}

// ---- THE PLANT: reactor, air, fire ----

function ruleReactor(state, c, add) {
  const r = state.reactor;
  if (r.status === ReactorState.CONTAINMENT_FAILURE) {
    const scram = r.work === 'scram';
    add({
      key: 'containment', level: WARNING, rank: 100, sig: scram ? 'scram' : 'failing',
      text: scram ? `Containment failure: scram ordered, ${r.countdown} min to supercritical.` : `Reactor containment failure: ${r.countdown} min to supercritical.`,
      detail: 'An engineer at the reactor scrams it. If the bottle goes supercritical the ship is lost.',
      actions: [!scram && A.order('scram', 'SCRAM REACTOR'), A.systems()],
    });
    return;
  }
  if (r.blackout) {
    add({
      key: 'blackout', level: WARNING, rank: 75,
      text: 'Blackout: the reactor is down and the batteries are flat.',
      detail: 'Sensors, displays and machinery are dark and an SOS is out. A startup is five hours of an engineer\'s work at the reactor.',
      actions: [A.systems()],
    });
    return;
  }
  if (r.status === ReactorState.EMERGENCY_SHUTOFF) {
    add({ key: 'reactor', level: CAUTION, rank: 88, sig: 'shutoff', text: `Emergency shutoff under way: the fuel is dumped in ${r.countdown} min.`, actions: [A.systems()] });
    return;
  }
  if (!isReactorOnline(state)) {
    const pct = state.resources.power.current;
    const starting = r.status === ReactorState.STARTING_UP;
    add({
      key: 'reactor', level: starting ? ADVICE : CAUTION, rank: 70, sig: starting ? 'starting' : r.breach ? 'breach' : 'offline',
      text: `Reactor ${starting ? 'starting up' : 'offline'}: batteries at ${Math.round(pct)}%, about ${dur(pct / DRAIN_PER_MIN)} left.`,
      detail: r.breach ? 'Containment is breached: an engineer must patch it (an hour at the reactor) before it can be started.' : 'Without the reactor there is no main drive; the batteries carry the rest for a while.',
      actions: [A.systems()],
    });
  }
}

function ruleDecks(state, c, add) {
  const decks = state.ship.decks;
  const breached = [], burning = [], bad = [], stale = [];
  let geo = null;
  decks.forEach((d, i) => {
    const a = d.atmosphere;
    if (!a) return;
    if (a.fire) burning.push({ d, i, a });
    if (a.breached) { breached.push({ d, i }); return; }
    if (a.vented || a.fire) return;                       // (vented by choice; a fire is said already)
    const st = atmoStatus(a);
    if (st !== 'critical' && st !== 'vacuum' && st !== 'warning') return;
    // bad air matters to whoever breathes it: the unsuited on that deck
    geo ??= shipGeometry(state.ship);
    const people = c.aboard.filter(m => !m.suit?.wearing && geo.deckOfRow(m.pos.sy) === i);
    if (!people.length) return;
    (st === 'warning' ? stale : bad).push({ d, i, a, people });
  });
  const jobFor = (type, i) => state.jobs.list.find(j => j.type === type && j.data?.deck === i);
  const who = (j) => j?.assignee != null ? state.ship.crew.find(m => m.id === j.assignee)?.name : null;

  if (burning.length) {
    burning.sort((x, y) => y.a.fire.intensity - x.a.fire.intensity);
    const top = burning[0];
    const pct = Math.round(top.a.fire.intensity * 100);
    const fighter = who(jobFor(JobType.FIRE, top.i));
    add({
      key: 'fire', level: WARNING, rank: 90, sig: burning.map(x => x.d.name),
      text: burning.length === 1 ? `Fire on the ${top.d.name} deck, ${pct}%${fighter ? `: ${fighter} is fighting it` : ''}.`
        : `Fires on ${burning.length} decks: ${list(burning.map(x => x.d.name))}.`,
      detail: 'A hand in a suit knocks a fire back; or vent the deck from its menu and starve it. Above 70% it can climb the shaft to the next deck.',
      actions: [!state.suitsOn && A.suits(), A.jobs()],
    });
  }
  if (breached.length) {
    const sealer = who(jobFor(JobType.SEAL, breached[0].i));
    add({
      key: 'breach', level: WARNING, rank: 88, sig: breached.map(x => x.d.name),
      text: breached.length === 1 ? `Hull breach on the ${breached[0].d.name} deck: it is venting${sealer ? `; ${sealer} is on the patch` : ''}.`
        : `Hull breaches on ${breached.length} decks: ${list(breached.map(x => x.d.name))}.`,
      detail: 'An engineer in a suit seals it, then the deck repressurizes from the tanks. Burns are eased to 1 G while the hull is holed.',
      actions: [!state.suitsOn && A.suits(), A.jobs()],
    });
  }
  if (bad.length) {
    const b = bad[0];
    add({
      key: 'air', level: WARNING, rank: 86, sig: bad.map(x => x.d.name),
      text: `Bad air on the ${b.d.name} deck: O₂ ${b.a.o2Pct.toFixed(0)}%, ${b.a.pressure.toFixed(0)} kPa, ${plural(b.people.length, 'hand')} unsuited.`,
      detail: 'Crew in bad air go for an EVA suit; strapped into a couch, its emergency hood buys two hours.',
      actions: [!state.suitsOn && A.suits(), A.systems()],
    });
  } else if (stale.length) {
    const b = stale[0];
    add({
      key: 'air', level: CAUTION, rank: 60, sig: stale.map(x => x.d.name),
      text: `The air on the ${b.d.name} deck is going bad: O₂ ${b.a.o2Pct.toFixed(0)}%, CO₂ ${b.a.co2Pct.toFixed(1)}%.`,
      actions: [A.systems()],
    });
  }
}

// ---- PEOPLE ----

function ruleCrew(state, c, add) {
  const critical = c.crew.filter(m => m.conditions.includes('critical'));
  if (critical.length) {
    const m = critical.reduce((a, b) => (b.deathTimer ?? 99) < (a.deathTimer ?? 99) ? b : a);
    const rescue = state.jobs.list.find(j => j.type === JobType.RESCUE && j.data?.patient === m.id && j.assignee != null);
    const medic = rescue ? state.ship.crew.find(x => x.id === rescue.assignee)?.name : null;
    const left = m.deathTimer > 0 ? Math.max(1, Math.round(m.deathTimer)) : null;
    add({
      key: 'crew-critical', level: WARNING, rank: 85, sig: critical.map(x => x.id),
      text: critical.length === 1 ? `${m.name} is dying${left ? `: about ${left} min without first aid` : ''}${medic ? `; ${medic} is on the way` : ''}.`
        : `${critical.length} crew are critical: ${list(critical.map(x => x.name))}.`,
      detail: 'Whoever is free with medical skill stabilizes them and carries them to the autodoc.',
      actions: [A.roster()],
    });
  }
  // No medicine for the hurt: the autodoc works on at 30%
  if (state.resources.medSupplies.current < 1 && c.crew.some(m => needsMedical(m))) {
    add({
      key: 'stores:med', level: CAUTION, rank: 56,
      text: 'We are out of medical supplies: the autodoc treats at 30% speed.',
      actions: resupplyActions(state, c),
    });
  }
  ruleCareers(state, c, add);
}

/** The crew's careers (sim/careers.js): what they ask of the captain, and what the ship owes them. */
function ruleCareers(state, c, add) {
  const hands = c.crew.filter(m => m.role !== 'Captain');
  if (!hands.length) return;
  // someone means to go
  const going = hands.filter(m => m.quit);
  if (going.length) add({
    key: 'quit', level: CAUTION, rank: 52, sig: going.map(m => m.id),
    text: going.length === 1 ? `${going[0].name} has had enough: they mean to sign off at the next port.` : `${list(going.map(m => m.name))} mean to sign off at the next port.`,
    detail: 'A week miserable and a hand goes. Rest, a run ashore, their pay and a step up they have earned lift morale; above 35 they think better of it.',
    actions: [A.crew(going[0]), A.roster()],
  });
  // money owed
  const owed = hands.reduce((s, m) => s + (m.owed || 0), 0);
  if (owed > 0) add({
    key: 'owed', level: CAUTION, rank: 50, sig: Math.round(owed / 500),
    text: `We owe the crew ${fmtNum(Math.round(owed))} MCR in back pay.`,
    detail: 'Back pay comes first out of the next pay day, and owing weighs on them until it is paid.',
    actions: [A.roster()],
  });
  // pay day coming with the credits short
  const day = Math.floor(c.now / DAY_MIN), toPay = PAY_DAYS - (day % PAY_DAYS), bill = payroll(state) + owed;
  if (toPay <= 5 && bill > state.resources.credits.current) add({
    key: 'payday', level: CAUTION, rank: 47, sig: toPay <= 1 ? 'tomorrow' : 'soon',
    text: `Pay day in ${toPay === 1 ? 'a day' : `${toPay} days`}: ${fmtNum(Math.round(bill))} MCR due, ${fmtNum(Math.round(state.resources.credits.current))} in hand.`,
    detail: 'Short, the crew are paid what there is and owed the rest.',
    actions: [A.roster()],
  });
  // a retirement asked for
  const asking = hands.filter(m => m.retire && !m.retire.granted && !m.retire.insist && m.retire.refused == null);
  if (asking.length) add({
    key: 'retire', level: ADVICE, rank: 42, sig: asking.map(m => m.id),
    text: `${asking[0].name} (${Math.floor(ageOf(asking[0], c.now))}) asks to retire at the next port.${asking.length > 1 ? ` ${plural(asking.length - 1, 'other')} too.` : ''}`,
    detail: 'Granted, they sign off at the next port and the crew see them off. Asked to stay, they stay, put out, and ask again in three months; five years past their time they go regardless.',
    actions: [A.crew(asking[0])],
  });
  // a step up earned
  const due = hands.filter(m => promotionDue(m));
  if (due.length) add({
    key: 'promote', level: ADVICE, rank: 36, sig: due.map(m => `${m.id}:${m.rank}`),
    text: due.length === 1 ? `${due[0].name} has earned a step up: ${promotionDue(due[0]).title}.` : `${plural(due.length, 'hand')} have earned a step up: ${list(due.map(m => m.name))}.`,
    detail: 'The promoted are the happier for it, and draw more pay; one left due for a month sours.',
    actions: [A.crew(due[0], 'PROMOTE')],
  });
  // weeks without a run ashore (at a port with leave, the shore-leave advice says it)
  const out = c.aboard.filter(m => (c.now - (m.lastLeave ?? c.now)) / DAY_MIN > CABIN_FEVER_DAYS);
  if (out.length && !c.dockedSt && out.length >= Math.ceil(c.aboard.length / 2)) {
    const days = Math.round(Math.max(...out.map(m => (c.now - m.lastLeave) / DAY_MIN)));
    add({
      key: 'cabin-fever', level: ADVICE, rank: 32, quiet: 3 * DAY_MIN, sig: 'out',
      text: `The crew have gone ${days} days without a run ashore: it is telling on them.`,
      detail: 'Cabin fever grinds morale down from three weeks out. Shore leave at a station lifts them; a world\'s ground, by shuttle, more; their own home world most.',
      actions: [A.map()],
    });
  }
}

// ---- FLIGHT ----

function ruleFlight(state, c, add) {
  const ap = c.ap;
  const f = c.f;
  const res = state.resources;
  const name = ap ? targetName(state, ap.plan.target) : null;

  if (ap?.helm === 'unmanned') {
    add({
      key: 'helm', level: WARNING, rank: 70,
      text: 'The flight computer is down and nobody is at the helm: we are coasting.',
      detail: 'Someone with piloting must fly the plan by hand from the helm couch, or the flight computer must be repaired.',
      actions: [A.roster(), A.systems()],
    });
  }

  // The flip interlock: the turn waits for the crew
  if (ap?.turnHeld != null) {
    const up = c.aboard.filter(m => m.consciousness > 10 && !isSecureSeat(m.seat));
    const left = Math.max(0, 30 - (c.now - ap.turnHeld));
    add({
      key: 'flip-held', level: CAUTION, rank: 90, sig: 'held',
      text: up.length ? `Flip held: ${list(up.map(m => m.name), 2)} still on their feet.` : 'Flip held for the crew to strap in.',
      detail: `The drive stays cold and the nose held until all hands are in, or ${left} min at most. A flip throws anyone not strapped in.`,
      actions: [A.order('flip-now', 'FLIP NOW'), A.roster()],
    });
  } else if (ap?.phase === 'prepare' && c.now - ap.createdAt >= 3) {
    // Securing for the burn: the route waits for everyone to be strapped in (and the pilot at the helm)
    const sec = ap.secure;
    const partyOut = state.ship.crew.some(m => m.away?.op && !m.away.captured);
    const shuttle = state.ship.crew.some(m => m.away?.shuttle);
    if (partyOut) {
      add({ key: 'secure', level: CAUTION, rank: 85, sig: shuttle ? 'shuttle' : 'party', text: shuttle ? `The route to ${name} waits for our shuttle to come home.` : `The route to ${name} waits for our boarding party to come back.`, actions: [shuttle ? A.shuttles() : A.boarding()] });
    } else if (sec && sec.total - sec.secured > 0) {
      const n = sec.total - sec.secured;
      add({
        key: 'secure', level: CAUTION, rank: 85, sig: 'crew',
        text: `The burn to ${name} waits on ${plural(n, 'hand')} still on their feet.`,
        detail: 'Executing now leaves them standing: past 1.5 G they strain, past 2.5 G they are hurt, and a flip throws them.',
        actions: [A.order('execute', 'EXECUTE NOW'), A.roster()],
      });
    } else if (sec && !sec.pilotReady && sec.pilot) {
      add({ key: 'secure', level: CAUTION, rank: 85, sig: 'pilot', text: `The burn to ${name} waits for ${sec.pilot} at the helm.`, actions: [A.order('execute', 'EXECUTE NOW'), A.roster()] });
    }
  }

  // Reaction mass: can we finish the route at all?
  if (ap && ap.plan.kind !== 'stance') {
    const fuel = res.fuel.current;
    const planned = ap.estimate?.fuel != null ? ap.estimate.fuel - Math.max(0, ap.fuelStart - fuel) : null;
    // (and whatever the plan: matching the target's motion takes at least the relative speed in Δv)
    const floor = (ap.relSpeed || 0) / (G0 * MIN_S) * FUEL_PER_G_MIN;
    const short = (planned != null && planned > fuel * 1.02 + 1) || floor > fuel;
    if (short) {
      const near = nearestPort(state, c);
      add({
        key: 'route-fuel', level: WARNING, rank: 58,
        text: `We lack the reaction mass to finish the route to ${name}.`,
        detail: `${planned != null ? `The plan needs about ${fmtNum(Math.max(planned, floor))} kg more; ` : ''}we have ${fmtNum(fuel)} kg.`,
        actions: [near && near.id !== ap.plan.target.id && A.plot(near.id, `PLOT TO ${near.name.toUpperCase()}`, true), A.map()],
      });
    }
  }

  // Reaction mass low (hysteresis: on under 10%, off over 13%)
  const fuelPct = res.fuel.max > 0 ? res.fuel.current / res.fuel.max : 1;
  if (!c.dockedSt && latch(c.mem, 'fuel', fuelPct, 0.10, 0.13)) {
    const burn = res.fuel.current / FUEL_PER_G_MIN;          // minutes at 1 G
    add({
      key: 'fuel', level: fuelPct < 0.02 ? WARNING : CAUTION, rank: 60, sig: fuelPct < 0.02 ? 'dry' : 'low',
      text: `Reaction mass at ${Math.round(fuelPct * 100)}%: about ${dur(burn)} of burn at 1 G.`,
      actions: resupplyActions(state, c, 'FILL TANKS'),
    });
  }

  // Falling onto a rock (terrain.js calls the times out; we say it once and keep saying it)
  if (state.$terrain?.k > 0 && !ap && !c.dock && !f.hold) {
    const s = fallingToward(state, c);
    if (s) {
      const near = nearestPort(state, c);
      add({
        key: 'terrain', level: WARNING, rank: 92,
        text: `We are falling toward ${s.body.name}: ${fmtNum(s.alt / 1000)} km below, impact in about ${dur(s.min)}.`,
        detail: 'Free near a rock, the ship falls. Any route lifts us clear: the nav computer climbs round the ground.',
        actions: [near && A.plot(near.id, `PLOT TO ${near.name.toUpperCase()}`, true), A.map()],
      });
    }
  }

  // Hull
  const hull = state.hull.integrity;
  if (hull < 50) {
    add({
      key: 'hull', level: hull < 25 ? WARNING : CAUTION, rank: 55, sig: hull < 25 ? 'critical' : 'weak',
      text: `Hull at ${Math.round(hull)}%: burns are limited to 3 G.`,
      detail: 'Hull plating is a yard\'s work: a dockside overhaul restores it.',
      actions: c.dockedSt && STATIONS[c.dockedSt.id]?.services.includes('repair') ? [A.station(c.dockedSt.id, 'services', 'OVERHAUL')] : resupplyActions(state, c),
    });
  }
}

/** The ground below and the time to it (asked only while terrain.js says we are falling). */
function fallingToward(state, c) {
  const f = c.f;
  const s = nearestSurface(f.pos.x, f.pos.y, c.now);
  if (!s || s.alt <= 0) return null;
  const min = timeToImpact(s, f.vel, { ax: f.$ax || 0, ay: f.$ay || 0 }) / MIN_S;
  return isFinite(min) ? { body: s.body, alt: s.alt, min } : null;
}

// ---- PORT: traffic control, the dock, the lease ----

function rulePort(state, c, add) {
  const st = c.tcSt;
  const d = c.dock;
  const now = c.now;

  // Clearances near the station whose space we are in
  if (st && c.zone !== 'none' && c.zone !== 'docked' && st.combat?.status !== 'wreck') {
    const cl = clearanceFor(state, st.id);
    const ourDock = d?.target.id === st.id ? d : null;
    const leaving = cl.depart || state.tc.outbound === st.id || c.ap?.depart?.station === st.id || (ourDock && ['undock', 'separate', 'outbound'].includes(ourDock.phase));
    const inbound = c.ap?.phase === 'active' && c.ap.plan?.port?.id === st.id;
    if (st.combat?.hostile?.includes(PLAYER)) {
      add({ key: 'station-guns', level: WARNING, rank: 79, text: `${st.name}'s guns are on us.`, detail: 'A station fires on whoever fired on it, or on a ship its power has HOSTILE, within 450,000 km.', actions: [!state.combatStations && A.battle(), A.weapons()] });
    }
    if (!state.comms.transponder) {
      add({
        key: 'transponder', level: CAUTION, rank: 72,
        text: `We are running dark in ${st.name}'s control space: they cite after 30 min.`,
        actions: [A.order('transponder-on', 'TRANSPONDER ON')],
      });
    }
    if (c.zone === 'keepout' && !cl.dock && !leaving && !ourDock) {
      add({
        key: 'keepout', level: WARNING, rank: 78,
        text: `We are inside ${st.name}'s keep-out zone without docking clearance.`,
        detail: `After the final warning it is a crime${STATIONS[st.id]?.military ? ', and a naval yard opens fire' : ''}. Ask for a berth, or back out past the gate.`,
        actions: [A.requestDocking(st.id), A.hail(st.id)],
      });
    } else if ((c.zone === 'approach' || c.zone === 'keepout') && !cl.approach && !leaving && !ourDock) {
      add({
        key: 'approach', level: inbound ? ADVICE : CAUTION, rank: 74,
        text: inbound ? `We are on ${st.name}'s approach: ask traffic control for clearance.` : `We are on ${st.name}'s approach without clearance: cited after 15 min.`,
        detail: 'Loitering on the approach is cited at 15 minutes and reported to the police at 45. A docking or a holding clearance clears us in.',
        actions: [A.requestDocking(st.id), A.hail(st.id)],
      });
    }
  }

  // The dock
  if (d && d.target.kind === 'station') {
    const e = c.world.get(d.target.id);
    if (e) {
      const cl = clearanceFor(state, e.id);
      if (d.phase === 'awaiting') {
        add({
          key: 'dock-clearance', level: CAUTION, rank: 80, sig: 'awaiting',
          text: `Holding at ${e.name}'s gate: we need docking clearance.`,
          detail: 'The nav computer does not ask for us. Traffic control assigns a berth for two hours; the docking computer then takes us in.',
          actions: [A.requestDocking(e.id), A.hail(e.id)],
        });
      } else if (d.phase === 'inbound' && !cl.dock) {
        const eta = routeEta(state, c);
        if (eta != null && eta < 90) {
          add({
            key: 'dock-clearance', level: eta < 30 ? CAUTION : ADVICE, rank: 70, sig: eta < 30 ? 'gate' : 'inbound',
            text: `${e.name}'s gate in ${dur(eta)}: we will need docking clearance there.`,
            actions: [A.requestDocking(e.id)],
          });
        }
      } else if (d.phase === 'holding' && !cl.dock && !d.next && now - d.since >= 20) {
        add({
          key: 'dock-clearance', level: now - d.since >= 45 ? CAUTION : ADVICE, rank: 66, sig: 'holding',
          text: `Holding off ${e.name}: request docking again, or plot a course out.`,
          detail: 'Sat at the hold point an hour with no route or lease, traffic control counts it as loitering.',
          actions: [A.requestDocking(e.id), A.map()],
        });
      }
    }
  }

  // A docking clearance we hold and aren't using
  if (state.tc?.clear) {
    for (const [id, cl] of Object.entries(state.tc.clear)) {
      if (!cl?.dock || cl.dock.until <= now) continue;
      if (d && d.target.id === id) continue;
      const e = c.world.get(id);
      if (!e) continue;
      const berth = berthOf(id, cl.dock.berth)?.label || cl.dock.berth;
      add({
        key: `cleared:${id}`, level: ADVICE, rank: 68,
        text: `Cleared to dock at ${e.name}, ${berth}: ${dur(cl.dock.until - now)} left on it.`,
        actions: [A.dock(id)],
      });
    }
  }

  // The berth lease
  if (d?.phase === 'docked' && d.target.kind === 'station') {
    const e = c.world.get(d.target.id);
    const until = d.lease?.until ?? (d.at ?? now) + FREE_LEASE_MIN;
    const left = until - now;
    if (e && left <= 60) {
      const cl = clearanceFor(state, e.id);
      const ashore = c.crew.filter(m => m.away?.ashore).length;
      const band = left > 0 ? 'soon' : left > -30 ? 'up' : left > -(EVICT_MIN - 60) ? 'over' : 'evict';
      const text = band === 'soon' ? `Our berth lease at ${e.name} runs out in ${dur(left)}.`
        : band === 'up' ? `Our berth lease at ${e.name} is up: extend it or depart.`
        : band === 'over' ? `We are ${dur(-left)} over our berth lease: cited every 2 h.`
        : `${dur(-left)} over our lease: the dock releases us in ${dur(EVICT_MIN + left)}.`;
      add({
        key: 'lease', level: band === 'evict' ? WARNING : CAUTION, rank: 75, sig: band, text,
        detail: `A long lease is bought ahead by the hour (${LEASE_RATE.M} MCR an hour for an M collar; double at a naval yard). Overstaying is cited after 30 minutes' grace, then every two hours.${ashore ? ` ${plural(ashore, 'hand')} ashore: we can't undock until they are back.` : ''}`,
        // (cleared out, a route takes us: it undocks and climbs out of the gate by itself)
        actions: [A.station(e.id, 'berth', 'EXTEND LEASE'), !ashore && (cl.depart ? A.map() : A.requestDeparture(e.id))],
      });
    }
  }
}

// ---- THE LAW ----

function ruleLaw(state, c, add) {
  const L = state.law;
  const here = (f) => c.ctl.faction === f || c.ctl.rival === f || c.tcSt?.faction === f || c.port?.faction === f;
  // Where we can pay a power's citations from here: a station of its in radio range (the docked one first)
  const payAt = (f) => {
    if (c.port?.type === 'station' && c.port.faction === f) return c.port;
    if (c.tcSt?.faction === f && c.tcSt.type === 'station') return c.tcSt;
    for (const id of state.comms.radio || []) {
      const e = c.world.get(id);
      if (e?.type === 'station' && e.faction === f && e.combat?.status !== 'wreck') return e;
    }
    return null;
  };
  // Citations
  const owedBy = {};
  for (const fine of L.fines || []) (owedBy[fine.faction] ||= []).push(fine);
  for (const [f, fines] of Object.entries(owedBy)) {
    const total = fines.reduce((s, x) => s + x.amount, 0);
    if (!total) continue;
    const oldest = Math.min(...fines.map(x => x.at));
    const power = POWERS.includes(f);
    const toSuspect = FINE_GRACE_MIN - (c.now - oldest);
    const pay = payAt(f);
    add({
      key: `fines:${f}`, level: power && (toSuspect < 2 * DAY_MIN || here(f)) ? CAUTION : ADVICE, rank: 40, sig: String(total),
      text: power && toSuspect > 0 ? `We owe ${short(f)} ${fmtNum(total)} MCR in citations: SUSPECT in ${dur(toSuspect)} if unpaid.`
        : power ? `We owe ${short(f)} ${fmtNum(total)} MCR in citations: it keeps us SUSPECT.` : `We owe ${fmtNum(total)} MCR in citations to independent ports.`,
      detail: `Citations are paid at any ${short(f)} station (hail it), or settled by an inspection.`,
      actions: [pay && A.hail(pay.id, `PAY AT ${pay.name.split(' ')[0].toUpperCase()}`)],
    });
  }
  // Wanted, where it bites: in that power's space, or by its ports
  for (const f of POWERS) {
    const w = L.wanted[f] || 0;
    if (!w) continue;
    const there = here(f);
    if (w === 1 && !there) continue;
    const level = w >= 3 ? (there ? WARNING : CAUTION) : w === 2 ? (there ? CAUTION : ADVICE) : ADVICE;
    const text = w >= 3 ? `${short(f)} has us HOSTILE: their ships and guns fire on sight.`
      : w === 2 ? `We are WANTED by ${short(f)}${there ? ', in its space' : ''}: its patrols will try to disable us.`
      : `We are SUSPECT with ${short(f)}: its patrols will stop and search us.`;
    const pay = owedBy[f] && payAt(f);
    add({
      key: `wanted:${f}`, level, rank: 45, sig: String(w), text,
      detail: 'Wanted levels fade a step every ten quiet days. Paying citations clears SUSPECT when they are the cause; police will also take a surrender.',
      actions: [pay && A.hail(pay.id, 'PAY CITATIONS'), A.service()],
    });
  }
  // A navy hull flown without its license (said once; dismissed, it stays quiet a week)
  if (!hullLegal(state)) {
    const n = navyOf(state.ship.classId);
    add({
      key: 'unlicensed', level: CAUTION, rank: 30, quiet: 7 * DAY_MIN,
      text: n === 'stolen' ? 'We fly a stolen navy hull: illegal everywhere, and its navy shoots.' : `We fly a ${FACTIONS[n]?.navy || 'navy'} hull without its license: it is contraband.`,
      detail: 'An inspection levies 10,000 MCR for the hull and leaves the record open; its navy engages us once it knows who we are. Its license makes it legal.',
      actions: [A.service()],
    });
  }
}

// ---- WHO WANTS SOMETHING FROM US ----

const REQUEST_WORDS = {
  inspect: (r) => `${cap(`the ${r.fromName}`)} orders us to heave to for inspection`,
  demand: (r) => `${cap(`the ${r.fromName}`)} demands ${(r.options.find(o => o.id === 'pay')?.label || '').replace(/^PAY /, '') || 'payment'} or they fire`,
  warning: (r) => `${cap(`the ${r.fromName}`)} orders us to stand off or be fired upon`,
  surrender: (r) => `${cap(`the ${r.fromName}`)} offers to surrender`,
};
const REQUEST_DETAIL = {
  inspect: 'Heave to and they search us (about 45 min alongside): contraband seized, fines settled. Run and we are WANTED. Silence counts as heaving to only if we sit still.',
  demand: 'Pay and they leave. Refuse, or say nothing, and they go for our drive: they want a prize, not a wreck. A hail can haggle.',
  warning: 'Standing off turns the transponder on and cuts the drive. Ignored, they engage. Silence complies only if we are still and broadcasting.',
  surrender: 'Accept and they strike: drive cold, tubes open. Hold formation and hail to take them in. Silence ignores it.',
};

function ruleRequests(state, c, add) {
  for (const r of state.comms.requests) {
    const left = Math.max(0, r.expires - c.now);
    const words = (REQUEST_WORDS[r.kind] || ((x) => `${cap(`the ${x.fromName}`)} wants an answer`))(r);
    add({
      key: `request:${r.id}`, level: CAUTION, rank: 100 + (15 - Math.min(15, left)),
      text: `${words} (${left} min).`.length <= MAX_TEXT ? `${words} (${left} min).` : `${words}.`,
      detail: REQUEST_DETAIL[r.kind],
      actions: [
        ...r.options.map(o => act(o.id, o.label, { type: 'respond', request: r.id, option: o.id })),
        r.kind === 'demand' && A.hail(r.from, 'HAIL'),
      ],
    });
  }
  // An inspection under way: the patrol is coming alongside, or searching us
  for (const e of c.world.driven) {
    const a = e.agent;
    if (!a || (a.mode !== 'search-approach' && a.mode !== 'search') || a.target !== PLAYER) continue;
    add({
      key: 'inspection', level: CAUTION, rank: 92, sig: a.mode,
      text: a.mode === 'search' ? `${cap(knownName(state, e))} is searching us: hold still until they are done.` : `Hold still: ${knownName(state, e)} is coming alongside to search us.`,
      detail: 'Burning away, or opening the range past 50,000 km, counts as resisting: WANTED.',
      actions: [],
    });
    break;
  }
}

// ---- WORK: distress calls, orders, contracts, boarding ----

function ruleDistress(state, c, add) {
  for (const m of state.missions.list) {
    if (m.status !== 'offered' && m.status !== 'accepted') continue;
    const e = c.world.get(m.entityId);
    if (!e) continue;
    const dM = distM(c, e);
    const attack = m.type === 'UNDER_ATTACK';
    if (m.status === 'offered') {
      add({
        key: `sos:${m.id}`, level: CAUTION, rank: 70 + Math.max(0, 10 - m.timer / 144),
        text: attack ? `The ${e.name} is under attack and calling for help, ${fmtMeters(dM)} out.`
          : `Distress call from the ${e.name}: ${dur(m.timer)} to live, ${fmtMeters(dM)} out.`,
        detail: attack ? 'Accepting puts them under our point defense. Drive the raiders off, then hold formation and hail.' : 'Accept in the mission log, intercept, hold formation within 10 km and hail them.',
        actions: [A.missions(), A.plot(e.id, 'PLOT INTERCEPT')],
      });
      continue;
    }
    // Answered: on our way, or alongside and ready to take them in
    const holding = c.f.hold?.id === e.id && dM <= RESCUE_M;
    if (holding) {
      const raiders = attack && (m.attackers || []).some(id => {
        const x = c.world.get(id);
        return x?.agent && x.combat?.status !== 'wreck' && x.combat?.status !== 'surrendered' && x.agent.mode !== 'leave' && x.agent.hostile.includes(m.entityId);
      });
      add({
        key: `sos:${m.id}`, level: CAUTION, rank: 76, sig: raiders ? 'raiders' : 'formation',
        text: raiders ? `Raiders are still on the ${e.name}: deal with them before we take her in.` : `In formation with the ${e.name}: hail them to complete the rescue.`,
        actions: raiders ? [!state.combatStations && A.battle(), A.weapons()] : [A.hail(e.id, 'HAIL')],
      });
    } else if (!headingFor(state, c, e.id)) {
      add({
        key: `sos:${m.id}`, level: CAUTION, rank: 72, sig: 'unplotted',
        text: `We answered the ${e.name}'s call but plotted no intercept: ${dur(m.timer)} left.`,
        actions: [A.plot(e.id, 'PLOT INTERCEPT')],
      });
    }
  }
}

function ruleOrders(state, c, add) {
  if (!contractor(state)) return;
  for (const cu of openCallups(state)) {
    if (cu.reported || headingFor(state, c, cu.ship)) continue;
    add({
      key: `callup:${cu.zoneId}`, level: CAUTION, rank: 65,
      text: `${FACTIONS[cu.faction].navy} command orders us to the ${cu.shipName} near ${cu.body}.`,
      detail: 'Alongside, we have reported: for as long as the fight lasts its supplies, field repairs and torpedoes cost a tenth.',
      actions: [A.plot(cu.ship, 'PLOT ALONGSIDE', true), A.missions()],
    });
  }
}

/**
 * Our own navy's forward command (a FOB) on its post within half an AU,
 * with no call-up to it in hand: that it is there, and what it is good for.
 */
const FOB_NEAR_M = 0.5 * AU_M;
function ruleFob(state, c, add) {
  const L = flagOf(state);
  if (!L || state.dock?.phase === 'docked') return;
  const called = new Set(openCallups(state).filter(cu => !cu.reported).map(cu => cu.ship));
  let best = null;
  for (const e of c.world.forces) {
    if (e.faction !== L || !commandOnStation(e) || called.has(e.id)) continue;
    const d = distM(c, e);
    if (d < FOB_NEAR_M && (!best || d < best.d)) best = { e, d };
  }
  if (!best || headingFor(state, c, best.e.id)) return;
  add({
    key: `fob:${best.e.id}`, level: ADVICE, rank: 36, sig: best.e.id,
    text: `Our FOB, the ${best.e.name}, ${fmtMeters(best.d)} off: military work, supplies at a tenth.`,
    detail: `The ${FACTIONS[L].navy}'s forward command at ${best.e.tags.command.body}: it takes its contractors alongside, posts their missions, and supplies them at a tenth of the price while its fight lasts.`,
    actions: [A.plot(best.e.id, 'ALONGSIDE', true)],
  });
}

/** Where a contract's next leg goes (as the mission log plots it). */
function contractTarget(c) {
  if (c.phase === 'return') return { id: c.station, name: c.stationName };
  if (c.type === 'STRIKE' && c.markId) return { id: c.markId, name: c.targetName };
  if (c.type === 'ESCORT' && c.phase !== 'arrived') return { id: c.targetId, name: c.targetName };
  if (c.dest) return { id: c.dest, name: c.destName };
  if (c.markId && (c.type === 'BOUNTY' || c.type === 'RECON')) return { id: c.markId, name: c.targetName };
  return c.targetId ? { id: c.targetId, name: c.targetName } : null;
}

function ruleContracts(state, c, add) {
  const active = state.contracts.active.filter(x => x.phase !== 'complete' && x.phase !== 'failed');
  if (!active.length) return;
  // Ready to turn in where we are
  const where = c.port || (c.tcSt && inPort(state, c.tcSt) ? c.tcSt : null);
  const ready = where ? deliverable(state, where) : [];
  if (ready.length) {
    const byRadio = c.port ? ready : ready.filter(x => !needsBerth(x, state));
    const label = (x) => CONTRACT_LABEL[x.type]?.toLowerCase() || 'contract';
    if (byRadio.length) {
      add({
        key: 'turn-in', level: CAUTION, rank: 60, sig: byRadio.map(x => x.id),
        text: byRadio.length === 1 ? `We can turn in the ${label(byRadio[0])} at ${where.name}.` : `We can turn in ${byRadio.length} contracts at ${where.name}.`,
        actions: [A.station(where.id, 'deliver', 'TURN IN')],
      });
    } else if (c.dock?.target.id !== where.id) {           // (not while we are docking there already)
      const cl = clearanceFor(state, where.id);
      add({
        key: 'turn-in', level: ADVICE, rank: 58, sig: ready.map(x => x.id),
        text: `Dock at ${where.name} to deliver the ${label(ready[0])}.`,
        actions: [cl.dock ? A.dock(where.id) : A.requestDocking(where.id)],
      });
    }
  }
  // The next leg of the most pressing contract, when we are flying nowhere
  if (c.ap || (c.dock && c.dock.phase !== 'docked')) return;
  const readySet = new Set(ready);
  const next = active.filter(x => !readySet.has(x)).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))[0];
  if (!next) return;
  const due = (next.dueAt ?? Infinity) - c.now;
  if (next.type === 'PLANETSIDE') {
    // (a world's ground: a high orbit round it first, then the shuttle: ruleShuttles)
    if (state.flight.hold?.kind === 'orbit' && state.flight.hold.id === next.world) return;
    add({
      key: `contract:${next.id}`, level: due < 12 * 60 ? CAUTION : ADVICE, rank: 60, sig: next.phase,
      text: `Next: freight to ${next.destName}, due in ${dur(due)}: by shuttle, from orbit.`,
      detail: `A PLANETSIDE contract: take us into a high orbit round ${next.world} (ORBIT), then send a shuttle down to the spaceport with the freight (G). It is paid by radio when it lands.`,
      actions: [act('plot', `ORBIT ${next.world.toUpperCase()}`, { type: 'plot', target: { kind: 'body', id: next.world } }), A.missions()],
    });
    return;
  }
  const t = contractTarget(next);
  const label = CONTRACT_LABEL[next.type]?.toLowerCase() || 'contract';
  if (!t?.id || !c.world.get(t.id) || headingFor(state, c, t.id)) return;
  const tgt = c.world.get(t.id);
  const dock = tgt.type === 'station' && needsBerth(next, state);   // (goods and people cross a berth's collar, a bounty's crew too; reports go by radio)
  const text = next.phase === 'return'
    ? `The ${label} is done: report to ${next.mil ? `any ${short(next.faction)} port` : t.name}, due in ${dur(due)}.`
    : `Next: the ${label} ${next.dest ? 'to' : 'at'} ${t.name || 'its target'}, due in ${dur(due)}.`;
  add({
    key: `contract:${next.id}`, level: due < 12 * 60 ? CAUTION : ADVICE, rank: 60, sig: next.phase,
    text,
    actions: [A.plot(t.id, `PLOT TO ${(t.name || 'TARGET').toUpperCase()}`, dock), A.missions()],
  });
}

function ruleBoarding(state, c, add) {
  const b = state.boarding;
  if (!b || b.phase === 'done') return;
  if (b.phase === 'fight') {
    add({ key: 'boarding', level: CAUTION, rank: 82, sig: 'fight', text: `Our boarding party is fighting aboard the ${b.name}: ${plural(b.defenders, 'defender')} left.`, actions: [A.boarding()] });
  } else if (b.phase === 'secured' && !b.action) {
    add({ key: 'boarding', level: ADVICE, rank: 64, sig: 'secured', text: `The ${b.name} is secured: the boarding party awaits orders.`, actions: [A.boarding()] });
  }
}

/**
 * Charges we set on a hull's reactor (boarding.js SCUTTLE): its time left,
 * the party's way home, and how far we must be to be clear of it. Said
 * while the party is still across or we are inside its blast; a warning
 * once it is near going with us still inside.
 */
/**
 * Shuttles: one out (where it is, and that we wait for it: its crew are
 * away); one waiting for us out of reach; freight aboard for a world's
 * ground with us in a high orbit round it.
 */
function ruleShuttles(state, c, add) {
  for (const run of activeRuns(state)) {
    const rd = runReadout(state, run);
    const waiting = rd.phase === 'hold';
    add({
      key: `shuttle:${run.id}`, level: waiting ? CAUTION : INFO, rank: waiting ? 70 : 40, sig: rd.phase,
      text: waiting ? `${run.name} is waiting for us in orbit round ${run.world}: come back into its planetary space to pick it up.`
        : `${run.name} ${rd.words} (${run.port.name}): home in ${dur(rd.eta)}.`,
      detail: `Its crew are away until it is back in its bay: the routes wait for them. Breaking our orbit sends it after us when it comes home.`,
      actions: [A.shuttles()],
    });
  }
  const f = c.f;
  if (f.hold?.kind !== 'orbit' || c.dock || activeRuns(state).length) return;
  const no = runRefusal(state);
  if (no.why) return;
  const freight = state.contracts.active.filter(x => x.type === 'PLANETSIDE' && x.world === no.w.name && state.cargo.some(i => i.contract === x.id));
  if (!freight.length) return;
  add({
    key: `shuttle-freight:${no.w.name}`, level: ADVICE, rank: 46, sig: freight.map(x => x.id).join(','),
    text: `Freight aboard for ${freight[0].destName}${freight.length > 1 ? ` and ${freight.length - 1} more` : ''}: a shuttle can take it down.`,
    actions: [A.shuttles(freight[0].airspace)],
  });
}

/**
 * The market where we are docked: goods aboard it pays more for than we
 * paid (the best of them, if it is worth the saying), and contraband a
 * licensed captain can turn over here.
 */
function ruleMarket(state, c, add) {
  const turn = turnOverHere(state);
  if (turn) {
    add({
      key: 'turn-over', level: ADVICE, rank: 52, sig: turn.items.map(x => x.good).join(','),
      text: `Contraband aboard: turn it over to ${turn.port.name} for reputation.`,
      detail: 'A licensed captain hands contraband goods to its own power: reputation toward the next rank, and standing. Carried in anyone else\'s space, it is seized and fined.',
      actions: [A.station(turn.port.id, !turn.port.tags?.command && STATIONS[turn.port.id]?.services.includes('market') ? 'market' : 'services', 'TURN IT OVER')],
    });
  }
  const id = marketHere(state);
  if (!id) return;
  let best = null;
  for (const g of new Set(state.cargo.filter(x => x.good && !x.contract && x.cost > 0).map(x => x.good))) {
    if (tradeRefusal(state, id, g, 'sell')) continue;
    const items = state.cargo.filter(x => x.good === g && !x.contract && !x.stolen && x.cost > 0);
    const t = items.reduce((s, x) => s + x.mass, 0) / 1000, paid = items.reduce((s, x) => s + (x.cost || 0), 0);
    if (t < 0.05) continue;
    const gain = quote(state, id, g, t, 'sell').total - paid;
    if (gain > 500 && (!best || gain > best.gain)) best = { g, t, gain };
  }
  if (best) {
    add({
      key: 'market-sell', level: ADVICE, rank: 44, sig: `${best.g}:${Math.round(best.gain / 500)}`,
      text: `${GOODS[best.g].name} sells here for ${Math.round(best.gain).toLocaleString()} MCR more than we paid.`,
      actions: [A.station(id, 'market', 'MARKET')],
    });
  }
}

function ruleScuttle(state, c, add) {
  for (const id of state.combat.fuses || []) {
    const e = c.world.get(id);
    if (!e?.tags?.scuttled || e.combat?.containment == null) continue;
    const left = e.combat.containment;
    const d = Math.hypot(e.pos.x - c.f.pos.x, e.pos.y - c.f.pos.y) * AU_M;
    const clear = blastClearM(e);
    const b = state.boarding;
    const out = !!b && b.phase !== 'done' && b.target === e.id;
    if (!out && d > clear) continue;
    const close = left <= (out ? 30 : 15);
    add({
      key: `scuttle:${id}`, level: close ? WARNING : CAUTION, rank: close ? 98 : 84, sig: `${out ? 'out' : 'home'}${close ? '-close' : ''}`,
      text: out ? `${dur(left)} on the scuttling charges: the party is coming back, then get ${fmtMeters(clear)} clear.`
        : `${dur(left)} on the scuttling charges: get ${fmtMeters(clear)} clear of it (${fmtMeters(d)} now).`,
      detail: `Charges set on the ${e.name}'s reactor: it loses containment when they go, and anything within ${fmtMeters(clear)} is hit by the blast. The route waits for the party, and for the crew to strap in.`,
      actions: [out && A.boarding()],
    });
  }
}

// ---- STORES & MACHINERY ----

function ruleStores(state, c, add) {
  const res = state.resources;
  const mouths = c.crew.length + c.pax;
  if (!mouths) return;
  const eta = routeEta(state, c);
  const dest = c.ap && eta != null ? targetName(state, c.ap.plan.target) : null;
  const water = res.water.current / (mouths * WATER_GROSS_PER_MIN * (1 - waterRecovery(state)) || Infinity);
  const food = res.food.current / (mouths * FOOD_PER_MIN);
  const air = (state.lifeSupport?.oxygenHours ?? Infinity) * 60;
  for (const [k, label, left] of [['water', 'Water', water], ['food', 'Food', food], ['o2', 'Oxygen', air]]) {
    if (!isFinite(left)) continue;
    const low = latch(c.mem, `stores:${k}`, left, 3 * DAY_MIN, 4 * DAY_MIN);
    const short_ = dest && left < eta + 60;
    if (!low && !short_) continue;
    add({
      key: `stores:${k}`, level: left < 12 * 60 ? WARNING : CAUTION, rank: 50, sig: left < 12 * 60 ? 'out' : short_ && !low ? 'route' : 'low',
      text: short_ && !low ? `${label} runs out before we reach ${dest}: ${dur(left)} left.` : `${label} for ${dur(left)} with ${plural(mouths, 'mouth')} aboard.`,
      actions: resupplyActions(state, c),
    });
  }
  // Point-defense rounds (an armed ship: they go fast in a fight)
  if (res.pdcRounds.max > 0) {
    const pct = res.pdcRounds.current / res.pdcRounds.max;
    if (!c.port && latch(c.mem, 'stores:pdc', pct, 0.15, 0.2)) {
      add({ key: 'stores:pdc', level: ADVICE, rank: 40, text: `PDC rounds at ${Math.round(pct * 100)}%: point defense runs dry fast.`, actions: resupplyActions(state, c) });
    }
  }
}

function ruleMachinery(state, c, add) {
  const units = state.systems.units;
  const parts = state.resources.parts.current;
  const failed = [], noParts = [], giving = [];
  for (const id of shipSystems(state)) {
    const u = units[id];
    if (!u.enabled) continue;                                  // (switched off on purpose)
    if (u.status === Status.FAILED && KEY_SYSTEMS.has(id)) failed.push(id);
    if ((u.status === Status.DEGRADED || u.status === Status.FAILED) && parts < partsFor(state, u.fault?.severity || 'major')) noParts.push(id);
    if (u.status === Status.PATCHED && u.patchUntil != null && u.patchUntil - c.now < 3 * 60) giving.push(id);
  }
  // (in a sentence: 'the flight computer', but 'the Epstein drive', 'the RCS thrusters')
  const nm = (id) => /^(Epstein|RCS)/.test(SYSTEMS[id].name) ? SYSTEMS[id].name : lcFirst(SYSTEMS[id].name);
  if (failed.length) {
    const id = failed[0];
    const job = state.jobs.list.find(j => j.type === JobType.REPAIR && j.data?.system === id);
    const fixer = job?.assignee != null ? state.ship.crew.find(m => m.id === job.assignee)?.name : null;
    // (the flight computer down with nobody at the helm is said louder already)
    if (!(id === 'flightComputer' && failed.length === 1 && c.ap?.helm === 'unmanned')) {
      add({
        key: 'failed', level: CAUTION, rank: 48, sig: failed,
        text: failed.length === 1 ? `${cap(nm(id))} failed: ${lcFirst(SYSTEMS[id].effects.failed)}.` : `${failed.length} systems have failed: ${list(failed.map(nm), 2)}.`,
        detail: `${units[id].fault?.text ? `${units[id].fault.text}. ` : ''}${fixer ? `${fixer} is on the repair.` : 'The repair waits for an engineer.'}`,
        actions: [A.systems()],
      });
    }
  }
  if (noParts.length) {
    add({
      key: 'parts', level: CAUTION, rank: 50, sig: noParts,
      text: noParts.length === 1 ? `No spare parts to repair the ${nm(noParts[0])}: only a jury-rig.` : `No spare parts for ${noParts.length} repairs: only jury-rigs.`,
      detail: 'A jury-rig runs at half performance and gives out in hours or days. Spare parts are sold in port; the machine shop refurbishes scrap.',
      actions: [...resupplyActions(state, c, 'BUY PARTS'), A.systems()],
    });
  } else if (giving.length) {
    const u = units[giving[0]];
    add({
      key: 'parts', level: CAUTION, rank: 46, sig: giving,
      text: `The jury-rig on the ${nm(giving[0])} gives out in ${dur(u.patchUntil - c.now)}.`,
      actions: [...resupplyActions(state, c, 'BUY PARTS'), A.systems()],
    });
  }
}

// ---- IN PORT: what a berth is for ----

function rulePortCall(state, c, add) {
  const port = c.port;
  if (!port) return;
  const st = c.dockedSt;
  const spec = st ? STATIONS[st.id] : null;
  const res = state.resources;
  // The board, when we have no work and no course
  if (!state.contracts.active.length && !c.ap) {
    const standingOK = !POWERS.includes(port.faction) || (state.law.standing[port.faction] ?? 0) >= -20;
    const board = standingOK ? contractsAt(state, port.id).filter(x => !x.mil || !milRefusal(state, x)) : [];
    if (board.length) {
      add({
        key: 'board', level: ADVICE, rank: 50, sig: String(board.length),
        text: `${port.name} has ${plural(board.length, 'contract')} on its board for us.`,
        actions: [A.station(port.id, 'board', 'OPEN BOARD')],
      });
    }
  }
  // A top-up while we are here
  if (supplier(state, c)) {
    // (stores under 60%; spare parts by count, as the HUD flags them; PDC rounds under half)
    const pct = (k) => res[k].current / res[k].max;
    const said = { water: 'stores:water', food: 'stores:food', o2Tank: 'stores:o2', medSupplies: 'stores:med' };
    const low = [['fuel', 'fuel'], ['water', 'water'], ['food', 'food'], ['o2Tank', 'O₂'], ['medSupplies', 'med']]
      .filter(([k]) => res[k].max > 0 && pct(k) < 0.6 && !c.keys.has(said[k])).map(([k, l]) => `${l} ${Math.round(pct(k) * 100)}%`);
    if (res.parts.current < 6) low.push(`${fmtNum(res.parts.current)} spare parts`);
    if (res.pdcRounds.max > 0 && pct('pdcRounds') < 0.5) low.push(`PDC rounds ${Math.round(pct('pdcRounds') * 100)}%`);
    if (low.length) {
      add({ key: 'resupply', level: ADVICE, rank: 45, sig: low.map(x => x.replace(/[\d.,%]+/g, '').trim()), text: `We could top up here: ${list(low, 3)}.`, actions: [A.station(port.id, 'services', 'SUPPLIES')] });
    }
  }
  // The yard
  if (port.tags?.command || spec?.services.includes('repair')) {
    const sick = shipSystems(state).filter(id => { const u = state.systems.units[id]; return u.status !== Status.NOMINAL || u.integrity < 50; });
    const hull = state.hull.integrity;
    if (hull < 90 || sick.length) {
      const what = hull < 90 && sick.length ? `Hull at ${Math.round(hull)}% and ${plural(sick.length, 'system')} worn` : hull < 90 ? `Hull at ${Math.round(hull)}%` : `${plural(sick.length, 'system')} faulted or worn`;
      add({ key: 'overhaul', level: ADVICE, rank: 40, sig: sick, text: `${what}: ${port.tags?.command ? 'field repairs are on offer' : 'the yard here can overhaul us'}.`, actions: [A.station(port.id, 'services', 'OVERHAUL')] });
    }
  }
  // Shore leave for a worn-down crew
  if (spec?.services.includes('leave') && !c.crew.some(m => m.away?.ashore) && c.aboard.length) {
    const morale = c.aboard.reduce((s, m) => s + m.morale, 0) / c.aboard.length;
    const rest = c.aboard.reduce((s, m) => s + m.needs.rest, 0) / c.aboard.length;
    const fever = c.aboard.filter(m => (c.now - (m.lastLeave ?? c.now)) / DAY_MIN > CABIN_FEVER_DAYS).length;
    if (morale < 50 || rest < 30 || fever >= Math.ceil(c.aboard.length / 2)) {
      add({
        key: 'shore-leave', level: ADVICE, rank: 35,
        text: morale < 50 || rest < 30 ? `The crew are worn down (morale ${Math.round(morale)}): shore leave is 60 MCR a head.` : `${plural(fever, 'hand')} ${fever === 1 ? 'has' : 'have'} gone weeks without a run ashore: leave is 60 MCR a head.`,
        detail: 'Eight hours ashore: back rested, fed, washed and in better spirits. The berth lease must cover the run.',
        actions: [A.station(st.id, 'leave', 'SHORE LEAVE')],
      });
    }
  }
}

// ---- WHERE WE ARE ----

function ruleSituation(state, c, add) {
  // Inside a hot zone
  const zone = zonesAt(state, c.f.pos)[0];
  if (zone) {
    const shooting = SHOOTING_ZONES.has(zone.kind);
    const k = ZONE_KINDS[zone.kind];
    add({
      key: `zone:${zone.id}`, level: shooting && !state.combatStations ? CAUTION : ADVICE, rank: 38,
      text: `We are inside the ${k.label.toLowerCase()} near ${zone.body}.`,
      detail: k.desc,
      actions: [shooting && !state.combatStations && A.battle()],
    });
  }
  // A course into one (zones whose news has reached us)
  const ap = c.ap;
  if (ap && ap.plan.target.kind === 'entity') {
    const e = c.world.get(ap.plan.target.id.replace(/-gate$/, '')) || c.world.get(ap.plan.target.id);
    if (e) {
      for (const z of state.politics.zones) {
        if (z === zone || !state.intel?.zones?.[z.id]) continue;
        const p = zonePos(z, c.now);
        if (Math.hypot(p.x - e.pos.x, p.y - e.pos.y) > z.radius) continue;
        add({ key: `route-zone:${z.id}`, level: ADVICE, rank: 20, text: `Our course ends inside the ${ZONE_KINDS[z.kind].label.toLowerCase()} near ${z.body}.`, detail: ZONE_KINDS[z.kind].desc, actions: [] });
        break;
      }
    }
  }
  // Adrift: no course, nothing holding us (nor clearing off a port: autopilot.js clearOutTick), the drive cold (not said over an emergency)
  if (!c.loud && !ap && !c.dock && !c.f.hold && !c.f.leaving && !(c.f.manual?.throttleG > 0) && !(state.$terrain?.k > 0)) {
    add({ key: 'idle', level: ADVICE, rank: 30, text: 'We are drifting with no course set.', actions: [A.map()] });
  }
}

const RULES = [
  ruleReactor, ruleOrdnance, ruleDecks, ruleCrew, ruleHostiles, rulePort, ruleFlight,
  ruleRequests, ruleBoarding, ruleScuttle, ruleShuttles, ruleMarket, ruleDistress, ruleOrders, ruleFob, ruleContracts, ruleLaw,
  ruleStores, ruleMachinery, rulePortCall, ruleSituation,
];

// ---- INFO: what we are doing ----

const DOCK_WORDS = {
  approach: (n) => `On the final approach to ${n}.`, spin: (n) => `Matching ${possessive(n)} tumble before docking.`, prox: (n) => `Docking with ${n}: proximity operations.`,
  capture: (n) => `Soft capture at ${n}: latching.`, seal: (n) => `Hard dock at ${n}: equalizing the lock.`,
  undock: (n) => `Undocking from ${n}: venting the lock.`, separate: (n) => `Backing off ${n} on the RCS.`,
  holding: (n) => `Holding off ${n}.`, outbound: (n) => `Climbing out of ${possessive(n)} gate on the RCS.`,
  awaiting: (n) => `Holding at ${possessive(n)} gate.`,
};

function status(state, c) {
  const ap = c.ap, d = c.dock, f = c.f;
  const base = { key: 'status', level: INFO, rank: 0 };
  if (d?.phase === 'docked') {
    const e = c.world.get(d.target.id);
    if (!e) return null;
    if (d.target.kind !== 'station') return { ...base, sig: 'alongside', text: `Alongside the ${e.name}.`, actions: [] };
    const until = d.lease?.until ?? (d.at ?? c.now) + FREE_LEASE_MIN;
    return { ...base, sig: 'docked', text: `Docked at ${e.name}: berth lease ${dur(until - c.now)} left.`, actions: [] };
  }
  if (d && DOCK_WORDS[d.phase]) {
    const e = c.world.get(d.target.id);
    return e ? { ...base, sig: d.phase, text: DOCK_WORDS[d.phase](e.name), actions: [] } : null;
  }
  if (ap) {
    const name = targetName(state, ap.plan.target);
    const target = { kind: ap.plan.target.kind, id: ap.plan.target.id, ...(ap.plan.target.slot ? { slot: ap.plan.target.slot } : {}) };
    const eta = routeEta(state, c);
    const flip = isFinite(ap.flipIn) && ap.flipIn > 0 ? `, flip in ${dur(ap.flipIn)}` : '';
    const arrive = eta != null ? `, arriving in ${dur(eta)}` : '';
    let text;
    if (ap.plan.kind === 'stance') text = `Keeping ${fmtMeters(ap.plan.standoff)} off ${name}.`;
    else switch (ap.display) {
      case 'prepare': text = `Securing for the burn to ${name}.`; break;
      case 'burn': case 'transfer-burn': text = `Burning for ${name} at ${fmtG(f.thrustG)}${flip || arrive}.`; break;
      case 'coast': text = `Coasting to ${name}${flip || arrive}.`; break;
      case 'brake': text = `Braking for ${name}${arrive}.`; break;
      case 'approach': text = `Closing on ${name} on the RCS${arrive}.`; break;
      case 'flip': case 'orient': text = `Turning for the burn to ${name}.`; break;
      case 'depart': text = `Leaving port on the RCS, bound for ${name}.`; break;
      case 'climb': text = `Climbing round a rock on the way to ${name}.`; break;
      default: text = `Under way to ${name}${arrive}.`;
    }
    const warp = ap.phase === 'active' && state.speed > 0 && state.speed < 3 && maxSpeed(state) >= 3;
    return { ...base, sig: ap.display, text, actions: [A.select(target), warp && A.speed(3, 'WARP ×3')] };
  }
  if (f.leaving) {
    // (CLEAR OFF with no route: out of the approach on the RCS, then the way taken off: autopilot.js clearOutTick)
    const e = c.world.get(f.leaving.station);
    if (!e) return null;
    const rM = Math.hypot(f.pos.x - e.pos.x, f.pos.y - e.pos.y) * AU_M;
    const text = f.leaving.out ? `Clear of ${possessive(e.name)} approach, the torch free: taking the way off on the RCS.`
      : `Clearing ${possessive(e.name)} approach on the RCS: the torch is free in ${Math.round(Math.max(0, APPROACH_M * DEPART_OUT - rM) / 1000).toLocaleString()} km.`;
    return { ...base, sig: f.leaving.out ? 'cleared' : 'clearing', text, actions: [A.map()] };
  }
  if (f.hold) {
    const name = targetName(state, f.hold);
    return { ...base, sig: 'hold', text: `Holding station at ${name}.`, actions: [A.map()] };
  }
  return null;
}
