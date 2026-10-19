// ============================================================
// LONGHAUL — NPC ships with someone at the helm
//
// Most of the world's ships are traffic on rails. A ship becomes an
// *agent* when it has a reason to act near us: a patrol on its beat,
// a pirate lying in wait, a warship in a contested zone, a hauler
// fleeing an attack, a convoy we are escorting. Agents are driven
// world entities: every minute they decide (this module) and fly
// (moveAgents) with the same flight model and guidance laws as our
// own ship — slew limits, drive limits, the closing law.
//
// Roles and their modes:
//   patrol/picket  cruise → intercept → (inspection) search → cruise
//                  … or engage criminals and anyone resisting arrest
//   pirate         lurk → stalk → demand → engage → loot → leave
//   navy           patrol → engage enemy warships; warn off strangers
//   civilian       flee from whoever is shooting, then drift
//   convoy         travel to a destination (escort contracts)
//
// Talking to us goes through *requests* (state.comms.requests): an
// order to heave to, a pirate's ultimatum, a warning, an offer of
// surrender. Each has options and a deadline; silence is an answer.
//
// Agents are few and bounded (the encounter director and contracts
// spawn them; they leave when their business is done or we are far
// away), so per-minute work here never scales with the world.
// ============================================================

import { AU_M, G0, MIN_S, DAY_MIN } from '../core/constants.js';
import { randInt, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES } from './ship-classes.js';
import { FACTIONS } from './factions.js';
import { flightStep, SLEW_RATE } from './flight.js';
import { createPlan, guidanceStep, targetStateAt } from './nav.js';
import { abortRoute } from './autopilot.js';
import { REVEAL, canSee, signatureRange } from './sensors.js';
import {
  PLAYER, kinematics, profile, snapshot, sees, strength, ensureHull, isOutOfFight, sensorQuality, DISABLED_BELOW,
} from './combatants.js';
import { launchTorpedo, fireRailgun, strafe, inboundTo, launchedBy, timeToGo } from './ordnance.js';
import { hullTick } from './damage.js';
import { wantedBy, settleInspection, adjustStanding } from './law.js';
import { TORPEDO_RELOAD_MIN, RAIL_RELOAD_MIN, RAIL_RANGE_M } from './weapons.js';

/**
 * How each role fights. launchAU: torpedo launch range · standoffM: distance
 * held in a fight (m) — outside the enemy's guns; ships that `closeIn` come
 * to PDC range only to finish a crippled or toothless target.
 */
export const ROLES = {
  patrol: { aim: 'disable', launchAU: 0.003, standoffM: 50_000_000, closeIn: true, retreatHp: 0.3, surrenders: true, nukes: false, approachG: 3 },     // 50,000 km
  picket: { aim: 'disable', launchAU: 0.003, standoffM: 50_000_000, closeIn: true, retreatHp: 0.3, surrenders: true, nukes: false, approachG: 3 },
  pirate: { aim: 'disable', launchAU: 0.004, standoffM: 100_000_000, closeIn: true, retreatHp: 0.5, surrenders: true, nukes: false, approachG: 3 },    // 100,000 km
  navy: { aim: 'kill', launchAU: 0.02, standoffM: 20_000_000, closeIn: false, retreatHp: 0.25, surrenders: false, nukes: true, approachG: 4 },        // 20,000 km: railgun range
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

// ---- SPAWNING ----

/**
 * Put a new agent into the world.
 * opts: { role, cls?, category?, faction?, near?, pos, vel, mode?, home?, zone?, contract?,
 *         ambient?, hostile?: [ids], transponder?, tags?, name? }
 */
export function spawnAgent(state, opts) {
  const world = getWorld(state);
  const id = rollIdentity({ cls: opts.cls, category: opts.category, faction: opts.faction, near: opts.near });
  const role = opts.role;
  const e = createEntity({
    id: world.newId(role), name: opts.name || id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl,
    shipClass: id.shipClass, mass: id.mass, pos: opts.pos, vel: opts.vel, driven: true,
    transponder: opts.transponder ?? (role !== 'pirate'), t: state.clock.minute, tags: { ...(opts.tags || {}) },
  });
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
    dest: opts.dest || null, enemies: opts.enemies || [], scan: {}, flags: {}, request: null, calmSince: state.clock.minute,
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
  if (e.tags.traffic) { e.tags.traffic = false; if (state.traffic) state.traffic.spawned = Math.max(0, state.traffic.spawned - 1); }
  world.setDriven(e, true);
  e.t = state.clock.minute;
  if (!e.cls) e.cls = 'freighter';
  makeAgent(state, e, role, { ambient: true, ...opts });
  return e;
}

/** Put an agent back on rails beside a station (convoy arrived, patrol home). */
export function parkAt(state, e, station) {
  const world = getWorld(state);
  world.setDriven(e, false);
  const o = station.orbit;
  e.orbit = { body: o.body, r: o.r * 1.01, phase: o.phase + 0.001, period: o.period };
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
export function moveAgents(state) {
  const world = getWorld(state);
  const now = state.clock.minute;
  for (const e of world.driven) {
    if (e.type !== 'ship' || !e.agent) continue;
    e.$prev = snapshot(e.pos, e.vel);
    const p = profile(state, e.id);
    const f = { pos: e.pos, vel: e.vel, facing: e.nav.facing, maxG: p.maxG, $slew: SLEW_RATE, thrustG: 0, rcsG: 0, turning: 0 };
    flightStep(f, p.maxG > 0 ? e.agent.cmd : null, 1);
    e.nav.facing = f.facing;
    e.nav.turning = f.turning;
    e.thrust = f.thrustG;
    e.heading = f.facing;
    e.t = now;
    world.hash.update(e);
  }
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
    if (leaves(state, e)) { world.remove(e); emit('agent-left', { id: e.id, name: e.name }); continue; }
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
    if (lawNearby(state, e)) { a.mode = 'leave'; return; }
    if (a.mode === 'lurk') {
      if (!state.lost && sees(state, e.id, PLAYER) && strength(p) >= 0.7 * strength(profile(state, PLAYER))) {
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
    }
  },

  navy(state, e, emit) {
    const a = e.agent;
    if (a.mode !== 'patrol') return;
    // Enemy warships in the zone
    const enemy = enemyWarship(state, e);
    if (enemy) { makeHostile(state, e, enemy.id); return; }
    if (state.lost || !sees(state, e.id, PLAYER)) return;
    if (wantedBy(state, e.faction) >= 2) { makeHostile(state, e, PLAYER); return; }
    const d = distAU(e.pos, state.flight.pos);
    if (a.zone && !identified(state, e) && d <= WARN_AU && !a.flags.warned) {
      a.flags.warned = 'sent';
      openRequest(state, e, 'warning', `"Unidentified vessel, this is ${e.name}. You are inside an active engagement zone. Turn on your transponder and stand off, or you will be fired upon."`,
        [{ id: 'comply', label: 'TRANSPONDER ON · STAND OFF' }, { id: 'refuse', label: 'IGNORE' }], emit);
    }
  },

  civilian(state, e) {
    const a = e.agent;
    const threatened = threatTo(state, e);
    if (threatened) { a.mode = 'flee'; a.calmSince = state.clock.minute; a.threat = threatened; return; }
    if (a.mode === 'flee' && state.clock.minute - a.calmSince > CALM_MIN) {
      a.mode = 'drift';
      getWorld(state).setSos(e, false);
    }
  },

  convoy(state, e) {
    const a = e.agent;
    if (a.mode !== 'travel' || !a.dest) return;
    const st = getWorld(state).get(a.dest);
    if (!st) return;
    if (distAU(e.pos, st.pos) * AU_M < 10_000 && Math.hypot(e.vel.vx - st.vel.vx, e.vel.vy - st.vel.vy) < 20) {
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
  if (seen && wanted >= 3) { makeHostile(state, e, PLAYER); return; }

  if (a.mode === 'cruise') {
    if (!seen || a.flags.checked) return;
    const suspicious = wanted >= 1 || (!state.comms.transponder && (a.scan.player || 0) >= 10);
    const policy = a.zone ? 0.6 : 0.15;
    if (suspicious || identified(state, e)) {
      a.flags.checked = true;
      if (suspicious || chance(policy)) { a.mode = 'intercept'; a.target = PLAYER; a.since = now; }
    }
  } else if (a.mode === 'intercept') {
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
    if (distAU(o.pos, e.pos) < 0.005 && sees(state, e.id, o.id)) return true;
  }
  return false;
}

function enemyWarship(state, e) {
  const enemies = e.agent.enemies || [];
  if (!enemies.length) return null;
  for (const o of getWorld(state).driven) {
    if (o === e || o.type !== 'ship' || !o.agent || isOutOfFight(o) || !enemies.includes(o.faction)) continue;
    if (o.agent.role !== 'navy') continue;
    if (sees(state, e.id, o.id)) return o;
  }
  return null;
}

/** Traffic within reach that a pirate could jump (only ever near the player). */
function civilianPrey(state, e) {
  if (!chance(0.1)) return null;
  const world = getWorld(state);
  const near = world.query(e.pos, 0.01);
  const pool = near.filter(o => o.type === 'ship' && o.tags.traffic && !o.agent && CLASSES[o.cls]?.category === 'civilian');
  return pool.length ? pool[randInt(0, pool.length - 1)] : null;
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
      const from = a.mode === 'flee' ? kinematics(state, a.threat || a.target) : kinematics(state, PLAYER);
      a.evade = a.mode === 'flee' && !!CLASSES[e.cls]?.evasive;
      fleeFrom(e, from?.pos || state.flight.pos, p.maxG);
      return;
    }
    case 'stalk': case 'demand': goTo(state, e, spec(a.target), a.mode === 'demand' ? 50_000_000 : 40_000_000, R.approachG); return;
    case 'intercept': goTo(state, e, playerSpec, 20_000_000, R.approachG); return;
    case 'search-approach': case 'search': goTo(state, e, playerSpec, 2_000, 1); return;
    case 'loot': if (a.target) goTo(state, e, spec(a.target), 2_000, 1); else a.cmd = null; return;
    case 'travel': if (a.dest) goTo(state, e, { kind: 'entity', id: a.dest }, 3_000, CLASSES[e.cls]?.drive.cruiseG || 0.3); return;
    case 'cruise': case 'patrol':
      if (a.home) goTo(state, e, a.home, 30_000_000, 1); else a.cmd = null;
      return;
    default: a.cmd = null;
  }
}

function goTo(state, e, target, standoff, accelG) {
  const a = e.agent;
  const now = state.clock.minute;
  const key = `${target.kind}:${target.id ?? ''}:${standoff}:${accelG}`;
  if (a.planKey !== key) { a.plan = createPlan('closing', target, { accelG, standoff }); a.planKey = key; }
  const tgt = targetStateAt(state, target, now, true);
  if (!tgt) { a.cmd = null; return; }
  const f = { pos: e.pos, vel: e.vel, facing: e.nav.facing, turning: e.nav.turning };
  const g = guidanceStep(a.plan, f, now, tgt, null);
  a.cmd = g.arrived ? holdWith(tgt) : g.cmd;
}

/** Arrived: match the target's own thrust so we stay with it. */
function holdWith(tgt) {
  const ax = tgt.ax || 0, ay = tgt.ay || 0;
  return Math.hypot(ax, ay) > 1e-4 ? { ax, ay, maxG: Math.hypot(ax, ay) / G0 } : null;
}

function fleeFrom(e, from, maxG) {
  const dx = e.pos.x - from.x, dy = e.pos.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const acc = maxG * G0;
  e.agent.cmd = acc > 0 ? { ax: dx / d * acc, ay: dy / d * acc, maxG } : null;
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

  // Break off: badly hurt, or hopelessly outgunned
  if (p.maxG > 0 && (h.hp / h.hpMax < R.retreatHp || strength(p) < 0.35 * strength(tp))) {
    a.mode = a.role === 'navy' ? 'flee' : 'leave';
    a.threat = tid;
    emit('agent-retreats', { id: e.id, name: e.name });
    return;
  }

  // Jink when ordnance is coming or the enemy is close
  a.evade = seenInbound(state, e).some(o => timeToGo(state, o) < 20 * MIN_S) || dM < 50_000_000;

  // Distance: stand off for torpedoes; close in to finish a crippled or toothless target with PDCs
  const crippled = tp.maxG <= 0 || tp.pdc.mounts < 0.5 || tp.pdc.ammo <= 0;
  const close = R.closeIn && crippled && p.pdc.mounts > 0;
  const spec = tid === PLAYER ? { kind: 'player' } : { kind: 'entity', id: tid };
  goTo(state, e, spec, close ? Math.min(3_000, p.pdc.strafeM * 0.5) : R.standoffM, Math.min(R.approachG, p.maxG || 1));

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
    for (let i = 0; i < h.tubes.length && inFlight + (fired ? 1 : 0) < salvo; i++) {
      if (h.tubes[i] > now) continue;
      const warhead = pickWarhead(R, h, tp);
      if (!warhead) break;
      if (!launchTorpedo(state, e.id, tid, { warhead, profile: dAU > 0.002 ? 'cold' : 'fast', aim: R.aim }, emit)) break;
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
