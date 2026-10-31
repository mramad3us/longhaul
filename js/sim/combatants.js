// ============================================================
// LONGHAUL — Combatants: one view of every ship that can fight
//
// The player's ship lives in state.flight / state.ship; NPC ships are
// world entities. Weapons, damage and AI never care which: they ask
// for a ship's kinematics and its combat profile by id ('player' or
// an entity id).
//
// NPC hulls carry a compact combat state (e.combat), created the
// first time the ship matters to a fight: structure, the condition of
// four sections, reactor containment, ammunition. Traffic that never
// fights never pays for it.
// ============================================================

import { G0, AU_M } from '../core/constants.js';
import { getWorld } from './world.js';
import { CLASSES, SIZES, TECH, classOf, targetRadius, isEvasive, hullPoints, PLAYER_CLASS } from './ship-classes.js';
import { PDC, PDC_AUTO_FACTOR, TORPEDO_MOTOR, RAILGUN, MINING_GEAR, RAIL_RANGE_M } from './weapons.js';
import { systemPerf } from './systems.js';
import { isConscious } from './crew.js';
import { seatKind } from './ship-layout.js';
import { sizeForMass, signatureRange, playerSignatureRange, playerSensorQuality, canSee } from './sensors.js';
import { STATIONS, stationModel } from './stations.js';

export const PLAYER = 'player';

export const SECTIONS = ['drive', 'reactor', 'weapons', 'sensors'];
export const DISABLED_BELOW = 0.25;       // a section under this is out of action
export const PDC_ROUNDS_PER_MOUNT = 20_000;

const ZERO = { ax: 0, ay: 0 };

/** Kinematic view of a ship: { id, pos (AU), vel (m/s), ax, ay (own thrust, m/s²), prev, e }. */
export function kinematics(state, id) {
  if (id === PLAYER) {
    const f = state.flight;
    const a = f.thrustG * G0;
    return { id, pos: f.pos, vel: f.vel, ax: a * Math.cos(f.facing), ay: a * Math.sin(f.facing), prev: state.$prev || null, e: null };
  }
  const e = getWorld(state).get(id);
  if (!e) return null;
  const a = (e.thrust || 0) * G0;
  return { id, pos: e.pos, vel: e.vel, ax: a ? a * Math.cos(e.heading) : ZERO.ax, ay: a ? a * Math.sin(e.heading) : ZERO.ay, prev: e.$prev || null, e };
}

/** Start-of-minute snapshot for closest-approach checks. */
export function snapshot(pos, vel) {
  return { x: pos.x, y: pos.y, vx: vel.vx, vy: vel.vy };
}

// ---- SEEING EACH OTHER ----

/** How far (AU) a quality-1 sensor holds this ship. */
export function signatureOf(state, id) {
  if (id === PLAYER) return playerSignatureRange(state);
  const e = getWorld(state).get(id);
  return e ? signatureRange(e) : 0;
}

/** A ship's sensor quality (tech level, damage; the player's ops watch). */
export function sensorQuality(state, id) {
  if (id === PLAYER) return playerSensorQuality(state);
  const e = getWorld(state).get(id);
  if (!e) return 0;
  return TECH[e.tl || 2].sensors * (e.combat ? 0.3 + 0.7 * e.combat.sensors : 1);
}

/** Does `observer` hold `target` on its sensors right now? */
export function sees(state, observerId, targetId) {
  const a = kinematics(state, observerId), b = kinematics(state, targetId);
  if (!a || !b) return false;
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  return canSee(d, signatureOf(state, targetId), sensorQuality(state, observerId));
}

// ---- NPC HULLS ----

/**
 * A station's combat state: structure, its docks, defenses (the weapons
 * section), sensors and power plant, an alert level and who it is fighting.
 */
function stationHull(e) {
  const d = STATIONS[e.id]?.defense || { tl: 2, pdc: 4, tubes: 0, magazine: null, railgun: 0, armor: 2, hp: 5000 };
  e.combat = {
    station: true,
    hp: d.hp, hpMax: d.hp,
    drive: 0, reactor: 1, weapons: 1, sensors: 1, docks: 1,
    crew: 1, status: 'ok', alert: 'normal', hostile: [],
    containment: null, scrammed: true,
    rounds: d.pdc * PDC_ROUNDS_PER_MOUNT * 4,
    magazine: { he: d.magazine?.he || 0, nuke: d.magazine?.nuke || 0 },
    tubes: new Array(d.tubes).fill(0),
    rail: new Array(d.railgun).fill(0),
  };
  return e.combat;
}

/** The combat state of an NPC hull (created on first use). */
export function ensureHull(e) {
  if (e.combat) return e.combat;
  if (e.type === 'station') return stationHull(e);
  const c = classOf(e);
  const hp = c ? hullPoints(c) : SIZES[sizeForMass(e.mass)].hp;
  const tubes = c?.tubes || 0;
  e.combat = {
    hp, hpMax: hp,
    drive: 1, reactor: 1, weapons: 1, sensors: 1,
    crew: 1,                                   // fraction of the crew still standing
    status: 'ok',                              // ok | disabled | surrendered | wreck
    containment: null,                         // minutes to detonation once containment fails
    scrammed: false,
    rounds: (c?.pdc || 0) * PDC_ROUNDS_PER_MOUNT,
    magazine: { he: c?.magazine?.he || 0, nuke: c?.magazine?.nuke || 0 },
    tubes: new Array(tubes).fill(0),           // minute each tube is loaded again
    rail: new Array(c?.railgun || 0).fill(0),
  };
  return e.combat;
}

export const isWreck = (e) => e?.combat?.status === 'wreck';
export const isOutOfFight = (e) => !e || e.combat?.status === 'wreck' || e.combat?.status === 'surrendered';

// ---- LOCKS ON US ----
// A ship or a station fighting us, with us on its sensors and inside the
// reach of what it carries, is ranging us: its laser on our hull is what the
// warning receivers are there for, and they say so whether or not we can see
// who holds it. Noted each minute by whoever is aiming (agents.js fight,
// station-defense.js fireOn), the list begun afresh with the minute's
// fighting (combat.js combatTick). Runtime: a load has it back in a minute.

/** `e`, profile `p`, is aiming at us from `dM` metres: a lock if anything it carries reaches (torpedoes to `torpAU`). */
export function noteLock(state, e, p, dM, torpAU) {
  if ((p.tubes > 0 && p.torps > 0 && dM <= torpAU * AU_M) || (p.railMounts > 0 && dM <= RAIL_RANGE_M) || (p.pdc.mounts > 0 && dM <= p.pdc.strafeM)) (state.$locks ||= []).push(e.id);
}

/** Who holds a lock on us, as of the last minute's fighting. */
export function locksOnUs(state) {
  const world = getWorld(state);
  return (state.$locks || []).map(id => world.get(id)).filter(e => e && !isOutOfFight(e));
}

// ---- WHO IS AT THE GUNS ----

/** The crew member at the weapons station (fire control), if anyone. */
export function gunner(state) {
  return state.ship.crew.find(m => isConscious(m) && seatKind(m.seat) === 'weapons') || null;
}

// ---- PROFILES ----

/**
 * What a ship can do in a fight right now:
 *   radiusM, armor, maxG (drive available), evadeG (jinking now),
 *   pdc { mounts (effective), lambda, rangeM, strafeM, sigmaRad, factor, ammo },
 *   tubes, torps (in the magazine), torpedo { maxG, dv } (motor at this TL),
 *   railgun (spec | null), railMounts,
 *   gear (mining gear: MINING_GEAR spec + mounts, factor | null)
 *
 * Tech level runs through all of it: better guns and motors (weapons.js),
 * armor, and fire control — the radar, the gun laying and the targeting AI
 * behind every mount (TECH.fireControl) — and how hard the helm can jink.
 */
export function profile(state, id) {
  return id === PLAYER ? playerProfile(state) : npcProfile(state, getWorld(state).get(id));
}

function playerProfile(state) {
  const c = CLASSES[state.ship.classId || PLAYER_CLASS];
  const tl = state.ship.tl || c.tl;
  const T = TECH[tl];
  const g = gunner(state);
  const factor = (g ? 0.7 + 0.6 * g.skills.security / 100 : PDC_AUTO_FACTOR) * T.fireControl;
  return {
    id: PLAYER, isPlayer: true, cls: c, tl, faction: null,
    hp: state.hull.integrity / 100 * hullPoints(c),
    radiusM: targetRadius(c),
    armor: c.armor + T.armor,
    maxG: state.flight.maxG,
    evadeG: state.$jinkG || 0,
    pdc: {
      mounts: c.pdc * systemPerf(state, 'pdc'), ...PDC[tl],
      factor,
      ammo: state.resources.pdcRounds.current,
    },
    tubes: c.tubes * (systemPerf(state, 'launcher') > 0 ? 1 : 0),
    torps: state.magazine.he + state.magazine.nuke,
    torpedo: TORPEDO_MOTOR[tl],
    railgun: null, railMounts: 0,
    gear: c.gear ? { ...MINING_GEAR[c.gear.type], mounts: c.gear.mounts, factor } : null,
    alive: !state.lost,
  };
}

const CREW_FACTOR = { military: 1.1, authority: 1, irregular: 0.85, civilian: 0.8 };

function stationProfile(state, e) {
  const d = STATIONS[e.id]?.defense || { tl: 2, pdc: 4, tubes: 0, railgun: 0, armor: 2 };
  const h = ensureHull(e);
  const tl = d.tl;
  const armed = h.weapons >= DISABLED_BELOW && h.reactor > 0.1 && h.status === 'ok';
  const factor = 1.1 * TECH[tl].fireControl * (0.5 + 0.5 * h.sensors);
  return {
    id: e.id, isPlayer: false, isStation: true, cls: null, tl, faction: e.faction,
    hp: h.hp,
    radiusM: Math.max(200, (stationModel(e.id)?.sizeM || 1000) * 0.2),
    armor: d.armor + TECH[tl].armor,
    maxG: 0, evadeG: 0,
    pdc: { mounts: armed ? d.pdc * h.weapons : 0, ...PDC[tl], factor, ammo: h.rounds },
    gear: null,
    tubes: armed ? h.tubes.length : 0,
    torps: h.magazine.he + h.magazine.nuke,
    torpedo: TORPEDO_MOTOR[tl],
    railgun: armed && d.railgun ? RAILGUN[Math.max(2, tl)] : null,
    railMounts: armed ? d.railgun : 0,
    alive: h.status !== 'wreck',
  };
}

function npcProfile(state, e) {
  if (!e) return null;
  if (e.type === 'station') return stationProfile(state, e);
  const c = classOf(e);
  const h = ensureHull(e);
  const tl = c?.tl || e.tl || 2;
  const T = TECH[tl];
  const armed = h.weapons >= DISABLED_BELOW && h.status !== 'surrendered' && h.status !== 'wreck';
  const maxG = h.drive < DISABLED_BELOW || h.scrammed || h.status === 'wreck' ? 0 : (c?.drive.maxG || 1) * (0.5 + 0.5 * h.drive);
  const factor = (CREW_FACTOR[c?.category] || 0.8) * T.fireControl * (0.5 + 0.5 * h.crew) * (0.5 + 0.5 * h.sensors);
  return {
    id: e.id, isPlayer: false, cls: c, tl, faction: e.faction,
    hp: h.hp,
    radiusM: c ? targetRadius(c) : 20,
    armor: (c?.armor || 0) + T.armor,
    maxG,
    evadeG: e.agent?.evade && isEvasive(c) && maxG > 0 ? Math.min(3, maxG * 0.5) * T.evade : 0,
    pdc: {
      mounts: armed ? (c?.pdc || 0) * h.weapons : 0, ...PDC[tl],
      factor,
      ammo: h.rounds,
    },
    gear: armed && c?.gear ? { ...MINING_GEAR[c.gear.type], mounts: c.gear.mounts * h.weapons, factor } : null,
    tubes: armed ? h.tubes.length : 0,
    torps: h.magazine.he + h.magazine.nuke,
    torpedo: TORPEDO_MOTOR[tl],
    railgun: armed && c?.railgun ? RAILGUN[Math.max(2, tl)] : null,
    railMounts: armed ? (c?.railgun || 0) : 0,
    alive: h.status !== 'wreck',
  };
}

/**
 * Rough fighting strength (for an AI deciding whether to start or keep a
 * fight, and for comparing classes). Offense: torpedoes (better motors home
 * harder), guns laid by fire control, railguns, gear. Defense: armor, point
 * defense, drive, and the structure left to lose.
 */
export function strength(p) {
  if (!p || !p.alive) return 0;
  const torp = p.torps > 0 ? (p.tubes * 3 + Math.min(p.torps, 12) * 0.5) * p.torpedo.maxG / 18 : 0;
  const offense = 1 + torp + (p.pdc.ammo > 0 ? p.pdc.mounts * 0.5 * p.pdc.factor : 0) + p.railMounts * 4
    + (p.gear ? p.gear.mounts * 0.3 : 0);
  const defense = (1 + p.armor * 0.5) * (1 + p.pdc.mounts * p.pdc.lambda * p.pdc.factor * 2) * (1 + p.maxG * 0.05)
    * Math.sqrt(Math.max(1, p.hp ?? 120) / 120);
  return offense * defense;
}

/** Strength of a class fresh from the yard, crewed and stocked (for comparing designs). */
export function classStrength(id) {
  const c = CLASSES[id];
  const T = TECH[c.tl];
  const factor = (CREW_FACTOR[c.category] || 0.8) * T.fireControl;
  return strength({
    alive: true, hp: hullPoints(c), armor: c.armor + T.armor, maxG: c.drive.maxG,
    tubes: c.tubes, torps: (c.magazine?.he || 0) + (c.magazine?.nuke || 0), torpedo: TORPEDO_MOTOR[c.tl],
    pdc: { mounts: c.pdc, ...PDC[c.tl], factor, ammo: 1 },
    railMounts: c.railgun, gear: c.gear ? { mounts: c.gear.mounts } : null,
  });
}
