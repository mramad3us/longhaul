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
import { sizeForMass } from './sensors.js';

export const AIM = {
  disable: { id: 'disable', label: 'DISABLE', desc: 'Aim for the drive — cripple the ship, leave the crew alive to surrender.', weights: { drive: 0.6, weapons: 0.1, hull: 0.25, reactor: 0.05 } },
  disarm: { id: 'disarm', label: 'DISARM', desc: 'Aim for the guns, tubes and fire control.', weights: { weapons: 0.6, sensors: 0.15, hull: 0.2, drive: 0.05 } },
  kill: { id: 'kill', label: 'KILL', desc: 'Aim for the reactor. A hit there can turn the ship into a small sun — keep your distance.', weights: { reactor: 0.5, drive: 0.2, sensors: 0.15, hull: 0.15 } },
};
const UNAIMED = { hull: 0.4, drive: 0.2, reactor: 0.1, weapons: 0.15, sensors: 0.15 };
const ARMOR_PER_POINT = 0.12;
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
      if (m.dead || geo.deckOfRow(m.pos.sy) !== di) continue;
      if (random() >= Math.min(0.9, local / 90)) continue;
      const r = applyImpact(m, 2 + local / 7);
      if (!r) continue;
      effects.wounded.push(m.name);
      emit('crew-wounded', { member: m, message: r.message.replace('slammed into a bulkhead', 'hit by spall and debris') });
      if (m.dead) { mourn(state.ship.crew, m); emit('crew-died', { member: m }); }
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
    if (h.reactor < 0.3) startContainment(h);
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
      if (h.reactor < 0.5) startContainment(h);
    }
  }
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

function startContainment(h) {
  if (h.containment == null && !h.scrammed) h.containment = randInt(3, 30);
}

/** Break-up: structure gone. The hulk drifts on (salvage). */
export function wreckNpc(state, e, by, emit = () => {}) {
  const h = ensureHull(e);
  if (h.status === 'wreck') return;
  h.status = 'wreck';
  h.hp = 0;
  h.containment = null;
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
  if (by === PLAYER) recordAttack(state, e, 'destroyed', emit);
}

/** Containment gone: the ship becomes a fusion fireball. */
export function explodeNpc(state, e, by, emit = () => {}) {
  const world = getWorld(state);
  if (!world.get(e.id)) return;
  const c = classOf(e);
  const blast = SIZES[c?.size || sizeForMass(e.mass)].reactor;
  const pos = { x: e.pos.x, y: e.pos.y };
  if (e.combat) e.combat.status = 'wreck';
  world.remove(e);
  emit('ship-destroyed', { id: e.id, name: e.name, by, how: 'reactor' });
  if (by === PLAYER) recordAttack(state, e, 'destroyed', emit);
  detonate(state, pos, blast, e.id, emit);
}

/**
 * A fusion or nuclear detonation at `pos`: every hull within reach
 * takes blast.dp · e^(−d / blast.scaleM). Emits 'detonation'.
 */
export function detonate(state, pos, blast, sourceId, emit = () => {}, { kind = 'fusion', by = sourceId } = {}) {
  const world = getWorld(state);
  const reachM = blast.scaleM * 7;
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
  if (h.crew > 0.3 && (e.tl || 2) >= 2 && random() < 0.12) {
    h.containment = null;
    h.scrammed = true;
    h.reactor = Math.min(h.reactor, 0.2);
    emit('ship-scrammed', { id: e.id, name: e.name });
    if (h.status === 'ok') { h.status = 'disabled'; emit('ship-disabled', { id: e.id, name: e.name, by: h.lastHitBy ?? null }); }
    return;
  }
  if (--h.containment <= 0) explodeNpc(state, e, h.lastHitBy ?? null, emit);
}
