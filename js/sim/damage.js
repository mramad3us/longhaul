// ============================================================
// LONGHAUL — Damage
//
// A hit is a number of damage points (DP) delivered to a section of a
// hull — or, for nuclear warheads and fusion blasts, to all of it at
// once. Armor sheds a share of every hit.
//
// Aim decides where focused hits land. DISABLE goes for the drive,
// DISARM for weapons and fire control, KILL for the reactor. Weapons
// differ in how well they can be aimed (a railgun slug goes where it
// is pointed; a torpedo's shaped charge goes roughly there).
//
// On the player's ship a hit lands on decks: it holes them, faults
// the machinery housed there, and wounds the people standing in the
// way. A hit on the reactor deck can start a containment failure —
// or, from a kill shot, end the ship outright.
//
// NPC hulls track structure and four sections (drive, reactor,
// weapons, sensors). A ship with no drive is disabled; with no
// structure, a wreck. A failing reactor counts down to a fusion
// detonation that damages everything for kilometers around.
//
// Every hit also leaves a scar where it landed: the section, how hard
// (its share of the hull's points), what made it, when, and a place on
// the section (u along it, v round it) worked from a hash of the hull
// and the hit, not the dice (the game's random stream is the same with
// or without them). The ship's outside is drawn from its scars (ui/gl/
// damage.js): holes, scorching, a wreck broken-backed. NPC hulls keep
// theirs on e.combat.scars, our ship on state.hull.scars (with the deck
// hit); the worst SCARS_MAX are kept.
//
// A ship that broke up all at once leaves no hull, only its pieces
// spreading from where it was (tags.blown: A SHIP BLOWN APART, below).
// ============================================================

import { AU_M } from '../core/constants.js';
import { random, randInt, weightedPick } from '../core/rng.js';
import { getWorld } from './world.js';
import { SYSTEMS, damageSystem, shipSystems } from './systems.js';
import { setBreach } from './life-support.js';
import { ignite } from './fire.js';
import { applyImpact, mourn } from './crew.js';
import { triggerContainmentFailure } from './reactor.js';
import { shipGeometry } from './ship-layout.js';
import { CLASSES, SIZES, PLAYER_CLASS, classOf, hullPoints } from './ship-classes.js';
import { PLAYER, ensureHull, profile, DISABLED_BELOW } from './combatants.js';
import { recordAttack } from './law.js';
import { creditKill } from './service.js';
import { sizeForMass, huntsOf } from './sensors.js';
import { hullOf } from './hulls.js';

export const AIM = {
  disable: { id: 'disable', label: 'DISABLE', desc: 'Aim for the drive — cripple the ship, leave the crew alive to surrender.', weights: { drive: 0.6, weapons: 0.1, hull: 0.25, reactor: 0.05 } },
  disarm: { id: 'disarm', label: 'DISARM', desc: 'Aim for the guns, tubes and fire control.', weights: { weapons: 0.6, sensors: 0.15, hull: 0.2, drive: 0.05 } },
  kill: { id: 'kill', label: 'KILL', desc: 'Aim for the reactor. A hit there can turn the ship into a small sun — keep your distance.', weights: { reactor: 0.5, drive: 0.2, sensors: 0.15, hull: 0.15 } },
};
const UNAIMED = { hull: 0.4, drive: 0.2, reactor: 0.1, weapons: 0.15, sensors: 0.15 };
const ARMOR_PER_POINT = 0.12;
export const SCARS_MAX = 24;
const ARMOR_MAX = 0.6;

/** Player's ship: where each section is (deck ids). */
const PLAYER_DECKS = {
  hull: ['quarters', 'mess', 'utility', 'cargo'],
  drive: ['engineering'],
  reactor: ['reactor'],
  weapons: ['cargo', 'engineering'],
  sensors: ['bridge'],
};

/** Pick the section a focused hit lands on, given aim and how well the weapon aims (0–1). */
export function pickSection(aim, precision) {
  const w = AIM[aim]?.weights || UNAIMED;
  const keys = Object.keys(UNAIMED);
  return weightedPick(keys, k => precision * (w[k] || 0) + (1 - precision) * UNAIMED[k]);
}

/** A stable number in [0, 1) from a string and two integers (where a scar lands: not the dice). */
function hash01(id, a, b) {
  let h = 2166136261 ^ a * 374761393 ^ b * 668265263;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Keep the mark a hit leaves: { s: section, k: kind, r: share of the hull's points,
 * u, v: where on the section, m: minute, d?: our deck }. The worst SCARS_MAX stay.
 */
function scar(list, id, minute, o) {
  const n = list.length;
  list.push({ ...o, r: Math.round(o.r * 1000) / 1000, u: hash01(id, n, minute), v: hash01(id, n + 7919, minute), m: minute });
  if (list.length > SCARS_MAX) {
    // (the slightest goes first; of equals, the oldest)
    let w = 0;
    for (let i = 1; i < list.length - 1; i++) if (list[i].r < list[w].r) w = i;
    list.splice(w, 1);
  }
}

const shed = (dp, armor, spread) => dp * (1 - Math.min(ARMOR_MAX, armor * ARMOR_PER_POINT * (spread ? 0.5 : 1)));

/**
 * Deliver a hit. hit: { dp, section?, aim?, precision?, spread?, kind, from, weapon }
 * Returns a summary { section, dp, destroyed, disabled } (or null if the target is gone).
 */
export function applyHit(state, targetId, hit, emit = () => {}) {
  if (targetId === PLAYER) return hitPlayer(state, hit, emit);
  const e = getWorld(state).get(targetId);
  if (!e) return null;
  if (e.type === 'station') return hitStation(state, e, hit, emit);
  if (e.type !== 'ship') return null;
  return hitNpc(state, e, hit, emit);
}

// ---- STATIONS ----
// A station is a big target with sections of its own: the docks (where
// DISABLE fire goes), its defenses (DISARM), sensors, and the power plant
// (KILL: a station runs several shielded reactors; losing them blacks it
// out rather than lighting a sun). Out of structure, it is broken: no
// berths, no services, no guns. A station knows who hurts it.

const STATION_SECTION = { drive: 'docks', weapons: 'weapons', sensors: 'sensors', reactor: 'reactor', hull: 'hull' };

function hitStation(state, e, hit, emit) {
  const h = ensureHull(e);
  if (h.status === 'wreck') return null;
  const dp = shed(hit.dp, profile(state, e.id).armor, hit.spread);
  if (hit.from) { h.lastHitBy = hit.from; if (!h.hostile.includes(hit.from)) h.hostile.push(hit.from); h.alert = 'hostile'; }
  h.hp -= dp;
  const share = (k, f) => { h[k] = Math.max(0, h[k] - dp * f / (h.hpMax * 0.15)); };
  let section = 'all';
  if (hit.spread) for (const k of ['docks', 'weapons', 'sensors', 'reactor']) share(k, 0.5);
  else {
    section = STATION_SECTION[hit.section || pickSection(hit.aim, hit.precision ?? 0.5)];
    if (section !== 'hull') share(section, 1);
  }
  h.crew = Math.max(0, h.crew - dp / h.hpMax * 0.1);
  emit('station-hit', { id: e.id, name: e.name, section, dp, by: hit.from, weapon: hit.weapon });
  if (hit.from === PLAYER) recordAttack(state, e, 'hit', emit);
  if (h.reactor <= 0.05 && h.status === 'ok') {
    h.status = 'blackout';
    emit('station-blackout', { id: e.id, name: e.name, by: hit.from });
  }
  if (h.hp <= 0) {
    h.status = 'wreck';
    h.hp = 0;
    e.name = `${e.name} (broken)`;
    emit('station-destroyed', { id: e.id, name: e.name, by: hit.from });
    if (hit.from === PLAYER) recordAttack(state, e, 'destroyed', emit);
    return { section, dp, destroyed: true };
  }
  return { section, dp, destroyed: false };
}

// ---- THE PLAYER'S SHIP ----

/** Systems housed on each deck (from where their fixtures stand). */
const _deckSystems = new WeakMap();
function deckSystems(state) {
  let map = _deckSystems.get(state.ship.decks);
  if (!map) {
    const geo = shipGeometry(state.ship);
    map = state.ship.decks.map(() => []);
    for (const id of shipSystems(state)) {
      for (const f of geo.fixtures[SYSTEMS[id].fixture] || []) if (!map[f.deck].includes(id)) map[f.deck].push(id);
    }
    _deckSystems.set(state.ship.decks, map);
  }
  return map;
}

function decksFor(state, section) {
  const ids = PLAYER_DECKS[section] || PLAYER_DECKS.hull;
  return state.ship.decks.map((d, i) => ids.includes(d.id) ? i : -1).filter(i => i >= 0);
}

function hitPlayer(state, hit, emit) {
  if (state.lost) return null;
  const p = profile(state, PLAYER);
  const dp = shed(hit.dp, p.armor, hit.spread);
  const hpMax = hullPoints(CLASSES[state.ship.classId || PLAYER_CLASS]);
  state.hull.integrity = Math.max(0, state.hull.integrity - dp / hpMax * 100);
  const section = hit.spread ? 'all' : (hit.section || pickSection(hit.aim, hit.precision ?? 0.5));
  const decks = hit.spread ? state.ship.decks.map((_, i) => i) : (() => { const ds = decksFor(state, section); return [ds[randInt(0, ds.length - 1)]]; })();
  const local = hit.spread ? dp * 0.5 : dp;
  const effects = { breaches: [], systems: [], wounded: [], containment: false };
  const scars = state.hull.scars ||= [];
  if (hit.spread) scar(scars, 'player', state.clock.minute, { s: 'all', k: hit.kind || 'blast', r: dp / hpMax });
  else for (const di of decks) scar(scars, 'player', state.clock.minute, { s: section, k: hit.kind || 'hit', r: dp / hpMax, d: state.ship.decks[di].id });
  for (const di of decks) {
    const deck = state.ship.decks[di];
    if (deck.atmosphere && !deck.atmosphere.breached && random() < Math.min(1, local / 40)) {
      setBreach(state, di, true);
      effects.breaches.push(deck.name);
    }
    // what gets inside can start a fire (fire.js; a holed deck may vent before it takes)
    if (random() < Math.min(0.5, local / 90) && ignite(state, di, 0.1 + Math.min(0.4, local / 150), hit.kind === 'impact' ? 'impact' : 'hit', emit)) effects.fires = [...(effects.fires || []), deck.name];
    for (const id of deckSystems(state)[di]) {
      if (random() < Math.min(1, local / 45)) {
        damageSystem(state, id, { severity: local > 35 ? 'major' : 'minor', loss: Math.round(local * 0.6), cause: 'combat' }, emit);
        effects.systems.push(SYSTEMS[id].name);
      }
    }
    const geo = shipGeometry(state.ship);
    for (const m of state.ship.crew) {
      if (m.dead || m.away || geo.deckOfRow(m.pos.sy) !== di) continue;      // (ashore, or across with a boarding party: not here to be hit)
      if (random() >= Math.min(0.9, local / 90)) continue;
      const r = applyImpact(m, 2 + local / 7);
      if (!r) continue;
      effects.wounded.push(m.name);
      emit('crew-wounded', { member: m, message: r.message.replace('slammed into a bulkhead', 'hit by spall and debris') });
      if (m.dead) { m.deathCause = 'killed when the hull was hit'; mourn(state.ship.crew, m); emit('crew-died', { member: m }); }
    }
    if (deck.id === 'reactor') {
      if (hit.aim === 'kill' && !hit.spread && local >= 50 && random() < (local - 40) / 120) {
        emit('player-hit', { ...summary(hit, section, dp), effects });
        destroyPlayer(state, 'reactor', emit);
        return { section, dp, destroyed: true };
      }
      if (random() < Math.min(0.9, local / 70) && triggerContainmentFailure(state)) effects.containment = true;
    }
  }
  emit('player-hit', { ...summary(hit, section, dp), effects });
  if (state.hull.integrity <= 0) { destroyPlayer(state, 'structure', emit); return { section, dp, destroyed: true }; }
  return { section, dp, destroyed: false };
}

const summary = (hit, section, dp) => ({ kind: hit.kind, weapon: hit.weapon, from: hit.from, section, dp });

/** The ship is gone. A reactor loss takes its neighbors with it. */
export function destroyPlayer(state, cause, emit = () => {}) {
  if (state.lost) return;
  state.lost = { cause, at: state.clock.minute };
  const c = CLASSES[state.ship.classId || PLAYER_CLASS];
  if (cause === 'reactor') detonate(state, state.flight.pos, SIZES[c.size].reactor, PLAYER, emit);
  emit('player-destroyed', { cause });
}

// ---- NPC HULLS ----

function hitNpc(state, e, hit, emit) {
  const h = ensureHull(e);
  if (h.status === 'wreck' && hit.spread !== true) return null;
  const c = classOf(e);
  const armor = profile(state, e.id).armor;
  const dp = shed(hit.dp, armor, hit.spread);
  const wasDisabled = h.status === 'disabled' || h.drive < DISABLED_BELOW;
  if (hit.from) h.lastHitBy = hit.from;
  h.hp -= dp;
  h.crew = Math.max(0, h.crew - dp / h.hpMax * 0.3 * random());
  let section = 'all';
  if (hit.spread) {
    for (const k of ['drive', 'reactor', 'weapons', 'sensors']) h[k] = Math.max(0, h[k] - dp / (h.hpMax * 0.6));
    if (h.reactor < 0.3) startContainment(state, e, h);
  } else {
    section = hit.section || pickSection(hit.aim, hit.precision ?? 0.5);
    if (section !== 'hull') h[section] = Math.max(0, h[section] - dp / (h.hpMax * 0.35));
    const spill = pickSection(null, 0);
    if (spill !== 'hull' && spill !== section) h[spill] = Math.max(0, h[spill] - dp * 0.3 / (h.hpMax * 0.35));
    if (section === 'reactor') {
      if (hit.aim === 'kill' && dp >= 0.4 * h.hpMax && random() < Math.min(0.8, dp / h.hpMax)) {
        emit('ship-hit', { id: e.id, name: e.name, section, dp, by: hit.from, weapon: hit.weapon });
        explodeNpc(state, e, hit.from, emit);
        return { section, dp, destroyed: true };
      }
      if (h.reactor < 0.5) startContainment(state, e, h);
    }
  }
  scar(h.scars ||= [], e.id, state.clock.minute, { s: section, k: hit.kind || 'hit', r: dp / h.hpMax });
  emit('ship-hit', { id: e.id, name: e.name, section, dp, by: hit.from, weapon: hit.weapon });
  if (hit.from === PLAYER) recordAttack(state, e, 'hit', emit);
  if (h.hp <= 0) { wreckNpc(state, e, hit.from, emit); return { section, dp, destroyed: true }; }
  if (!wasDisabled && h.drive < DISABLED_BELOW && h.status === 'ok') {
    h.status = 'disabled';
    emit('ship-disabled', { id: e.id, name: e.name, by: hit.from });
    if (hit.from === PLAYER) recordAttack(state, e, 'disabled', emit);
  }
  return { section, dp, destroyed: false, disabled: h.drive < DISABLED_BELOW };
}

function startContainment(state, e, h) {
  if (h.containment == null && !h.scrammed) { h.containment = randInt(3, 30); armFuse(state, e); }
}

/**
 * A hull whose reactor is counting down that no pilot ticks (a wreck, a
 * scuttled prize): kept on state.combat.fuses, a short list, and counted
 * down by fusesTick. (A pilot's ship is counted down by agentsTick.)
 */
export function armFuse(state, e) {
  const F = state.combat.fuses ||= [];
  if (!F.includes(e.id)) F.push(e.id);
}

/** Per minute: the countdowns no pilot ticks. */
export function fusesTick(state, emit = () => {}) {
  const F = state.combat.fuses;
  if (!F?.length) return;
  const world = getWorld(state);
  for (const id of [...F]) {
    const e = world.get(id);
    if (!e || e.combat?.containment == null) { F.splice(F.indexOf(id), 1); continue; }
    if (e.agent && world.driven.has(e)) continue;
    hullTick(state, e, emit);
    if (!world.get(id) || e.combat?.containment == null) F.splice(F.indexOf(id), 1);
  }
}

/** Break-up: structure gone. The hulk drifts on (salvage). */
export function wreckNpc(state, e, by, emit = () => {}) {
  const h = ensureHull(e);
  if (h.status === 'wreck') return;
  h.status = 'wreck';
  h.hp = 0;
  h.containment = null;
  h.wreckedAt = state.clock.minute;
  getWorld(state).setDriven(e, false);
  e.t = state.clock.minute;
  e.thrust = 0;
  e.agent = null;
  e.transponder = false;
  getWorld(state).setSos(e, false);
  getWorld(state).setForce(e, null);
  e.tags.wreck = true;
  e.tags.traffic = false;
  e.tags.despawnAt = state.clock.minute + 10 * 1440;
  e.name = `${e.name} (wreck)`;
  emit('ship-destroyed', { id: e.id, name: e.name, by, how: 'wrecked' });
  if (by === PLAYER) { creditKill(state, e, emit); recordAttack(state, e, 'destroyed', emit); }
}

/** Containment gone: the ship becomes a fusion fireball. */
export function explodeNpc(state, e, by, emit = () => {}) {
  const world = getWorld(state);
  if (!world.get(e.id)) return;
  const c = classOf(e);
  const blast = SIZES[c?.size || sizeForMass(e.mass)].reactor;
  const pos = { x: e.pos.x, y: e.pos.y };
  // (a wreck blown up was already counted when it broke up: no second kill to credit)
  const already = e.combat?.status === 'wreck';
  if (e.combat) e.combat.status = 'wreck';
  // (a fireball leaves no wreck to find: a contract hunting the ship is told it died, not that it got away)
  const hunt = huntsOf(state).get(e.id);
  if (hunt) hunt.targetGone = 'destroyed';
  world.remove(e);
  emit('ship-destroyed', { id: e.id, name: e.name, by, how: 'reactor' });
  if (by === PLAYER && !already) { creditKill(state, e, emit); recordAttack(state, e, 'destroyed', emit); }
  detonate(state, pos, blast, e.id, emit);
}

const BLAST_REACH = 7;                // a blast is looked for out to this many scale lengths (e^-7: nothing left)

/** How far from a hull its reactor's blast can still hurt us (m): beyond it, it does nothing (detonate's floor of 2 DP). */
export function blastClearM(e) {
  const blast = SIZES[classOf(e)?.size || sizeForMass(e.mass)].reactor;
  return Math.ceil(blast.scaleM * Math.min(BLAST_REACH, Math.log(blast.dp / 2)) / 100) * 100;
}

/**
 * A fusion or nuclear detonation at `pos`: every hull within reach
 * takes blast.dp · e^(−d / blast.scaleM). Emits 'detonation'.
 */
export function detonate(state, pos, blast, sourceId, emit = () => {}, { kind = 'fusion', by = sourceId } = {}) {
  const world = getWorld(state);
  const reachM = blast.scaleM * BLAST_REACH;
  emit('detonation', { x: pos.x, y: pos.y, scaleM: blast.scaleM, kind, sourceId });
  for (const e of world.query(pos, reachM / AU_M)) {
    if (e.id === sourceId || (e.type !== 'ship' && e.type !== 'station')) continue;
    const d = Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y) * AU_M;
    const dp = blast.dp * Math.exp(-d / blast.scaleM);
    if (dp >= 2) applyHit(state, e.id, { dp, spread: true, kind: 'blast', from: by, weapon: kind }, emit);
  }
  if (sourceId !== PLAYER && !state.lost) {
    const f = state.flight.pos;
    const d = Math.hypot(f.x - pos.x, f.y - pos.y) * AU_M;
    const dp = blast.dp * Math.exp(-d / blast.scaleM);
    if (dp >= 2) applyHit(state, PLAYER, { dp, spread: true, kind: 'blast', from: by, weapon: kind }, emit);
  }
}

/**
 * Per minute for NPC hulls in a fight: failing containment counts
 * down (a trained crew may scram in time).
 */
export function hullTick(state, e, emit = () => {}) {
  const h = e.combat;
  if (!h || h.containment == null) return;
  // (a wreck's survivors can't reach the core, nor anyone undo charges set to blow it)
  if (h.status !== 'wreck' && !e.tags?.scuttled && h.crew > 0.3 && (e.tl || 2) >= 2 && random() < 0.12) {
    h.containment = null;
    h.scrammed = true;
    h.reactor = Math.min(h.reactor, 0.2);
    emit('ship-scrammed', { id: e.id, name: e.name });
    if (h.status === 'ok') { h.status = 'disabled'; emit('ship-disabled', { id: e.id, name: e.name, by: h.lastHitBy ?? null }); }
    return;
  }
  if (--h.containment <= 0) explodeNpc(state, e, h.lastHitBy ?? null, emit);
}

// ---- A WRECK'S TUMBLE ----
//
// A wreck tumbles from the moment it was wrecked: about an axis and at a
// rate (1.5–5.5° a minute) worked from a hash of its id, the same for
// every look at it (ui/gl/damage.js draws it so). A ship docking with one
// matches its spin first (docking.js SPIN MATCH), and flies round it as it
// does until the collar it wants faces it down the corridor: to us the
// wreck's turn slows and stops with the hull back where the dock's frame
// has it (tags.spinHeld: from its angle then to the nearest whole turn,
// at most half a turn either way), and stands still after. Once the
// collars are mated our RCS despins the pair (tags.despun: it turns no
// more, ever). Called off before that, it turns on from where it stood
// (tags.tumble0).

/** A stable number in [0, 1) from a string and integers (the tumble: as ui/gl/damage.js hashes a hull's id). */
function stable01(id, a = 0, b = 0) {
  let h = 2166136261 ^ Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A wreck's tumble: { axis (unit, in its hull's frame), rate (° a minute),
 * since (the minute it began; null: a hulk with no date, drawn still) }, or
 * null for a hull that is no wreck.
 */
export function tumbleOf(e) {
  if (e?.combat?.status !== 'wreck') return null;
  const id = e.id;
  const a = stable01(id, 1, 21) * Math.PI * 2, b = Math.acos(2 * stable01(id, 2, 21) - 1);
  const since = e.combat.wreckedAt ?? (e.tags?.despawnAt != null ? e.tags.despawnAt - 10 * 1440 : null);
  return { axis: [Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b)], rate: 1.5 + 4 * stable01(id, 3, 21), since };
}

/** How far round a wreck has turned at minute `tm` (°), as we see it; null for no wreck. */
export function tumbleAngle(e, tm) {
  const t = tumbleOf(e);
  if (!t) return null;
  const T = e.tags || {};
  if (T.despun) return T.despun.deg;
  const H = T.spinHeld;
  if (H) {
    // (a cubic from its angle and rate then to the whole turn at rest: the match and the fly-round)
    const u = Math.min(1, Math.max(0, (tm - H.at) / H.D));
    return H.deg0 + t.rate * H.D * (u - 2 * u * u + u * u * u) + (H.F - H.deg0) * (3 * u * u - 2 * u * u * u);
  }
  if (T.tumble0) return T.tumble0.deg + t.rate * Math.max(0, tm - T.tumble0.at);
  return t.since == null ? t.rate * 60 : t.rate * Math.max(0, tm - t.since);
}

/** Is it turning, to us (a dock must match it first)? */
export function tumbling(e) {
  const t = tumbleOf(e);
  return !!t && t.since != null && !e.tags?.despun && !e.tags?.spinHeld;
}

/** The turn left to the nearest whole turn from where it stands at `minute` (°, −180 to 180): what a spin match flies round. */
export function spinLeft(e, minute) {
  const deg = tumbleAngle(e, minute) ?? 0;
  return Math.round(deg / 360) * 360 - deg;
}

/** We take up its turn from `minute` over `D` minutes, flying round to its collar: it stands still to us after. */
export function holdSpin(e, minute, D) {
  e.tags ||= {};
  const deg0 = tumbleAngle(e, minute);
  e.tags.spinHeld = { at: minute, deg0, F: deg0 + spinLeft(e, minute), D };
}

/** We let go of its turn (a dock called off): it turns on, to us, from where it stood. */
export function releaseSpin(e, minute) {
  if (!e?.tags?.spinHeld) return;
  const deg = tumbleAngle(e, minute);
  delete e.tags.spinHeld;
  e.tags.tumble0 = { deg, at: minute };
}

/** Mated, our RCS kills the pair's turn: the wreck turns no more. */
export function despin(e, minute) {
  if (!tumbleOf(e)) return;
  const deg = tumbleAngle(e, minute);
  delete e.tags.spinHeld; delete e.tags.tumble0;
  e.tags.despun = { deg, at: minute };
}

// ---- A SHIP BLOWN APART ----
//
// What a contract finds of a lost ship that broke up all at once (an
// INVESTIGATE whose ship is debris: contracts.js): no hull, nothing to
// board, hail or dock with, its pieces drifting apart from where it was
// (tags.blown, and a wreck in every other way). The entity is their
// centre of mass, flying on as the ship would have; each piece flies off
// it at the speed the break gave it, the same ever since (nothing out
// here slows it). The break shared out its momentum, so a piece's speed
// goes as one over its mass, a plate's mass as its area: speed as one
// over its size squared, and most of them took little of the push, a few
// a lot. The heavy pieces (the drive, a module's end, a tank, a tenth of
// the hull or more across) creep apart at a fraction of a millimetre a
// second and lie within a hundred metres or so of where it was after
// days, a score of smaller ones among them; the rest of the plating,
// spars and fins, at millimetres a second and more, are kilometres out by
// then, going. Among them is ice: the water
// and air of its tanks and decks froze as they went out, and the flakes
// and chunks of it that went slowly glint in the sunlight as they tumble.
// Every piece's size, way and speed come from hashes of the ship's id
// (as a wreck's tumble does), so every look at it sees the same cloud:
// the cameras draw its pieces (ui/gl/damage.js), the telescope frames its
// core, the dozen pieces nearest where it was (blownCloud), and its
// brightness is theirs.

const BLOWN_PIECES = 80;          // the pieces of a small hull (a big one breaks into more: + L/5, to BLOWN_PIECES_MAX)
const BLOWN_PIECES_MAX = 150;
const BLOWN_CHUNKS = 5;           // of them, the heaviest: 10–20% of the hull's length across
const BLOWN_ICE = 48;             // flakes and chunks of ice among them
const BLOWN_V = 0.002;            // m/s: a piece a twentieth of the hull's length across flies off at up to about this (the rest as size⁻²)
const BLOWN_V_MAX = 2;            // m/s: the fastest of the small stuff
const BLOWN_CORE = 12;            // the core: this many pieces, the nearest where it was
const BLOWN_FACE = 0.3;           // a piece's cross-section to the light, as a share of its size squared (thin, turned every way)

/** Make `e` what is left of a ship blown apart at `minute`: a wreck with no hull, no one aboard, its pieces spreading. */
export function blowApart(e, minute) {
  deadHull(e, minute);
  e.tags.blown = true;
}

/** A hull dead since `minute`, a wreck to everything that reads one, with no fight behind it. */
export function deadHull(e, minute) {
  e.combat = { hp: 0, hpMax: 1, drive: 0, reactor: 0, weapons: 0, sensors: 0, crew: 0, status: 'wreck', containment: null, scrammed: true, rounds: 0, magazine: { he: 0, nuke: 0 }, tubes: [], rail: [], wreckedAt: minute };
  e.thrust = 0;
  e.tags ||= {};
  e.tags.wreck = true;
}

const _blown = new Map();

/**
 * The pieces of a ship blown apart (from its id and its hull's length L, m):
 * { L, pieces: [{ dir (unit), d0 (m: where it started), v (m/s), s (m:
 * across), axis, spin (°/min), shape (gl/hullmesh.js debris) }],
 * ice: [{ dir, d0, v, s, tw (rad/s: its glint), ph }] }.
 */
export function blownPieces(e) {
  let b = _blown.get(e.id);
  if (b) return b;
  const id = e.id, L = hullOf(e.cls)?.L || 40;
  const way = (i, k) => {
    const th = stable01(id, i, k) * Math.PI * 2, ph = Math.acos(2 * stable01(id, i, k + 1) - 1);
    return [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
  };
  const n = Math.min(BLOWN_PIECES_MAX, BLOWN_PIECES + Math.round(L / 5));
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const chunk = i < BLOWN_CHUNKS;
    const rel = chunk ? 0.1 + 0.1 * stable01(id, i, 61) : 0.008 + 0.08 * stable01(id, i, 61) ** 3;
    pieces.push({
      dir: way(i, 62), d0: L * 0.5 * stable01(id, i, 64),
      // (most took little of the push, a few a lot)
      v: Math.min(BLOWN_V_MAX, BLOWN_V * (0.05 / rel) ** 2 * (0.03 + 1.5 * stable01(id, i, 65) ** 3)),
      s: L * rel, axis: way(i, 66), spin: 2 + 40 * stable01(id, i, 68),
      // (the heaviest are machinery, a tank's shell, a plate bent double; the rest anything)
      shape: chunk ? [4, 3, 0][Math.floor(stable01(id, i, 69) * 3)] : Math.floor(stable01(id, i, 69) * 6),
    });
  }
  const ice = [];
  for (let i = 0; i < BLOWN_ICE; i++) {
    ice.push({ dir: way(i, 71), d0: L * 0.3 * stable01(id, i, 73), v: BLOWN_V * (0.01 + 0.5 * stable01(id, i, 74) ** 3),
      s: 0.05 + 0.4 * stable01(id, i, 75) ** 2, tw: 0.4 + 2.6 * stable01(id, i, 76), ph: stable01(id, i, 77) * 6.283 });
  }
  b = { L, pieces, ice };
  if (_blown.size > 64) _blown.clear();
  _blown.set(id, b);
  return b;
}

/** Seconds since a ship blew apart, at minute `tm`. */
export const blownSinceS = (e, tm) => Math.max(0, tm - (e.combat?.wreckedAt ?? tm)) * 60;

/**
 * The core of a blown ship's cloud at minute `tm`: { r (m: out to the far
 * edge of the dozen pieces nearest where it was), area (m²: what the
 * pieces inside it show the Sun) }. What the telescope frames.
 */
export function blownCloud(e, tm) {
  const b = blownPieces(e), t = blownSinceS(e, tm);
  const near = b.pieces.map(p => [p.d0 + p.v * t, p.s]).sort((x, y) => x[0] - y[0]).slice(0, BLOWN_CORE);
  const r = Math.max(...near.map(([d, s]) => d + s / 2));
  let area = 0;
  for (const p of b.pieces) if (p.d0 + p.v * t <= r) area += BLOWN_FACE * p.s * p.s;
  return { r, area };
}
