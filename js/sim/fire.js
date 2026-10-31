// ============================================================
// LONGHAUL — Fire aboard
//
// A hit that gets inside the hull (spall, a torpedo's blast, a slug
// through a deck), a ship coming down on a rock, a machine shorting out as
// it is wrecked: any of them can start a fire in a compartment. Each deck
// is a compartment, and a fire is the deck's: it has an intensity (0–1)
// that grows on the deck's oxygen and pressure, burns the oxygen down,
// fills the air with smoke (breathed as CO₂: life-support.js), wrecks the
// machinery on the deck and burns whoever is on it without a suit. A big
// fire reaches the next deck through the ladder shaft while its hatches
// are open (the pressure doors shut when the pressures part).
//
// Putting it out:
//   FIGHT IT — a firefighting job (crew-ai.js): a hand suits up at a
//     locker and goes in with an extinguisher; each minute knocks it back.
//   STARVE IT — vent the deck to space (the compartment menu, per deck):
//     below 25 kPa, or 12% oxygen, nothing burns. Close the vents and the
//     plant repressurizes it from the tanks. Anyone on the deck unsuited
//     is in vacuum: the SUITS order (state.suitsOn) has everyone in a suit
//     before a fight, so a deck can be vented with its crew still on it.
// ============================================================

import { random } from '../core/rng.js';
import { addJob, closeJob, JobType, JOB_PRIORITY } from './jobs.js';
import { shipGeometry } from './ship-layout.js';
import { SYSTEMS, damageSystem, shipSystems } from './systems.js';
import { addCondition, addBurn } from './crew.js';

export const FIRE = {
  OUT_KPA: 25,          // nothing burns below this pressure…
  OUT_O2: 12,           // …or this oxygen
  GROW: 0.08,           // intensity a minute, on good air
  O2_BURN: 0.5,         // % O₂ a minute at full intensity, on a deck of REF_VOLUME
  SMOKE: 0.35,          // % CO₂-equivalent a minute at full intensity
  REF_VOLUME: 400,      // m³
  SPREAD: 0.03,         // chance a minute a fire above 0.7 reaches the next deck
  FIGHT: 0.12,          // intensity one firefighter knocks back a minute
};

const status = (a) => a?.fire ? a.fire.intensity : 0;
export const onFire = (deck) => status(deck.atmosphere) > 0;

/** Start (or feed) a fire on a deck: only where there is air to burn. Returns true if it caught. */
const BURN_PER_MIN = 4;              // burn (0–100) a minute in a full fire with no suit on

export function ignite(state, deck, intensity = 0.15, cause = 'hit', emit = () => {}) {
  const d = state.ship.decks[deck];
  const a = d?.atmosphere;
  if (!a || a.pressure < FIRE.OUT_KPA || a.o2Pct < FIRE.OUT_O2 || a.vented) return false;
  const was = a.fire;
  a.fire = { intensity: Math.min(1, (was?.intensity || 0) + intensity), since: was?.since ?? state.clock.minute, cause };
  if (!was) emit('fire', { deck, name: d.name, cause, text: `FIRE on the ${d.name} deck${cause === 'hit' ? ' after the hit' : cause === 'impact' ? ' from the impact' : ''}.` });
  return true;
}

/** Firefighting: knock a deck's fire back by `amount`. Returns true when it is out. */
export function fightFire(state, deck, amount, emit = () => {}) {
  const a = state.ship.decks[deck]?.atmosphere;
  if (!a?.fire) return true;
  a.fire.intensity -= amount;
  if (a.fire.intensity > 0) return false;
  out(state, deck, 'fought', emit);
  return true;
}

function out(state, deck, how, emit) {
  const a = state.ship.decks[deck].atmosphere;
  a.fire = null;
  emit('fire-out', { deck, name: state.ship.decks[deck].name, how, text: `Fire on the ${state.ship.decks[deck].name} deck is out${how === 'vented' ? ': starved by the vacuum' : how === 'starved' ? ': it burned the air out' : ''}.` });
}

/** Per minute: every fire burns, spreads, is starved or not; the jobs to fight them. */
export function fireTick(state, emit = () => {}) {
  const ship = state.ship;
  const geo = shipGeometry(ship);
  ship.decks.forEach((d, di) => {
    const a = d.atmosphere;
    if (!a?.fire) return;
    if (a.pressure < FIRE.OUT_KPA || a.o2Pct < FIRE.OUT_O2) { out(state, di, a.vented || a.breached ? 'vented' : 'starved', emit); return; }
    const f = a.fire;
    // grows on the air it has
    const air = Math.min(1, a.pressure / 101.3) * Math.min(1, a.o2Pct / 20.9);
    f.intensity = Math.min(1, f.intensity + FIRE.GROW * air * (1 - f.intensity * 0.5));
    // eats the oxygen, makes smoke (a small deck goes faster)
    const k = FIRE.REF_VOLUME / Math.max(50, a.volume);
    a.o2Pct = Math.max(0, a.o2Pct - FIRE.O2_BURN * f.intensity * k);
    a.co2Pct = Math.min(100, a.co2Pct + FIRE.SMOKE * f.intensity * k);
    // wrecks what is on the deck
    for (const id of systemsOnDeck(state, di)) {
      if (random() < 0.04 * f.intensity) damageSystem(state, id, { severity: f.intensity > 0.6 ? 'major' : 'minor', loss: Math.round(12 * f.intensity), cause: 'fire' }, emit);
    }
    // burns whoever is in it (a suit keeps off most of it)
    for (const m of ship.crew) {
      if (m.dead || m.away || geo.deckOfRow(m.pos.sy) !== di) continue;
      const k2 = m.suit.wearing ? 0.15 : 1;
      m.body.torso = Math.max(0, m.body.torso - 1.5 * f.intensity * k2);
      m.body.leftArm = Math.max(0, m.body.leftArm - f.intensity * k2);
      m.body.rightArm = Math.max(0, m.body.rightArm - f.intensity * k2);
      if (!m.suit.wearing && f.intensity > 0.3) addBurn(m, BURN_PER_MIN * f.intensity);
    }
    // through the shaft to the next deck, while the hatches are open
    if (f.intensity > 0.7 && random() < FIRE.SPREAD) {
      for (const [i, j] of state.lifeSupport.connections) {
        const other = i === di ? j : j === di ? i : null;
        if (other == null || ship.decks[other].atmosphere?.fire) continue;
        if (Math.abs(ship.decks[other].atmosphere.pressure - a.pressure) > 15) continue;
        if (ignite(state, other, 0.1, 'spread', emit)) break;
      }
    }
  });
  fireJobs(state);
}

/** One firefighting job for every deck on fire; gone when the fire is. */
function fireJobs(state) {
  state.ship.decks.forEach((d, deck) => {
    const job = state.jobs.list.find(j => j.type === JobType.FIRE && j.data.deck === deck);
    if (d.atmosphere?.fire && !job) addJob(state, JobType.FIRE, JOB_PRIORITY.CRITICAL, { deck });
    else if (!d.atmosphere?.fire && job) closeJob(state, job);
  });
}

const _onDeck = new WeakMap();
function systemsOnDeck(state, deck) {
  let map = _onDeck.get(state.ship.decks);
  if (!map) {
    const geo = shipGeometry(state.ship);
    map = state.ship.decks.map(() => []);
    for (const id of shipSystems(state)) for (const f of geo.fixtures[SYSTEMS[id].fixture] || []) if (!map[f.deck].includes(id)) map[f.deck].push(id);
    _onDeck.set(state.ship.decks, map);
  }
  return map[deck] || [];
}
