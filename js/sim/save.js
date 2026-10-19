// ============================================================
// LONGHAUL — Save format
// The game state is plain data. Saving strips runtime-only keys
// (prefixed with $) and encodes ±Infinity; loading validates the
// schema and migrates older saves forward.
// ============================================================

import { SAVE_SCHEMA, createGame } from './game.js';
import { resetWorld } from './world.js';
import { createDefaultLayout, computeShipMass } from './ship-layout.js';
import { createLifeSupport } from './life-support.js';
import { createSystems } from './systems.js';
import { createJobs } from './jobs.js';
import { createNeeds } from './needs.js';
import { defaultDuty } from './duty.js';
import { placeCrew } from './crew-ai.js';
import { ROLE_HOME_DECK } from './crew.js';
import { DAY_MIN } from '../core/constants.js';
import { VERSION } from '../version.js';

const INF = '__inf__', NINF = '__-inf__';

function replacer(key, value) {
  if (key && key[0] === '$') return undefined;
  if (value === Infinity) return INF;
  if (value === -Infinity) return NINF;
  return value;
}

function reviver(_key, value) {
  if (value === INF) return Infinity;
  if (value === NINF) return -Infinity;
  return value;
}

/** Game state → JSON string. */
export function serialize(state) {
  state.version = VERSION;
  return JSON.stringify(state, replacer);
}

/**
 * JSON string or legacy object → live game state.
 * Returns { state, migrated: bool, notes: string[] }.
 */
export function deserialize(input) {
  const data = typeof input === 'string' ? JSON.parse(input, reviver) : input;
  if (data && data.schema === SAVE_SCHEMA) {
    resetWorld(data);
    return { state: data, migrated: false, notes: [] };
  }
  if (data && data.schema === 2) return migrateV08(data);
  if (data && !data.schema && data.ship && data.resources) return migrateV07(data);
  throw new Error(`Unsupported save format (schema ${data?.schema ?? 'unknown'})`);
}

/**
 * v0.8 saves: same world and voyage, but the ship is refitted to the
 * current layout (new decks and machinery), and the crew get needs and
 * a duty roster. Whatever people were doing is reset.
 */
function migrateV08(data) {
  const ship = data.ship;
  ship.decks = createDefaultLayout();
  data.lifeSupport = createLifeSupport(ship);
  data.systems = createSystems();
  data.jobs = createJobs();
  data.resources.parts ??= { current: 12, max: 40, unit: 'parts' };
  data.resources.scrap ??= { current: 0, max: 30, unit: 'units' };
  const r = data.reactor;
  if (r.job != null) {
    r.job = null; r.work = null; r.progress = 0;
    if (r.status === 'shutting-down') r.status = 'online';
    if (r.status === 'starting-up') r.status = 'offline';
  }
  for (const m of ship.crew) {
    m.needs ??= createNeeds();
    m.duty ??= defaultDuty(m.role);
    m.moraleMod ??= 0;
    m.homeDeck = ROLE_HOME_DECK[m.role] ?? 0;
    m.seat = null; m.task = null; m.path = [];
    m.suit = { wearing: false, o2: 0, lockerId: null };
  }
  data.shipMass = computeShipMass(ship);
  data.schema = SAVE_SCHEMA;
  resetWorld(data);
  placeCrew(data);
  for (const m of ship.crew) if (m.dead) { m.task = null; m.seat = null; m.activity = 'dead'; }
  return { state: data, migrated: true, notes: ['Save from v0.8 — ship refitted: new decks and machinery, crew duty roster. Crew tasks were reset.'] };
}

/**
 * v0.7 saves: keep the ship, crew and stores; rebuild the world.
 * (Navigation, missions and crew tasks from v0.7 can't be carried over —
 * the old flight model had no compatible state.)
 */
function migrateV07(old) {
  const crew = old.ship.crew || [];
  const state = createGame({
    shipName: old.ship.name,
    captainName: crew[0]?.name || 'Captain',
    crewCount: Math.max(1, crew.length),
  });
  state.ship.crew.forEach((m, i) => {
    const o = crew[i];
    if (!o) return;
    for (const k of ['name', 'role', 'skills', 'body', 'heart', 'consciousness', 'morale', 'dead', 'conditions', 'juiceHangover']) {
      if (o[k] !== undefined) m[k] = structuredClone(o[k]);
    }
    if (m.dead) { m.activity = 'dead'; m.task = null; }
  });
  for (const k of Object.keys(state.resources)) {
    const r = old.resources[k];
    if (r && typeof r.current === 'number') state.resources[k].current = Math.min(r.current, state.resources[k].max);
  }
  state.clock.minute = Math.round((old.stats?.daysElapsed || 0) * DAY_MIN);
  state.combatStations = false;
  // Rebuild positions for the migrated time
  const rebuilt = createGameAt(state);
  return { state: rebuilt, migrated: true, notes: ['Save migrated from v0.7 — ship parked at Ceres Station, routes and missions reset.'] };
}

/** Re-anchor a state built at minute 0 to its clock (used by migration). */
function createGameAt(state) {
  for (const e of state.entities) e.t = state.clock.minute;
  const world = resetWorld(state);
  const home = world.get('ceres-station');
  world.refresh(home, state.clock.minute);
  state.flight.pos.x = home.pos.x + state.flight.hold.ox / 149_597_870_700;
  state.flight.pos.y = home.pos.y + state.flight.hold.oy / 149_597_870_700;
  state.flight.vel.vx = home.vel.vx; state.flight.vel.vy = home.vel.vy;
  return state;
}
