// ============================================================
// LONGHAUL — NPC ships with someone at the helm
//
// Most of the world's ships are traffic on rails. A ship becomes an
// *agent* when it has a reason to act near us: a patrol on its beat,
// a pirate lying in wait, a warship in a contested zone, a hauler
// fleeing an attack, a convoy we are escorting. Agents are driven
// world entities: every minute they decide (this module) and fly
// (moveAgents) with the same flight model and guidance laws as our
// own ship — slew limits, drive limits, the closing law. An enemy is
// flown to on where it is and how it moves, never on its thrust (two
// ships matching each other's burn would never meet).
//
// Roles and their modes:
//   patrol/picket  cruise → intercept → (inspection) search → cruise
//                  … or engage criminals and anyone resisting arrest
//   pirate         lurk → stalk → demand → engage → loot → leave
//   navy           patrol → engage enemy warships; warn off strangers
//   civilian       flee from whoever is shooting, then drift (a miner
//                  turns its gear on anyone who comes close)
//   convoy         wait at its port's gate, then travel gate to gate and
//                  berth (escort contracts)
//
// Fight or run. A ship weighs a fight by strength (its own against the
// enemy's) and breaks off when it is outgunned or hurt; a pirate lying
// dark that is found by a ship it can't fight runs before it is shot at.
// Running is done as a captain with people aboard would (run): a sprint
// at the drive's best while the crew can take it, then what a juiced crew
// takes for days. Past HIGH_DOSE_G every minute costs strokes, NPC crews
// as ours (crew.js): no one holds 8G for hours. A ship running silent
// (no transponder) cuts its drive and coasts dark as soon as it is out
// past what the pursuer's sensors hold of a cold hull, and stays dark
// until it is found again. Run down all the same, it strikes if its kind
// ever does, or turns and fights it out.
//
// Talking to us goes through *requests* (state.comms.requests): an
// order to heave to, a pirate's ultimatum, a warning, an offer of
// surrender. Each has options and a deadline; silence is an answer.
//
// Agents are few and bounded (the background forces wake near us, the
// encounter director and contracts spawn them; they leave when their
// business is done or we are far away), so per-minute work here never
// scales with the world. A hull of the background population (forces.js)
// or traffic woken for a fight doesn't leave the world: it goes back on
// rails. A woken police cutter on ROUTINE leaves law-abiding ships alone;
// the director's patrol encounter is the one that comes to look at us.
//
// A captain flying a power's flag (service.js) is a combatant to the
// rest: once a warship or patrol knows who we are, an enemy of our power
// engages us, a hostile one warns us off its zone, and our power's
// friends come to our help when we are attacked. Our own side's patrols
// wave a contractor of some rank through. A proxy's raiders (pirate
// brains with a `prey`) hunt one power's shipping, and its contractors.
// ============================================================

import { groundCheck, terrainGuard, hoverCmd } from './terrain.js';
import { AU_M, G0, MIN_S, DAY_MIN } from '../core/constants.js';
import { randInt, chance } from '../core/rng.js';
import { getWorld, predictEntity } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES, TECH } from './ship-classes.js';
import { FACTIONS } from './factions.js';
import { flightStep, SLEW_RATE } from './flight.js';
import { createPlan, guidanceStep, targetStateAt } from './nav.js';
import { abortRoute } from './autopilot.js';
import { REVEAL, canSee, signatureRange, hullSignature } from './sensors.js';
import { HIGH_DOSE_G, STROKE_RISK } from './crew.js';
import { knownName } from './flags.js';
import {
  PLAYER, kinematics, profile, snapshot, sees, strength, ensureHull, isOutOfFight, sensorQuality, DISABLED_BELOW,
} from './combatants.js';
import { launchTorpedo, fireRailgun, strafe, fireGear, inboundTo, launchedBy, timeToGo, torpedoForecast } from './ordnance.js';
import { hullTick } from './damage.js';
import { wantedBy, settleInspection, adjustStanding, inJurisdiction, recentlyInspected } from './law.js';
import { TORPEDO_RELOAD_MIN, RAIL_RELOAD_MIN, RAIL_RANGE_M, COUNTER_BURN_S, UNDER_FIRE_CLOSE_MS } from './weapons.js';
import { putToSleep } from './forces.js';
import { enemyOf, hostileTo, friendOf, flagOf, hullLegal, navyOf, rankOf, RANK_FOR } from './service.js';
import { releaseHull, parkHull, gateId } from './stations.js';

/**
 * How each role fights. launchAU: torpedo launch range · standoffM: distance
 * held in a fight (m) — outside the enemy's guns; ships that `closeIn` come
 * to PDC range only to finish a crippled or toothless target. They break off
 * below retreatHp structure, or when outgunned past breakOff (own strength
 * over the enemy's).
 */
export const ROLES = {
  patrol: { aim: 'disable', launchAU: 0.003, standoffM: 50_000_000, closeIn: true, retreatHp: 0.3, breakOff: 0.35, surrenders: true, nukes: false, approachG: 3 },     // 50,000 km
  picket: { aim: 'disable', launchAU: 0.003, standoffM: 50_000_000, closeIn: true, retreatHp: 0.3, breakOff: 0.35, surrenders: true, nukes: false, approachG: 3 },
  pirate: { aim: 'disable', launchAU: 0.004, standoffM: 100_000_000, closeIn: true, retreatHp: 0.5, breakOff: 0.35, surrenders: true, nukes: false, approachG: 3 },    // 100,000 km
  navy: { aim: 'kill', launchAU: 0.02, standoffM: 20_000_000, closeIn: false, retreatHp: 0.25, breakOff: 0.35, surrenders: false, nukes: true, approachG: 4 },        // 20,000 km: railgun range
  civilian: { surrenders: true, flees: true },
  convoy: { surrenders: true },
};

const IDLE_THINK = 5;                 // minutes between decisions when nothing is happening
const DESPAWN_AU = 0.25;              // ambient agents this far from us leave the simulation
const LEAVE_AU = 0.05;                // agents done with their business vanish past this
const DEMAND_AU = 0.0005;             // pirates make their demand from ~75,000 km
const HAIL_AU = 0.002;                // patrols order a stop from ~300,000 km
const WARN_AU = 0.0005;               // warships warn off strangers inside ~75,000 km
const SEARCH_MIN = 45;                // an inspection takes this long alongside
const LOOT_MIN = 60;
const REQUEST_MIN = 15;               // minutes to answer a request
const CALM_MIN = 360;                 // a fleeing civilian calms down after this long unthreatened
const PANIC_S = 2 * 3600;             // civilians run from torpedoes arriving within this
const PLAYER_THREAT_AU = 0.01;        // a civilian we fired on stays scared while we are this close
const PIRATE_NERVE = 0.5;             // pirates stalk ships up to twice their strength: a demand is a bluff

// Running (run): what a captain asks of a crew with bodies
export const SUSTAIN_G = HIGH_DOSE_G; // juiced on the couches, a crew takes this for days (past it: strokes)
export const SPRINT_LOSS = 0.1;       // the share of its crew a captain will spend in strokes to break contact
const DARK_MARGIN = 1.2;              // running silent, it goes cold this far out past the pursuer's reach on its hull
const CORNERED_S = 3600;              // a pursuer that will be on it inside this, its own best burn and all: no getting away

// ---- SPAWNING ----

/**
 * Put a new agent into the world.
 * opts: { role, cls?, kind?, category?, faction?, near?, pos, vel, mode?, home?, zone?, contract?,
 *         ambient?, hostile?: [ids], transponder?, tags?, name?, signature? }
 * Ask for a `kind` (a frigate) and the faction fields its own design; `cls` pins one.
 */
export function spawnAgent(state, opts) {
  const world = getWorld(state);
  const id = rollIdentity({ cls: opts.cls, kind: opts.kind, category: opts.category, faction: opts.faction, near: opts.near, sub: opts.sub, state });
  const role = opts.role;
  const e = createEntity({
    id: world.newId(role), name: opts.name || id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl,
    shipClass: id.shipClass, mass: id.mass, pos: opts.pos, vel: opts.vel, driven: true, signature: opts.signature,
    transponder: opts.transponder ?? (role !== 'pirate'), t: state.clock.minute, tags: { ...(opts.tags || {}) },
  });
  if (id.sub) e.sub = id.sub;
  makeAgent(state, e, role, opts);
  world.add(e);
  return e;
}

function makeAgent(state, e, role, opts = {}) {
  e.agent = {
    role, mode: opts.mode || defaultMode(role), since: state.clock.minute, next: state.clock.minute,
    target: opts.target ?? null, hostile: [...(opts.hostile || [])], aggressor: false, evade: false,
    wing: [], plan: null, planKey: '', cmd: null,
    home: opts.home || null, zone: opts.zone || null, contract: opts.contract || null, ambient: !!opts.ambient,
    dest: opts.dest || null, enemies: opts.enemies || [], scan: {}, flags: { routine: !!opts.routine, ...(opts.flags || {}) }, request: null, calmSince: state.clock.minute,
  };
  e.nav = { facing: Math.atan2(e.vel.vy, e.vel.vx), turning: 0 };
  ensureHull(e);
  e.$prev = snapshot(e.pos, e.vel);
}

const defaultMode = (role) => ({ patrol: 'cruise', picket: 'cruise', pirate: 'lurk', navy: 'patrol', civilian: 'drift', convoy: 'docked' }[role] || 'drift');

/**
 * Hand a ship on rails (traffic, a docked convoy) to a pilot: it leaves its
 * schedule and flies from where it is right now.
 */
export function wake(state, e, role, opts = {}) {
  const world = getWorld(state);
  if (e.agent) return e;
  world.refresh(e, state.clock.minute);
  if (e.tags.traffic) { e.tags.traffic = false; e.tags.woke = 'traffic'; if (state.traffic) state.traffic.spawned = Math.max(0, state.traffic.spawned - 1); }
  releaseHull(world, e);
  e.tags.at = null;
  world.setDriven(e, true);
  e.t = state.clock.minute;
  if (!e.cls) { e.cls = 'freighter'; e.tl = CLASSES.freighter.tl; }
  makeAgent(state, e, role, { ambient: true, ...opts });
  return e;
}

/** Put an agent back on rails beside a station (convoy arrived, patrol home). */
export function parkAt(state, e, station) {
  const world = getWorld(state);
  world.setDriven(e, false);
  parkHull(state, e, station, { reserve: false });
  e.thrust = 0;
  e.agent.mode = 'docked';
  e.agent.cmd = null;
  world.refresh(e, state.clock.minute);
  world.hash.update(e);
}

// ---- RELATIONS ----

export const isHostileTo = (e, id) => !!e?.agent?.hostile.includes(id);

/** `e` now fights `id` (and remembers who started it). */
export function makeHostile(state, e, id, { provoked = false } = {}) {
  const a = e.agent;
  if (!a || a.hostile.includes(id)) return;
  a.hostile.push(id);
  if (!a.target || isOutOfFight(getWorld(state).get(a.target))) a.target = id;
  if (ROLES[a.role]?.flees) { a.mode = 'flee'; a.calmSince = state.clock.minute; a.threat = id; }
  else if (ROLES[a.role]?.aim && a.mode !== 'flee' && a.mode !== 'leave') a.mode = 'engage';
  a.next = state.clock.minute;
  if (provoked && id === PLAYER) callForHelp(state, e);
  if (id === PLAYER) helpPlayer(state, e);
}

/** Someone went for a flagged captain: its power's friends' warships nearby come to its help. */
function helpPlayer(state, attacker) {
  if (!flagOf(state)) return;
  for (const o of getWorld(state).driven) {
    if (o === attacker || o.type !== 'ship' || !o.agent || isOutOfFight(o) || o.faction === attacker.faction) continue;
    if (!['patrol', 'picket', 'navy'].includes(o.agent.role) || !friendOf(state, o.faction)) continue;
    if (Math.hypot(o.pos.x - attacker.pos.x, o.pos.y - attacker.pos.y) < 0.02) makeHostile(state, o, attacker.id);
  }
}

/** A navy hull of `faction`'s (or one stolen from it) flown without its license. */
function stolenFrom(state, faction) {
  if (hullLegal(state)) return false;
  const n = navyOf(state.ship.classId);
  return n === faction || (n === 'stolen' && CLASSES[state.ship.classId]?.stolen === faction);
}

/** The player fired on a lawful ship: its side's patrols and warships nearby join in. */
function callForHelp(state, victim) {
  if (!FACTIONS[victim.faction]?.police) return;
  for (const o of getWorld(state).driven) {
    if (o === victim || o.type !== 'ship' || !o.agent || o.faction !== victim.faction) continue;
    if (!['patrol', 'picket', 'navy'].includes(o.agent.role)) continue;
    if (Math.hypot(o.pos.x - victim.pos.x, o.pos.y - victim.pos.y) < 0.02) makeHostile(state, o, PLAYER);
  }
}

/** Everyone currently fighting the player. */
export function hostilesOfPlayer(state) {
  const out = [];
  for (const e of getWorld(state).driven) if (e.type === 'ship' && e.agent?.hostile.includes(PLAYER) && !isOutOfFight(e)) out.push(e);
  return out;
}

// ---- REQUESTS (demands on the player) ----

function openRequest(state, e, kind, text, options, emit) {
  const C = state.comms;
  const r = {
    id: `rq-${C.nextRequest++}`, kind, from: e.id, fromName: e.name, faction: e.faction,
    text, options, at: state.clock.minute, expires: state.clock.minute + REQUEST_MIN,
  };
  C.requests.push(r);
  e.agent.request = r.id;
  emit('comm-request', { request: r });
  return r;
}

/** Answer a request. Returns { ok, text }. */
export function respondToRequest(state, requestId, option, emit = () => {}) {
  const C = state.comms;
  const i = C.requests.findIndex(r => r.id === requestId);
  if (i < 0) return { ok: false, text: 'That channel is closed.' };
  const r = C.requests[i];
  C.requests.splice(i, 1);
  const e = getWorld(state).get(r.from);
  if (!e?.agent) return { ok: false, text: 'No answer — they are gone.' };
  e.agent.request = null;
  e.agent.next = state.clock.minute;
  return REPLIES[r.kind](state, e, option, emit);
}

const REPLIES = {
  inspect(state, e, option, emit) {
    if (option === 'comply') {
      abortRoute(state, emit);
      if (state.flight.manual) state.flight.manual.throttleG = 0;
      e.agent.mode = 'search-approach';
      return { ok: true, text: `Drive cut. ${e.name} is coming alongside for the search.` };
    }
    refuseArrest(state, e, emit);
    return { ok: true, text: `You keep burning. ${e.name} reports you as resisting.` };
  },
  demand(state, e, option, emit) {
    if (option === 'pay') {
      const take = Math.min(state.resources.credits.current, e.agent.flags.demand || 0);
      state.resources.credits.current -= take;
      e.agent.mode = 'leave';
      e.agent.threat = null;
      emit('pirates-paid', { id: e.id, name: e.name, credits: take });
      return { ok: true, text: `${take.toLocaleString()} MCR transferred. The ${e.name} peels away.` };
    }
    makeHostile(state, e, PLAYER);
    return { ok: true, text: `"Your funeral." The ${e.name} is lighting its drive.` };
  },
  warning(state, e, option, emit) {
    if (option === 'comply') {
      state.comms.transponder = true;
      abortRoute(state, emit);
      e.agent.flags.warned = 'complied';
      return { ok: true, text: 'Transponder on, drive cut. The warship holds its fire — for now.' };
    }
    makeHostile(state, e, PLAYER);
    return { ok: true, text: `${e.name} has gone weapons-free on you.` };
  },
  surrender(state, e, option, emit) {
    if (option === 'accept') {
      surrender(state, e, emit, { accepted: true });
      return { ok: true, text: `${e.name} has struck. Their drive is cold and their tubes are open — hold formation and hail to take them in.` };
    }
    // (run down, and nobody takes the offer: it fights it out)
    if (e.agent.flags.cornered === 'offered') e.agent.flags.cornered = 'fight';
    return { ok: true, text: 'You leave the channel open and say nothing.' };
  },
};

/**
 * Requests nobody answered. Silence is an answer: a ship that sits still
 * is taken to comply with an order to stop; one that keeps burning, to
 * refuse it. Pirates take silence as no.
 */
function expireRequests(state, emit) {
  const now = state.clock.minute;
  const still = state.flight.thrustG < 0.1 && state.autopilot?.phase !== 'active';
  for (const r of [...state.comms.requests]) {
    if (now < r.expires) continue;
    emit('comm-request-expired', { request: r });
    const silence = r.kind === 'surrender' ? 'ignore'
      : (r.kind === 'inspect' || r.kind === 'warning') && still && (r.kind === 'inspect' || state.comms.transponder) ? 'comply' : 'refuse';
    respondToRequest(state, r.id, silence, emit);
  }
}

function refuseArrest(state, e, emit) {
  const L = state.law;
  if (e.faction in L.wanted) {
    L.wanted[e.faction] = Math.max(L.wanted[e.faction], 2);
    L.lastCrime[e.faction] = state.clock.minute;
    adjustStanding(state, e.faction, -15);
    emit('crime', { kind: 'resisting', victim: e.name, factions: [e.faction], at: state.clock.minute });
  }
  makeHostile(state, e, PLAYER);
}

/** Strike colours: drive cold, weapons safe, transponder on. */
export function surrender(state, e, emit = () => {}, { accepted = false } = {}) {
  const h = ensureHull(e);
  if (h.status === 'surrendered' || h.status === 'wreck') return;
  h.status = 'surrendered';
  e.transponder = true;
  e.agent.mode = 'surrendered';
  e.agent.cmd = null;
  e.agent.evade = false;
  e.agent.hostile = [];
  emit('ship-surrendered', { id: e.id, name: e.name, accepted });
}

// ---- PER MINUTE: FLY ----

/** Advance every agent one minute on the command it chose last minute. */
export function moveAgents(state, emit = () => {}) {
  const world = getWorld(state);
  const now = state.clock.minute;
  for (const e of world.driven) {
    if (e.type !== 'ship' || !e.agent) continue;
    e.$prev = snapshot(e.pos, e.vel);
    const p = profile(state, e.id);
    const f = { pos: e.pos, vel: e.vel, facing: e.nav.facing, maxG: p.maxG, $slew: SLEW_RATE, thrustG: 0, rcsG: 0, turning: e.nav.turning || 0 };
    let cmd = p.maxG > 0 ? e.agent.cmd : null;
    // its pilot keeps it off the rocks too (terrain.js); a dead drive can't
    if (p.maxG > 0) cmd = terrainGuard(e.pos, e.vel, cmd, e.agent.$toward || null, p.maxG * G0, now - 1) || cmd || hoverCmd(e.pos, e.vel, now - 1);
    flightStep(f, cmd, 1);
    if (f.thrustG > HIGH_DOSE_G) strain(e, f.thrustG);
    e.nav.facing = f.facing;
    e.nav.turning = f.turning;
    e.thrust = f.thrustG;
    e.heading = f.facing;
    e.t = now;
    world.hash.update(e);
    groundCheck(state, e, emit);                    // come down on a rock (terrain.js)
  }
}

/**
 * A minute past what juice covers: strokes take a share of the crew, at the
 * rate they take ours (crew.js). Fewer hands lay the guns worse (profile)
 * and the captain won't ask it again lightly (run).
 */
function strain(e, g) {
  const h = e.combat, loss = h.crew * STROKE_RISK * (g - HIGH_DOSE_G);
  h.crew = Math.max(0, h.crew - loss);
  e.agent.strain = (e.agent.strain || 0) + loss;
}

// ---- PER MINUTE: THINK ----

export function agentsTick(state, emit = () => {}) {
  const world = getWorld(state);
  expireRequests(state, emit);
  const agents = [];
  for (const e of world.driven) if (e.type === 'ship' && e.agent) agents.push(e);
  for (const e of agents) {
    hullTick(state, e, emit);
    if (!world.get(e.id) || !e.agent) continue;
    if (leaves(state, e)) {
      if (!putToSleep(state, e)) world.remove(e);
      emit('agent-left', { id: e.id, name: e.name });
      continue;
    }
    think(state, e, emit);
  }
}

function leaves(state, e) {
  const a = e.agent;
  if (a.contract && a.mode !== 'leave') return false;
  const d = distAU(e.pos, state.flight.pos);
  return (a.ambient && d > DESPAWN_AU) || (a.mode === 'leave' && d > LEAVE_AU);
}

const distAU = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

function think(state, e, emit) {
  const a = e.agent, h = e.combat;
  const now = state.clock.minute;
  if (h.status === 'wreck') return;
  if (h.status === 'surrendered') { a.cmd = null; return; }
  observe(state, e, emit);
  const R = ROLES[a.role] || {};
  if (R.surrenders && profile(state, e.id).maxG <= 0 && h.status !== 'surrendered' && (a.hostile.length || a.mode === 'flee')) {
    if (a.hostile.includes(PLAYER) && !a.request) openRequest(state, e, 'surrender', `"${e.name} to ${state.ship.name} — we're dead in space. We surrender, cease fire!"`, [{ id: 'accept', label: 'ACCEPT SURRENDER' }, { id: 'ignore', label: 'IGNORE' }], emit);
    else if (!a.hostile.includes(PLAYER)) surrender(state, e, emit);
    a.cmd = null;
    return;
  }
  const urgent = a.mode === 'engage' || a.mode === 'flee' || a.hostile.length > 0;
  if (urgent || now >= a.next) {
    decide(state, e, emit);
    a.next = now + (urgent ? 1 : IDLE_THINK);
  }
  steer(state, e, emit);
}

/** Track what we can see of the player (patrols identify ships by watching them). */
function observe(state, e, emit) {
  const a = e.agent;
  if (state.lost) return;
  if (sees(state, e.id, PLAYER)) {
    const was = a.scan.player || 0;
    a.scan.player = was + 1;
    const identified = state.comms.transponder || a.scan.player >= REVEAL.PROFILE;
    if (identified && !a.flags.identified) {
      a.flags.identified = true;
      if (e.faction in state.law.wanted) {
        state.law.lastIdentified ??= {};
        state.law.lastIdentified[e.faction] = state.clock.minute;
      }
      if (!state.comms.transponder) emit('player-identified', { id: e.id, name: e.name, faction: e.faction });
    }
  } else if (a.scan.player) {
    a.scan.player = Math.max(0, a.scan.player - 2);
  }
}

const identified = (state, e) => state.comms.transponder || (e.agent.scan.player || 0) >= REVEAL.PROFILE;

// ---- DECISIONS ----

function decide(state, e, emit) {
  const a = e.agent;
  // Fights first: anyone hostile still in the fight?
  a.hostile = a.hostile.filter(id => id === PLAYER ? !state.lost : !isOutOfFight(getWorld(state).get(id)));
  if (a.hostile.length && a.mode !== 'flee' && a.mode !== 'leave' && ROLES[a.role]?.aim) {
    if (!a.hostile.includes(a.target)) a.target = nearestOf(state, e, a.hostile);
    a.mode = 'engage';
  }
  if (!a.hostile.length && a.mode === 'engage') a.mode = a.role === 'pirate' && lootable(state, a.target) ? 'loot' : defaultMode(a.role);
  BRAINS[a.role]?.(state, e, emit);
}

function nearestOf(state, e, ids) {
  let best = null, bd = Infinity;
  for (const id of ids) {
    const k = kinematics(state, id);
    if (!k) continue;
    const d = distAU(e.pos, k.pos);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

const lootable = (state, id) => {
  if (!id) return false;
  if (id === PLAYER) return profile(state, PLAYER).maxG <= 0;
  const t = getWorld(state).get(id);
  return !!t && (t.combat?.status === 'surrendered' || t.combat?.status === 'disabled');
};

const BRAINS = {
  patrol(state, e, emit) { lawman(state, e, emit, false); },
  picket(state, e, emit) { lawman(state, e, emit, true); },

  pirate(state, e, emit) {
    const a = e.agent;
    const p = profile(state, e.id);
    if (a.mode === 'engage' || a.mode === 'leave' || a.mode === 'flee') return;
    // Lawmen about: slip away
    const law = lawNearby(state, e);
    if (law) { a.mode = 'leave'; a.threat = law.id; return; }
    if (a.mode === 'lurk') {
      // Found by a ship it can't fight, and it is coming: run before it is shot at
      if (!state.lost && huntedBy(state, e, p, PLAYER)) { a.mode = 'leave'; a.threat = PLAYER; emit('agent-retreats', { id: e.id, name: knownName(state, e.id) || 'unidentified contact', seen: true }); return; }
      // (a proxy's raider goes only for its prey's ships, and the captains flying its flag)
      const mayStalk = !a.flags.prey || flagOf(state) === a.flags.prey;
      if (mayStalk && !state.lost && sees(state, e.id, PLAYER) && strength(p) >= PIRATE_NERVE * strength(profile(state, PLAYER))) {
        a.target = PLAYER; a.mode = 'stalk';
      } else {
        const prey = civilianPrey(state, e);
        if (prey) { wake(state, prey, 'civilian'); a.target = prey.id; a.mode = 'stalk'; }
      }
    } else if (a.mode === 'stalk') {
      const k = kinematics(state, a.target);
      if (!k) { a.mode = 'lurk'; a.target = null; return; }
      if (distAU(e.pos, k.pos) <= DEMAND_AU) {
        if (a.target === PLAYER) {
          const want = Math.max(500, Math.round(state.resources.credits.current * 0.3 / 100) * 100);
          a.flags.demand = want;
          a.mode = 'demand';
          openRequest(state, e, 'demand', `"${state.ship.name}, this is the ${e.name}. Cut your drive and transfer ${want.toLocaleString()} MCR. Refuse and we take it off your wreck."`,
            [{ id: 'pay', label: `PAY ${want.toLocaleString()} MCR` }, { id: 'refuse', label: 'REFUSE' }], emit);
        } else {
          const prey = getWorld(state).get(a.target);
          makeHostile(state, e, a.target);
          if (prey?.agent) { makeHostile(state, prey, e.id); prey.sos || getWorld(state).setSos(prey, true); }
        }
      }
    } else if (a.mode === 'loot' && state.clock.minute - a.since > LOOT_MIN) {
      a.mode = 'leave';
      a.threat = null;
    }
  },

  navy(state, e, emit) {
    const a = e.agent;
    if (a.mode !== 'patrol') return;
    // Enemy warships in the zone
    const enemy = enemyWarship(state, e);
    if (enemy) { makeHostile(state, e, enemy.id); return; }
    if (state.lost || !sees(state, e.id, PLAYER)) return;
    const known = identified(state, e);
    // Wanted, flying the enemy's flag, or in one of its own navy's stolen hulls: weapons free
    if (wantedBy(state, e.faction) >= 2 || (known && (enemyOf(state, e.faction) || stolenFrom(state, e.faction)))) { makeHostile(state, e, PLAYER); return; }
    const d = distAU(e.pos, state.flight.pos);
    const flagged = known && hostileTo(state, e.faction);
    // Warned off and coming on anyway
    if (flagged && a.flags.warned === 'complied' && d <= WARN_AU * 0.5) { makeHostile(state, e, PLAYER); return; }
    if (a.zone && (!known || flagged) && d <= WARN_AU && !a.flags.warned) {
      a.flags.warned = 'sent';
      const text = flagged
        ? `"${state.ship.name}, this is ${e.name}. You are flying ${FACTIONS[flagOf(state)].short} colours inside our zone. Stand off now, or you will be fired upon."`
        : `"Unidentified vessel, this is ${e.name}. You are inside an active engagement zone. Turn on your transponder and stand off, or you will be fired upon."`;
      openRequest(state, e, 'warning', text, [{ id: 'comply', label: flagged ? 'STAND OFF' : 'TRANSPONDER ON · STAND OFF' }, { id: 'refuse', label: 'IGNORE' }], emit);
    }
  },

  civilian(state, e, emit) {
    const a = e.agent;
    const threatened = threatTo(state, e);
    if (threatened) { a.mode = 'flee'; a.calmSince = state.clock.minute; a.threat = threatened; defendWithGear(state, e, emit); return; }
    if (a.mode === 'flee' && state.clock.minute - a.calmSince > CALM_MIN) {
      a.mode = 'drift';
      getWorld(state).setSos(e, false);
    }
  },

  convoy(state, e) {
    const a = e.agent;
    if (a.mode !== 'travel' || !a.dest) return;
    const world = getWorld(state);
    const st = world.get(a.dest);
    if (!st) return;
    // At the destination's gate, stopped: it goes in to a berth (where the gate is now: far from us
    // its stored place can be an hour old)
    const at = world.get(travelTarget(state, a.dest).id);
    const sp = predictEntity(at, state.clock.minute, world);
    if (distAU(e.pos, sp.pos) * AU_M < 10_000 && Math.hypot(e.vel.vx - sp.vel.vx, e.vel.vy - sp.vel.vy) < 20) {
      parkAt(state, e, st);
      a.mode = 'arrived';
    }
  },
};

/** Police and pickets: identify, inspect, arrest, and go after pirates. */
function lawman(state, e, emit, stayHome) {
  const a = e.agent;
  const now = state.clock.minute;
  if (a.mode === 'engage' || a.mode === 'leave') return;
  const pirate = visiblePirate(state, e);
  if (pirate) { makeHostile(state, e, pirate.id); return; }
  if (state.lost) return;
  const seen = sees(state, e.id, PLAYER);
  const wanted = wantedBy(state, e.faction);
  const known = seen && identified(state, e);
  if (seen && (wanted >= 3 || (known && enemyOf(state, e.faction)))) { makeHostile(state, e, PLAYER); return; }

  if (a.mode === 'cruise') {
    if (!seen || a.flags.checked) return;
    // (unlicensed military kit, or the flag of a power we are in a crisis with, is worth a look)
    const suspicious = wanted >= 1 || (!state.comms.transponder && (a.scan.player || 0) >= 10) || (known && (!hullLegal(state) || hostileTo(state, e.faction)));
    let policy = a.flags.routine ? 0 : a.zone ? 0.6 : 0.15;
    // Our own side's patrols wave a contractor of some standing through
    if (flagOf(state) === e.faction && rankOf(state) >= RANK_FOR.waveThrough) policy = 0;
    if (suspicious || identified(state, e)) {
      // (not outside its jurisdiction, nor a ship whose course takes it out before the cutter is alongside:
      // looked at again when we are somewhere it could stop us)
      if (stopBarred(state, e, true) || !canStop(state, e)) return;
      a.flags.checked = true;
      if (suspicious || chance(policy)) { a.mode = 'intercept'; a.target = PLAYER; a.since = now; }
      else if (a.flags.beat !== undefined) { a.home = a.flags.beat; delete a.flags.beat; }    // sent to look at us: seen, back to its beat
    }
  } else if (a.mode === 'intercept') {
    // Out of its reach, or a stop it can't make now: none to make here
    if (stopBarred(state, e, false) || !canStop(state, e)) { giveUpStop(state, e, stayHome, emit); return; }
    if (!a.request && distAU(e.pos, state.flight.pos) <= HAIL_AU) {
      const who = FACTIONS[e.faction]?.police || e.faction;
      openRequest(state, e, 'inspect', `"${state.ship.name}, this is ${who} vessel ${e.name}. Cut your drive and stand by to be boarded for inspection."`,
        [{ id: 'comply', label: 'HEAVE TO' }, { id: 'refuse', label: 'RUN' }], emit);
    }
    if (stayHome && a.home && now - a.since > 2 * DAY_MIN) a.mode = 'cruise';
  } else if (a.mode === 'search-approach') {
    const k = kinematics(state, PLAYER);
    const dM = distAU(e.pos, k.pos) * AU_M;
    if (dM < 10_000 && Math.hypot(e.vel.vx - k.vel.vx, e.vel.vy - k.vel.vy) < 20) { a.mode = 'search'; a.since = now; emit('inspection-started', { id: e.id, name: e.name }); }
    else if (state.flight.thrustG > 0.1 || state.autopilot?.phase === 'active') refuseArrest(state, e, emit);
  } else if (a.mode === 'search') {
    const dM = distAU(e.pos, state.flight.pos) * AU_M;
    if (dM > 50_000 || state.flight.thrustG > 0.1) { refuseArrest(state, e, emit); return; }
    if (now - a.since >= SEARCH_MIN) {
      const r = settleInspection(state, e.faction);
      emit('inspection-complete', { id: e.id, name: e.name, faction: e.faction, ...r });
      a.mode = stayHome ? 'cruise' : 'leave';
      a.target = null;
    }
  }
}

const STOP_SAMPLES = [0.25, 0.5, 0.75, 1];
const STOP_HORIZON_S = 2 * 86400;       // a cutter that could only be alongside in days has no stop to make

/**
 * Could patrol `e` stop us inside its jurisdiction? We must be in it now,
 * and our course as we fly it (velocity and burn) must keep us in it until
 * the cutter could be alongside: its time to kill the speed between us and
 * cross the gap at its approach G, re-aimed at where we will be.
 */
function canStop(state, e) {
  const now = state.clock.minute, a = e.agent, f = state.flight;
  if (!inJurisdiction(state, e.faction, a.zone, f.pos, now)) return false;
  const k = kinematics(state, PLAYER);
  const acc = Math.min(ROLES[a.role]?.approachG || 1, profile(state, e.id).maxG || 1) * G0;
  let T = 0;
  for (let i = 0; i < 5 && T < STOP_HORIZON_S; i++) {
    const rx = (k.pos.x - e.pos.x) * AU_M + (k.vel.vx - e.vel.vx) * T + 0.5 * k.ax * T * T;
    const ry = (k.pos.y - e.pos.y) * AU_M + (k.vel.vy - e.vel.vy) * T + 0.5 * k.ay * T * T;
    const w = Math.hypot(k.vel.vx - e.vel.vx + k.ax * T, k.vel.vy - e.vel.vy + k.ay * T);
    T = w / acc + 2 * Math.sqrt(Math.hypot(rx, ry) / acc);
  }
  if (T >= STOP_HORIZON_S) return false;
  for (const s of STOP_SAMPLES) {
    const t = T * s;
    const p = { x: k.pos.x + (k.vel.vx * t + 0.5 * k.ax * t * t) / AU_M, y: k.pos.y + (k.vel.vy * t + 0.5 * k.ay * t * t) / AU_M };
    if (!inJurisdiction(state, e.faction, a.zone, p, now + t / MIN_S)) return false;
  }
  return true;
}

const STOPPING = new Set(['search-approach', 'search']);

/**
 * Is a stop on us out of the question now, whoever's cutter it is? One at a
 * time: no order to heave to while another is open or another cutter is
 * coming alongside or searching us (`deciding`: nor while one is already on
 * its way to us). Never in port (on a station's approach, in a berth, the
 * docking computer flying us), never mid-fight (a cutter comes to help with
 * that), and not by a power whose inspectors stamped our papers lately. Nor
 * ever by a power's own security, of a navy hull of its flown under its banner.
 */
function stopBarred(state, e, deciding) {
  // (a licensed captain in one of its own navy's hulls, under its banner: its own security has no business with it, short of a warrant)
  if (flagOf(state) === e.faction && wantedBy(state, e.faction) < 2) return true;
  const z = state.tc?.zone, d = state.dock;
  if (z === 'approach' || z === 'keepout' || (d && d.phase !== 'inbound' && d.phase !== 'awaiting')) return true;
  if (state.comms.requests.some(r => r.kind === 'inspect' && r.from !== e.id)) return true;
  for (const o of getWorld(state).driven) {
    if (o === e || !o.agent || o.agent.target !== PLAYER) continue;
    if (STOPPING.has(o.agent.mode) || (deciding && o.agent.mode === 'intercept')) return true;
  }
  if (hostilesOfPlayer(state).some(h => h.agent.mode === 'engage')) return true;
  return recentlyInspected(state, e.faction);
}

/** A stop it can't make: back to its beat (or on its way), and any order to heave to withdrawn. */
function giveUpStop(state, e, stayHome, emit) {
  const a = e.agent;
  a.mode = stayHome ? 'cruise' : 'leave';
  a.target = null;
  a.threat = null;
  const i = a.request ? state.comms.requests.findIndex(r => r.id === a.request) : -1;
  if (i >= 0) {
    const r = state.comms.requests.splice(i, 1)[0];
    a.request = null;
    emit('comm-request-withdrawn', { request: r, text: `"${state.ship.name}, ${e.name}. You're clear of our jurisdiction. Order withdrawn."` });
  }
}

function visiblePirate(state, e) {
  for (const o of getWorld(state).driven) {
    if (o === e || o.type !== 'ship' || isOutOfFight(o)) continue;
    if (o.faction !== 'pirate' && !o.tags.wanted) continue;
    if (distAU(o.pos, e.pos) < 0.01 && sees(state, e.id, o.id)) return o;
  }
  return null;
}

function lawNearby(state, e) {
  for (const o of getWorld(state).driven) {
    if (o.type !== 'ship' || !o.agent || isOutOfFight(o)) continue;
    if (!['patrol', 'picket', 'navy'].includes(o.agent.role)) continue;
    if (distAU(o.pos, e.pos) < 0.005 && sees(state, e.id, o.id)) return o;
  }
  return null;
}

/**
 * Is `e` found by a ship it can't fight that is coming for it? Each holds
 * the other (so `e` lies inside that ship's reach on it), the hunter is
 * stronger than `e` dares take on, and the range is closing.
 */
function huntedBy(state, e, p, id) {
  if (!sees(state, e.id, id) || !sees(state, id, e.id)) return false;
  if (strength(p) >= PIRATE_NERVE * strength(profile(state, id))) return false;
  const k = kinematics(state, id);
  const dx = e.pos.x - k.pos.x, dy = e.pos.y - k.pos.y;
  return (k.vel.vx - e.vel.vx) * dx + (k.vel.vy - e.vel.vy) * dy > 0;
}

/** An enemy power's warship or patrol it can see (never a civilian: they are not targets in a war). */
function enemyWarship(state, e) {
  const enemies = e.agent.enemies || [];
  if (!enemies.length) return null;
  for (const o of getWorld(state).driven) {
    if (o === e || o.type !== 'ship' || !o.agent || isOutOfFight(o) || !enemies.includes(o.faction)) continue;
    if (!['navy', 'patrol', 'picket'].includes(o.agent.role)) continue;
    if (sees(state, e.id, o.id)) return o;
  }
  return null;
}

/** Traffic within reach that a pirate could jump (only ever near the player). */
function civilianPrey(state, e) {
  if (!chance(0.1)) return null;
  const world = getWorld(state);
  const near = world.query(e.pos, 0.01);
  const prey = e.agent.flags.prey;
  const pool = near.filter(o => o.type === 'ship' && o.tags.traffic && !o.agent && CLASSES[o.cls]?.category === 'civilian' && (!prey || o.faction === prey));
  return pool.length ? pool[randInt(0, pool.length - 1)] : null;
}

/**
 * A miner run down by an attacker: turn the mining gear on the closest
 * hostile inside its reach. It is all a civilian crew has, and it only
 * works on a ship that comes in close — to strafe, or to loot.
 */
function defendWithGear(state, e, emit) {
  const g = profile(state, e.id).gear;
  if (!g) return;
  let best = null, bestD = Infinity;
  for (const id of e.agent.hostile) {
    const k = kinematics(state, id);
    if (!k || (k.e && isOutOfFight(k.e))) continue;
    const d = distAU(e.pos, k.pos) * AU_M;
    if (d < bestD) { bestD = d; best = id; }
  }
  if (best && bestD <= g.rangeM) fireGear(state, e.id, best, 'disable', emit);
}

/** Ordnance coming for `e` that its sensors hold (a cold-coasting torpedo is invisible until late). */
function seenInbound(state, e) {
  const q = sensorQuality(state, e.id);
  return inboundTo(state, e.id).filter(o => canSee(Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y), signatureRange(o), q));
}

/**
 * What a civilian is running from, or null: a hostile ship, or ordnance it
 * can see arriving within the next couple of hours. (A torpedo days out is
 * no reason to burn for days — no hauler carries the reaction mass.)
 */
function threatTo(state, e) {
  const inbound = seenInbound(state, e).filter(o => timeToGo(state, o) < PANIC_S);
  if (inbound.length) return inbound[0].ord.owner;
  for (const o of getWorld(state).driven) if (o.agent?.hostile.includes(e.id) && !isOutOfFight(o)) return o.id;
  // We fired on it, and we are still close
  if (e.agent.hostile.includes(PLAYER) && !state.lost && distAU(e.pos, state.flight.pos) < PLAYER_THREAT_AU) return PLAYER;
  return null;
}

// ---- STEERING & WEAPONS ----

function steer(state, e, emit) {
  const a = e.agent;
  const R = ROLES[a.role] || {};
  const p = profile(state, e.id);
  const playerSpec = { kind: 'player' };
  const spec = (id) => id === PLAYER ? playerSpec : { kind: 'entity', id };
  a.evade = false;
  switch (a.mode) {
    case 'engage': fight(state, e, emit); return;
    case 'flee': case 'leave': {
      // running from someone; or, its business here done, away from us at its cruise
      const from = a.mode === 'flee' ? a.threat || a.target : a.threat;
      a.evade = a.mode === 'flee' && !!CLASSES[e.cls]?.evasive;
      if (from && kinematics(state, from)) run(state, e, from, p, emit);
      else fleeFrom(e, state.flight.pos, Math.min(p.maxG, CLASSES[e.cls]?.drive.cruiseG || 1));
      return;
    }
    case 'stalk': case 'demand': goTo(state, e, spec(a.target), a.mode === 'demand' ? 50_000_000 : 40_000_000, R.approachG, true); break;
    case 'intercept': goTo(state, e, playerSpec, 20_000_000, R.approachG, true); break;
    case 'search-approach': case 'search': goTo(state, e, playerSpec, 2_000, 1); break;
    case 'loot': if (a.target) goTo(state, e, spec(a.target), 2_000, 1); else a.cmd = null; break;
    case 'travel': if (a.dest) goTo(state, e, travelTarget(state, a.dest), 3_000, a.travelG || CLASSES[e.cls]?.drive.cruiseG || 0.3); break;
    case 'cruise': case 'patrol':
      if (a.home) goTo(state, e, a.home, 30_000_000, 1); else a.cmd = null;
      break;
    default: a.cmd = null;
  }
  // A torpedo outlives the ship that fired it: warships stay on guard until
  // the last one is accounted for
  if (a.role === 'navy' || a.role === 'patrol' || a.role === 'picket') guardAgainst(state, e, seenInbound(state, e), p, R);
}

/**
 * Point defense is automatic; what the crew adds is jinking when ordnance is
 * close and, by naval doctrine (TECH.counterBurn), turning away from inbound
 * torpedoes so they arrive slowly, long under the PDCs, and must burn to catch
 * up. A ship that keeps charging meets them at a hundred km/s, inside its
 * point defense for half a second. Jury-rigged ships hold course and jink.
 */
function guardAgainst(state, e, inbound, p, R) {
  if (!inbound.length) return;
  if (inbound.some(o => timeToGo(state, o) < 20 * MIN_S)) e.agent.evade = true;
  if (TECH[p.tl].counterBurn && p.maxG > 0) {
    const torp = inbound.filter(o => o.ord.kind === 'torpedo' && timeToGo(state, o) < COUNTER_BURN_S)
      .sort((x, y) => timeToGo(state, x) - timeToGo(state, y))[0];
    if (torp) fleeFrom(e, torp.pos, Math.min(R.approachG || 1, p.maxG));
  }
}

/**
 * Fly to a target with the shared closing law, closing no faster than
 * `cruise` (m/s) when given. Against an enemy (`hostile`)
 * its thrust is left out of the guidance: that thrust is a reaction to us, and
 * two ships each matching the other's burn end up flying side by side. So we
 * close on where it is and how it moves, re-measured every minute.
 */
function goTo(state, e, target, standoff, accelG, hostile = false, cruise = null) {
  const a = e.agent;
  const now = state.clock.minute;
  const key = `${target.kind}:${target.id ?? ''}:${standoff}:${accelG}:${cruise}`;
  if (a.planKey !== key) { a.plan = createPlan('closing', target, { accelG, standoff, cruise }); a.planKey = key; }
  const tgt = targetStateAt(state, target, now, true);
  if (!tgt) { a.cmd = null; return; }
  const f = { pos: e.pos, vel: e.vel, facing: e.nav.facing, turning: e.nav.turning };
  const g = guidanceStep(a.plan, f, now, hostile ? { pos: tgt.pos, vel: tgt.vel } : tgt, null);
  // (against an enemy the drive fires only once the nose is on the vector:
  // a fighting ship's commands jump about as it dodges and counter-burns)
  if (hostile && !g.arrived) g.cmd.lean = false;
  a.cmd = g.arrived ? holdWith(tgt) : g.cmd;
  // (where it is flying, for its terrain guard: a target over a rock is come down to, not climbed away from)
  a.$toward = g.arrived ? null : g.toward;
}

/** Where a ship bound for a station flies to: its approach gate (inside it, a berth is docking's business), or the station. */
function travelTarget(state, id) {
  const gate = getWorld(state).get(gateId(id));
  return { kind: 'entity', id: gate ? gate.id : id };
}

/** Arrived: match the target's own thrust so we stay with it. */
function holdWith(tgt) {
  const ax = tgt.ax || 0, ay = tgt.ay || 0;
  return Math.hypot(ax, ay) > 1e-4 ? { ax, ay, maxG: Math.hypot(ax, ay) / G0 } : null;
}

/**
 * Breaking contact with `fromId`, as a captain with people aboard would
 * (the header has the doctrine). Out past the pursuer's reach on our cold
 * hull, a ship running silent coasts dark; found, it burns away, at the
 * drive's best while the sprint lasts (SPRINT_LOSS of the crew to strokes),
 * then at SUSTAIN_G; caught all the same, it is cornered.
 */
function run(state, e, fromId, p, emit) {
  const a = e.agent;
  const k = kinematics(state, fromId);
  if (p.maxG <= 0) { a.cmd = null; return; }
  const dx = e.pos.x - k.pos.x, dy = e.pos.y - k.pos.y;
  const d = Math.hypot(dx, dy) || 1e-12;
  // Torpedoes it has seen coming are still coming once their plumes go out:
  // until they are due it keeps burning, so they spend their Δv running it down
  const now = state.clock.minute;
  const seen = seenInbound(state, e);
  if (seen.length) a.waryUntil = Math.max(a.waryUntil || 0, now + Math.min(...seen.map(o => timeToGo(state, o))) / MIN_S + 10);
  // (dark already, it stays dark while unseen; burning, it goes cold with a margin, or it would flicker)
  const reach = hullSignature(e) * sensorQuality(state, fromId);
  if (!e.transponder && !e.sos && !(now < (a.waryUntil || 0)) && d > reach * (a.dark ? 1 : DARK_MARGIN)) {
    if (!a.dark) { a.dark = true; emit('agent-runs-dark', { id: e.id, name: knownName(state, e.id), seen: !!state.sensors.$seen?.has(e.id) }); }
    a.cmd = null; a.$toward = null;
    return;
  }
  a.dark = false;
  const sprint = (a.strain || 0) < SPRINT_LOSS;
  const g = sprint ? p.maxG : Math.min(p.maxG, SUSTAIN_G);
  if (!sprint && p.maxG > SUSTAIN_G && !a.flags.eased) {
    a.flags.eased = true;
    emit('agent-eases', { id: e.id, name: knownName(state, e.id), g, seen: !!state.sensors.$seen?.has(e.id) });
  }
  if (!sprint && caughtWithin(e, k, d * AU_M, g) < CORNERED_S && cornered(state, e, fromId, emit)) return;
  fleeFrom(e, k.pos, g);
}

/**
 * Seconds until a pursuer `k` is on `e` (Infinity if never) with `e` burning
 * away from it at `g`: the closing speed now, and the pursuer's own burn
 * toward it against ours.
 */
function caughtWithin(e, k, dM, g) {
  const ux = (e.pos.x - k.pos.x) * AU_M / dM, uy = (e.pos.y - k.pos.y) * AU_M / dM;
  const vc = (k.vel.vx - e.vel.vx) * ux + (k.vel.vy - e.vel.vy) * uy;
  const aRel = Math.max(0, k.ax * ux + k.ay * uy) - g * G0;
  if (Math.abs(aRel) < 1e-6) return vc > 0 ? dM / vc : Infinity;
  const disc = vc * vc + 2 * aRel * dM;
  if (disc < 0) return Infinity;                       // it brakes the gap open before it closes
  const t = (-vc + Math.sqrt(disc)) / aRel;
  const t2 = (-vc - Math.sqrt(disc)) / aRel;
  const best = [t, t2].filter(x => x > 0);
  return best.length ? Math.min(...best) : Infinity;
}

/**
 * Run down with nowhere to go. A crew that ever strikes, strikes: to another
 * ship at once, to us with an offer (ACCEPT, or let it fight). One that
 * doesn't, turns and fights it out. True when it has stopped running.
 */
function cornered(state, e, fromId, emit) {
  const a = e.agent;
  const R = ROLES[a.role] || {};
  if (R.surrenders && a.flags.cornered !== 'fight') {
    if (fromId !== PLAYER) { surrender(state, e, emit); return true; }
    if (!a.flags.cornered && !a.request) {
      a.flags.cornered = 'offered';
      openRequest(state, e, 'surrender', `"${knownName(state, e.id) || e.name} to ${state.ship.name}: you've run us down. We strike — hold your fire!"`,
        [{ id: 'accept', label: 'ACCEPT SURRENDER' }, { id: 'ignore', label: 'IGNORE' }], emit);
    }
    return false;                                       // (it keeps running while the offer stands)
  }
  if (!R.aim) return false;
  a.flags.cornered = 'fight';
  if (!a.hostile.includes(fromId)) a.hostile.push(fromId);
  a.target = fromId;
  a.mode = 'engage';
  return true;
}

function fleeFrom(e, from, maxG) {
  const dx = e.pos.x - from.x, dy = e.pos.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const acc = maxG * G0;
  e.agent.cmd = acc > 0 ? { ax: dx / d * acc, ay: dy / d * acc, maxG } : null;
  e.agent.$toward = null;
}

/** One minute of a fight: distance, evasion, retreat, and every weapon that bears. */
function fight(state, e, emit) {
  const a = e.agent, h = e.combat;
  const R = ROLES[a.role] || ROLES.patrol;
  const tid = a.target;
  const tk = kinematics(state, tid);
  if (!tk || (tk.e && isOutOfFight(tk.e))) { a.hostile = a.hostile.filter(x => x !== tid); a.target = null; a.cmd = null; return; }
  const p = profile(state, e.id), tp = profile(state, tid);
  const dAU = distAU(e.pos, tk.pos), dM = dAU * AU_M;
  const now = state.clock.minute;

  // Break off: badly hurt, or hopelessly outgunned (cornered, it has already tried)
  if (p.maxG > 0 && a.flags.cornered !== 'fight' && (h.hp / h.hpMax < R.retreatHp || strength(p) < R.breakOff * strength(tp))) {
    a.mode = a.role === 'navy' ? 'flee' : 'leave';
    a.threat = tid;
    emit('agent-retreats', { id: e.id, name: knownName(state, e.id) || 'unidentified contact', seen: !!state.sensors.$seen?.has(e.id) });
    return;
  }

  // Jink when ordnance is coming or the enemy is close
  const inbound = seenInbound(state, e);
  a.evade = inbound.some(o => timeToGo(state, o) < 20 * MIN_S) || dM < 50_000_000;

  // Distance: stand off for torpedoes; close in to finish a crippled or toothless target with PDCs
  const crippled = tp.maxG <= 0 || tp.pdc.mounts < 0.5 || tp.pdc.ammo <= 0;
  const close = R.closeIn && crippled && p.pdc.mounts > 0;
  const spec = tid === PLAYER ? { kind: 'player' } : { kind: 'entity', id: tid };
  // Every m/s of closing speed is a m/s on the enemy's torpedoes and less time
  // under our PDCs: a naval crew under fire closes slowly
  const underFire = TECH[p.tl].counterBurn && inbound.some(o => o.ord.kind === 'torpedo');
  goTo(state, e, spec, close ? Math.min(3_000, p.pdc.strafeM * 0.5) : R.standoffM, Math.min(R.approachG, p.maxG || 1), true,
    underFire ? UNDER_FIRE_CLOSE_MS : null);

  guardAgainst(state, e, inbound, p, R);

  // A pirate that has crippled us wants paying, not a wreck: one last chance
  if (a.role === 'pirate' && tid === PLAYER && tp.maxG <= 0 && !a.flags.lastDemand && !a.request) {
    a.flags.lastDemand = true;
    a.flags.demand = Math.max(500, Math.round(state.resources.credits.current * 0.6 / 100) * 100);
    openRequest(state, e, 'demand', `"You're dead in space, ${state.ship.name}. Transfer ${a.flags.demand.toLocaleString()} MCR and we leave you breathing."`,
      [{ id: 'pay', label: `PAY ${a.flags.demand.toLocaleString()} MCR` }, { id: 'refuse', label: 'REFUSE' }], emit);
  }

  if (!sees(state, e.id, tid)) return;
  let fired = false;

  // Torpedoes: keep a salvo big enough to saturate their point defense in the air.
  // Ships out to disable stop launching once the target is crippled (guns finish the job).
  const holdTorps = R.aim === 'disable' && tp.maxG <= 0;
  if (p.tubes > 0 && p.torps > 0 && dAU <= R.launchAU && !holdTorps) {
    const inFlight = launchedBy(state, e.id).filter(o => o.ord.kind === 'torpedo' && o.ord.target === tid).length;
    const salvo = Math.max(1, Math.min(p.tubes, Math.ceil(tp.pdc.mounts * tp.pdc.lambda * tp.pdc.factor * 2) + 1));
    const prof = dAU > 0.002 ? 'cold' : 'fast';
    let reach = null;                                    // (asked once, when a tube is ready: a ship running hard from far out isn't worth a torpedo)
    for (let i = 0; i < h.tubes.length && inFlight + (fired ? 1 : 0) < salvo; i++) {
      if (h.tubes[i] > now) continue;
      const warhead = pickWarhead(R, h, tp);
      if (!warhead) break;
      reach ??= !!torpedoForecast(state, e.id, tid, prof)?.reach;
      if (!reach) break;
      if (!launchTorpedo(state, e.id, tid, { warhead, profile: prof, aim: R.aim }, emit)) break;
      h.magazine[warhead]--;
      h.tubes[i] = now + TORPEDO_RELOAD_MIN;
      fired = true;
    }
  }
  // Railguns
  if (p.railMounts > 0 && dM <= RAIL_RANGE_M) {
    for (let i = 0; i < h.rail.length; i++) {
      if (h.rail[i] > now) continue;
      if (fireRailgun(state, e.id, tid, R.aim, emit)) { h.rail[i] = now + RAIL_RELOAD_MIN; fired = true; }
    }
  }
  // Point-defense guns, if they reach
  if (dM <= p.pdc.strafeM && strafe(state, e.id, tid, R.aim, emit) > 0) fired = true;

  if (fired && tid === PLAYER && !a.aggressor) {
    a.aggressor = true;
    emit('under-attack', { id: e.id, name: e.name });
  }
}

function pickWarhead(R, h, tp) {
  const big = tp.cls && (tp.cls.category === 'military' || tp.cls.category === 'authority');
  if (R.nukes && big && h.magazine.nuke > 0) return 'nuke';
  if (h.magazine.he > 0) return 'he';
  if (R.nukes && h.magazine.nuke > 0) return 'nuke';
  return null;
}

/** Is this agent still fighting fit (for UI and contracts)? */
export const isDisabledShip = (e) => !!e?.combat && (e.combat.drive < DISABLED_BELOW || e.combat.status !== 'ok');
