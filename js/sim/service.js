// ============================================================
// LONGHAUL — Military service: licenses, the flag, rank
//
// THE LICENSE. A captain may hold one military license, from one power
// (UN, MCR or OPA): chosen at the start, applied for at one of that
// power's stations (it wants standing, and a clean record), resigned at
// will, and revoked for serious crimes against it. Military-grade kit is
// illegal without one:
//   a NAVY HULL (a corvette off a navy's yards) needs that navy's license;
//     a stolen navy hull no license covers, and is illegal everywhere;
//   NUCLEAR TORPEDOES need a license, any license, and are legal in the
//     licensing power's space (elsewhere, Earth's and Mars's old rule
//     stands: law.js contrabandFor).
//
// THE FLAG. A license AND one of its navy's hulls make the captain an
// independent military contractor of that power: CONTRACTOR (below). A
// license in a civilian hull does nothing but make nukes legal. A
// contractor carries the flag of the power it flies for, and the rest of
// the system sees it so: its relation with every other power mirrors its
// own power's (politics.js), with the captain's personal standing on top
// at a tenth of its weight:
//
//   relation(X) = relation(our power, X) + standing(X) / 10
//
// So at war, the enemy's warships engage a contractor on sight (once they
// know who it is: transponder or a good look), its stations refuse it and
// its guns fire on it; in a crisis it is warned off; the power's friends'
// navies help it; its civilians are never targets (shooting one is still
// a crime, and a war crime costs the license). Without the flag, the
// captain's relations are its own standing, as before.
//
// SERVICE. A contractor earns REPUTATION with its power (apart from
// standing: what the navy thinks of its work, kept per power): a little
// every day in service, more for each enemy hull destroyed (by its size),
// and for each military mission done; crimes against its own side and
// failed missions cost it. Reputation makes RANK (RANK_REP, with the
// power's own titles). Rank pays (PAY_PER_RANK on military work), opens
// harder missions (holding a point from rank 1, strikes on high-value
// targets from 2, contracts.js), gets nukes issued by command ships from
// rank 3, and from rank 1 its own patrols wave it through.
//
// CALL-UPS. When a fight involving its power flares within CALLUP_AU of
// a contractor, its command orders it to report to the command ship sent
// there (forces.js). The order arrives at light speed. Docked alongside,
// it has reported; for as long as that fight lasts, the command ship's
// supplies cost it a tenth of the price (COMMAND_PRICE), and its board
// is all military work.
// ============================================================

import { AU_M, DAY_MIN } from '../core/constants.js';
import { getWorld } from './world.js';
import { FACTIONS, POWERS } from './factions.js';
import { CLASSES } from './ship-classes.js';
import { relation, atWar, enemiesOf } from './politics.js';
import { lightMinutes } from './intel.js';
import { NAVY_PREFIX } from './names.js';

export const LICENSE_STANDING = 10;     // standing a power wants before it licenses a captain
export const REVOKE_DAYS = 30;          // a revoked license can't be applied for again for this long
export const RANK_REP = [0, 40, 120, 300, 600, 1000, 1600];
export const RANKS = {
  UN: ['Ensign', 'Lieutenant (j.g.)', 'Lieutenant', 'Lieutenant Commander', 'Commander', 'Captain', 'Commodore'],
  MCR: ['Ensign', 'Lieutenant', 'Lieutenant Commander', 'Commander', 'Captain', 'Commodore', 'Rear Admiral'],
  OPA: ['Volunteer', 'Hand', 'Bosmang', 'Kapteng', 'Fleet Kapteng', 'Kommodore', 'Admiral'],
};
export const PAY_PER_RANK = 0.15;       // military pay rises this much per rank
export const RANK_FOR = { hold: 1, covert: 1, waveThrough: 1, strike: 2, nukes: 3 };
export const COMMAND_PRICE = 0.1;       // what supplies cost a contractor at its command ship, in a fight
export const CALLUP_AU = 2.5;           // fights this close call us up (an inner-system captain is called to the Belt, not to Jupiter)
const DAILY_REP = 1;
/** Reputation for an enemy hull destroyed, by kind (a command ship counts half again). */
const KILL_REP = { cutter: 10, corvette: 15, gunship: 20, raider: 5, frigate: 30, destroyer: 60, battleship: 150 };

/** How a contractor stands with a power: the bands the rest of the sim reads. */
export const ENEMY_AT = -60;            // their warships engage on sight, their stations shoot
export const HOSTILE_AT = -35;          // warned off; refused at their stations
export const FRIEND_AT = 40;            // their navies help us

export function createService(license = null, now = 0) {
  return {
    license, since: license ? now : null,
    rep: { UN: 0, MCR: 0, OPA: 0 }, rank: 0,
    kills: 0, missions: 0,
    revoked: {},                // power → minute it can be applied for again
    callups: [],                // { zoneId, faction, ship, shipName, body, kind, at, heardAt, heard, reported, over }
    record: [],                 // the service record: [{ at, text }]
  };
}

// ---- WHAT A HULL IS ----

/** The navy whose hull this is (a military class off its yards), 'stolen' for a navy hull no license covers, else null. */
export function navyOf(classId) {
  const c = CLASSES[classId];
  if (!c) return null;
  if (c.stolen) return 'stolen';
  if (c.category !== 'military') return null;
  return POWERS.find(f => c.factions?.[f]) || null;
}

/** Military-grade hull: a navy's, or a stolen one. */
export const milGrade = (classId) => navyOf(classId) != null;

// ---- WHERE WE STAND ----

export const licenseOf = (state) => state.service?.license || null;

/** A license and one of its navy's hulls: an independent military contractor, flying its flag. */
export function contractor(state) {
  const L = licenseOf(state);
  return !!L && navyOf(state.ship.classId) === L;
}

/** The power whose flag we carry (null without one). */
export const flagOf = (state) => contractor(state) ? licenseOf(state) : null;

/**
 * Our ship's name as it is shown and hailed: flying one of its navy's hulls
 * under its license, it carries the navy's prefix (MCRN Longhaul, UNN
 * Longhaul), as the navy's own hulls do; OPA warships carry bare names
 * (names.js). A name the captain gave with the prefix already isn't doubled.
 */
export function ourName(state) {
  const n = state.ship.name;
  const pre = NAVY_PREFIX[flagOf(state)];
  return !pre || n.toUpperCase().startsWith(`${pre} `) ? n : `${pre} ${n}`;
}

/** Is our hull legal to fly? (A navy hull needs its navy's license.) */
export function hullLegal(state) {
  const n = navyOf(state.ship.classId);
  return !n || n === licenseOf(state);
}

/**
 * Our relation with a faction (−100 … 100). Under a flag: our power's
 * relation with it, plus a tenth of our own standing. Without: our standing.
 */
export function effectiveRelation(state, faction) {
  if (faction === 'pirate') return -100;
  const own = state.law.standing[faction] ?? 0;
  const L = flagOf(state);
  if (!L) return POWERS.includes(faction) ? own : 0;
  if (faction === L) return 100;
  return Math.max(-100, Math.min(100, relation(state, L, faction) + own / 10));
}

/** Their warships and stations treat us as an enemy combatant. */
export const enemyOf = (state, faction) => !!flagOf(state) && POWERS.includes(faction) && effectiveRelation(state, faction) <= ENEMY_AT;
/** They warn us off and won't let us dock. */
export const hostileTo = (state, faction) => !!flagOf(state) && POWERS.includes(faction) && effectiveRelation(state, faction) <= HOSTILE_AT;
/** Their navies come to our help. */
export const friendOf = (state, faction) => !!flagOf(state) && POWERS.includes(faction) && effectiveRelation(state, faction) >= FRIEND_AT;

/**
 * Is shooting this ship war, not a crime? A contractor firing on a
 * warship or police hull of a power at war with its own (or the other
 * side of a fight its own is in) is doing its job. Civilians never are.
 */
export function enemyCombatant(state, e) {
  const L = flagOf(state);
  if (!L || !e || e.type !== 'ship') return false;
  const cat = CLASSES[e.cls]?.category;
  if (cat !== 'military' && cat !== 'authority') return false;
  return atWar(state, L, e.faction) || enemyOf(state, e.faction);
}

// ---- RANK ----

export const rankOf = (state) => state.service?.rank ?? 0;
export function rankName(state, faction = licenseOf(state), rank = rankOf(state)) {
  return faction ? RANKS[faction]?.[rank] || null : null;
}
export const payFactor = (state) => 1 + PAY_PER_RANK * (contractor(state) ? rankOf(state) : 0);

function rankFor(rep) {
  let r = 0;
  for (let i = 0; i < RANK_REP.length; i++) if (rep >= RANK_REP[i]) r = i;
  return r;
}

/** Reputation with our power moves (and rank with it). */
export function addRep(state, delta, why, emit = () => {}) {
  const S = state.service, L = S?.license;
  if (!L) return;
  S.rep[L] = Math.max(0, (S.rep[L] || 0) + delta);
  const was = S.rank;
  S.rank = rankFor(S.rep[L]);
  if (why) note(state, `${delta >= 0 ? '+' : ''}${Math.round(delta)} reputation: ${why}`);
  if (S.rank > was) { note(state, `Promoted: ${rankName(state)}`); emit('service-promoted', { rank: S.rank, title: rankName(state), faction: L }); }
  else if (S.rank < was) emit('service-demoted', { rank: S.rank, title: rankName(state), faction: L });
}

function note(state, text) {
  const S = state.service;
  S.record.push({ at: state.clock.minute, text });
  if (S.record.length > 60) S.record.shift();
}

// ---- THE LICENSE ----

/**
 * Apply for a power's license (at one of its stations or command ships:
 * the caller checks where we are). Returns { ok, text }.
 */
export function applyForLicense(state, faction, emit = () => {}) {
  const S = state.service;
  const now = state.clock.minute;
  if (!POWERS.includes(faction)) return { ok: false, text: 'Nobody here issues military licenses.' };
  if (S.license === faction) return { ok: false, text: `You already hold a ${FACTIONS[faction].short} license.` };
  if (S.license) return { ok: false, text: `You hold a ${FACTIONS[S.license].short} license. One power at a time: resign it first.` };
  if ((S.revoked[faction] ?? -Infinity) > now) return { ok: false, text: `Your ${FACTIONS[faction].short} license was revoked. Apply again in ${Math.ceil((S.revoked[faction] - now) / DAY_MIN)} days.` };
  if ((state.law.wanted[faction] ?? 0) > 0) return { ok: false, text: `${FACTIONS[faction].short} won't license a captain with an open record. Settle it first.` };
  if ((state.law.standing[faction] ?? 0) < LICENSE_STANDING) return { ok: false, text: `${FACTIONS[faction].short} licenses captains it trusts: standing ${LICENSE_STANDING} or better (yours is ${Math.round(state.law.standing[faction] ?? 0)}).` };
  S.license = faction;
  S.since = now;
  S.rank = rankFor(S.rep[faction] || 0);
  S.callups = [];
  note(state, `Licensed by ${FACTIONS[faction].name}`);
  emit('license-changed', { faction, how: 'granted' });
  const flag = contractor(state);
  return { ok: true, text: `${FACTIONS[faction].navy} contractor's license granted.${flag ? ` You fly under the ${FACTIONS[faction].short} flag now: its enemies are yours.` : ' In a civilian hull it changes little: nuclear torpedoes are legal for you in its space.'}` };
}

/** Hand the license back. Returns { ok, text }. */
export function resignLicense(state, emit = () => {}) {
  const S = state.service;
  const L = S.license;
  if (!L) return { ok: false, text: 'You hold no license.' };
  const navy = navyOf(state.ship.classId) === L;
  S.license = null;
  S.since = null;
  S.callups = [];
  note(state, `Resigned the ${FACTIONS[L].short} license`);
  emit('license-changed', { faction: L, how: 'resigned' });
  return { ok: true, text: `License returned to ${FACTIONS[L].name}.${navy ? ` Your ${FACTIONS[L].navy} hull is now unlicensed military kit: illegal to fly.` : ''}` };
}

/** A power takes its license back (crimes against it). */
export function revokeLicense(state, why, emit = () => {}) {
  const S = state.service;
  const L = S.license;
  if (!L) return;
  S.license = null;
  S.since = null;
  S.callups = [];
  S.revoked[L] = state.clock.minute + REVOKE_DAYS * DAY_MIN;
  S.rep[L] = Math.max(0, (S.rep[L] || 0) * 0.5);
  note(state, `License revoked by ${FACTIONS[L].name}: ${why}`);
  emit('license-changed', { faction: L, how: 'revoked', why });
}

// ---- WHAT WE DID ----

/** A ship we destroyed: an enemy hull is service; anything else is the law's business (law.js). */
export function creditKill(state, e, emit = () => {}) {
  if (!contractor(state) || !e) return;
  const c = CLASSES[e.cls];
  if (!c) return;
  const enemy = enemyCombatant(state, e);
  const outlaw = e.faction === 'pirate' || !!e.tags?.proxy;
  if (!enemy && !outlaw) return;
  const rep = (KILL_REP[c.kind] ?? 10) * (e.tags?.command ? 1.5 : 1) * (outlaw ? 0.35 : 1);
  state.service.kills++;
  addRep(state, rep, `${e.name.replace(' (wreck)', '')} destroyed`, emit);
}

/** A military mission done (contracts.js), or failed. */
export function creditMission(state, c, ok, emit = () => {}) {
  if (!licenseOf(state) || c.faction !== licenseOf(state)) return;
  if (ok) { state.service.missions++; addRep(state, c.rep || 20, c.title, emit); }
  else addRep(state, -Math.round((c.rep || 20) / 2), `failed: ${c.title}`, emit);
}

/** A crime against our own power (law.js): reputation, and at worst the license. */
export function ownSideCrime(state, faction, severity, emit = () => {}) {
  if (licenseOf(state) !== faction) return;
  addRep(state, -25 * severity, 'crime against our own side', emit);
  if (severity >= 2) revokeLicense(state, 'an attack on its people', emit);
}

// ---- THE COMMAND SHIP ----

/** The command ship we are docked to, of our flag, in a fight that is still on (else null). */
export function ourCommandShip(state) {
  const L = flagOf(state);
  if (!L || state.dock?.phase !== 'docked') return null;
  const e = getWorld(state).get(state.dock.target.id);
  if (!e?.tags?.command || e.faction !== L) return null;
  return state.politics.zones.some(z => z.id === e.tags.command.zone) ? e : null;
}

/** What supplies cost us here (×): a tenth at our command ship in a fight, full price elsewhere. */
export const supplyPriceFactor = (state) => ourCommandShip(state) ? COMMAND_PRICE : 1;

// ---- PER MINUTE ----

/**
 * Daily: reputation for time in service; the license lost if our own power
 * wants us. Hourly: call-ups for fights near us, heard at light speed;
 * reporting aboard.
 */
export function serviceTick(state, emit = () => {}, { commandShipFor } = {}) {
  const S = state.service;
  if (!S) return;
  const now = state.clock.minute;
  const L = S.license;
  if (!L) return;
  if (now % DAY_MIN === 480) {
    if ((state.law.wanted[L] ?? 0) >= 2) { revokeLicense(state, 'wanted by its own police', emit); return; }
    if (contractor(state)) addRep(state, DAILY_REP, null, emit);
  }
  if (!contractor(state)) return;
  if (now % 60 === 23 && commandShipFor) callUps(state, emit, commandShipFor);
  for (const cu of S.callups) {
    if (!cu.heard && now >= cu.heardAt) {
      cu.heard = true;
      emit('service-callup', { callup: cu, text: callupText(state, cu) });
    }
    if (cu.heard && !cu.reported && state.dock?.phase === 'docked' && state.dock.target.id === cu.ship) {
      cu.reported = true;
      addRep(state, 5, `reported aboard the ${cu.shipName}`, emit);
      emit('service-reported', { callup: cu });
    }
  }
}

/** Fights of our power near us that we haven't been called to yet. */
function callUps(state, emit, commandShipFor) {
  const S = state.service;
  const L = S.license;
  const now = state.clock.minute;
  const world = getWorld(state);
  const us = state.flight.pos;
  const live = new Set(state.politics.zones.map(z => z.id));
  for (const cu of S.callups) if (!live.has(cu.zoneId)) cu.over = true;
  S.callups = S.callups.filter(cu => !cu.over || now - cu.at < 2 * DAY_MIN);
  for (const z of state.politics.zones) {
    if (!z.factions.includes(L) || z.kind === 'pirates' || S.callups.some(cu => cu.zoneId === z.id)) continue;
    const ship = commandShipFor(state, z.id, L);
    if (!ship) continue;
    const post = world.get(ship.tags.force.post) || ship;
    const d = Math.hypot(post.pos.x - us.x, post.pos.y - us.y);
    if (d > CALLUP_AU) continue;
    S.callups.push({
      zoneId: z.id, faction: L, ship: ship.id, shipName: ship.name, body: z.body, kind: z.kind, post: post.id,
      at: now, heardAt: now + Math.round(lightMinutes(d)), heard: false, reported: false, over: false,
    });
  }
}

function callupText(state, cu) {
  const F = FACTIONS[cu.faction];
  const what = { front: 'the war front', skirmish: 'the fighting', standoff: 'the standoff', blockade: 'the blockade', insurgency: 'the insurgency', proxy: 'the raids on our shipping' }[cu.kind] || 'the fight';
  return `${F.navy} COMMAND to contractor ${ourName(state)}: report to the command ship ${cu.shipName} near ${cu.body} for ${what}. Military supplies at a tenth of the price for the duration.`;
}

/** Open call-ups we have heard (for the mission log). */
export const openCallups = (state) => (state.service?.callups || []).filter(cu => cu.heard && !cu.over);

/** For the UI: how we stand with every faction, and why. */
export function relationsTable(state) {
  const L = flagOf(state);
  return [...POWERS, 'independent', 'pirate'].map(f => {
    const own = state.law.standing[f] ?? 0;
    const mirror = L && f !== L && POWERS.includes(f) ? relation(state, L, f) : null;
    const eff = effectiveRelation(state, f);
    const band = f === L ? 'own' : enemyOf(state, f) || f === 'pirate' ? 'enemy' : hostileTo(state, f) ? 'hostile' : friendOf(state, f) ? 'friend' : eff <= -15 ? 'wary' : 'neutral';
    return { faction: f, standing: POWERS.includes(f) ? own : null, mirror, relation: eff, band, atWar: L && f !== L && POWERS.includes(f) ? atWar(state, L, f) : false };
  });
}

export { enemiesOf };
