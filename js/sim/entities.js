// ============================================================
// LONGHAUL — Entity definitions
// Factory and the default stations and ships. Ship identities (class,
// tech level, name) come from the catalog in ship-classes.js.
// ============================================================

import { random } from '../core/rng.js';
import { CLASSES } from './ship-classes.js';

export const EntityType = {
  STATION: 'station',
  SHIP: 'ship',
  ORDNANCE: 'ordnance',  // torpedo or railgun slug in flight
  NAV: 'nav',            // navigation marker (survey zone, rendezvous point) — not a sensor contact
};

function signature() {
  return 'SIG-' + Math.floor(random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Build an entity object. Motion: pass `orbit` for rails, or pos/vel for free flight
 * (`driven: true` when a controller — NPC pilot, torpedo guidance — steps it).
 * The World fills pos/vel for orbiting entities when indexed.
 */
export function createEntity(opts) {
  const cls = opts.cls && CLASSES[opts.cls] ? opts.cls : null;
  const e = {
    id: opts.id,
    name: opts.name,
    type: opts.type || EntityType.SHIP,
    faction: opts.faction || 'independent',
    cls,                                          // catalog class id (ships)
    tl: opts.tl || (cls ? CLASSES[cls].tl[0] : 2),
    shipClass: opts.shipClass || (cls ? CLASSES[cls].name : null),
    mass: opts.mass || (cls ? CLASSES[cls].massT : 0),   // metric tons
    pos: opts.pos ? { x: opts.pos.x, y: opts.pos.y } : { x: 0, y: 0 },
    vel: opts.vel ? { vx: opts.vel.vx, vy: opts.vel.vy } : { vx: 0, vy: 0 },
    orbit: opts.orbit ? { body: opts.orbit.body, r: opts.orbit.r, phase: opts.orbit.phase || 0, period: opts.orbit.period || 0 } : null,
    driven: !!opts.driven,
    thrust: opts.thrust || 0,                     // G along heading (free/driven flight)
    heading: opts.heading || 0,                   // radians, solar frame
    transponder: opts.transponder !== false,
    sos: !!opts.sos,
    signature: opts.signature || signature(),
    t: opts.t,                                    // minute pos/vel are valid for
    tags: opts.tags || {},                        // gameplay links (missionId, contractId, …)
  };
  if (e.type === EntityType.STATION) {
    e.board = { missions: [], lastRefresh: -Infinity, refreshInterval: 720, maxMissions: 5 };
  }
  return e;
}

// r in AU, period in days around the anchor body
const DEFAULTS = [
  { id: 'ceres-station', name: 'Ceres Station', type: 'station', faction: 'OPA', shipClass: 'Ceres-class station', mass: 1_200_000,
    orbit: { body: 'Ceres', r: 0.0001, phase: 0.6, period: 17 } },
  { id: 'pallas-station', name: 'Pallas Station', type: 'station', faction: 'OPA', shipClass: 'Tycho-class station', mass: 850_000,
    orbit: { body: 'Pallas', r: 0.0002, phase: 0.4, period: 30 } },
  { id: 'vesta-depot', name: 'Vesta Depot', type: 'station', faction: 'independent', shipClass: 'Mining depot', mass: 450_000,
    orbit: { body: 'Vesta', r: 0.0002, phase: 2.6, period: 25 } },
  { id: 'hygiea-ring', name: 'Hygiea Ring', type: 'station', faction: 'OPA', shipClass: 'Ring station', mass: 320_000,
    orbit: { body: 'Hygiea', r: 0.00018, phase: 5.7, period: 28 } },
  { id: 'tycho-station', name: 'Tycho Station', type: 'station', faction: 'OPA', shipClass: 'Construction platform', mass: 2_400_000,
    orbit: { body: 'Juno', r: 0.0004, phase: 1.1, period: 40 } },
  { id: 'luna-yards', name: 'Luna Shipyards', type: 'station', faction: 'UN', shipClass: 'Orbital shipyard', mass: 3_100_000,
    orbit: { body: 'Luna', r: 0.00002, phase: 0.2, period: 0.2 } },
  { id: 'phobos-yard', name: 'Phobos Naval Yard', type: 'station', faction: 'MCR', shipClass: 'Naval yard', mass: 1_900_000,
    orbit: { body: 'Phobos', r: 0.000005, phase: 3.0, period: 0.1 } },
  { id: 'ganymede-station', name: 'Ganymede Station', type: 'station', faction: 'independent', shipClass: 'Agricultural hub', mass: 2_700_000,
    orbit: { body: 'Ganymede', r: 0.00002, phase: 4.2, period: 0.15 } },

  { id: 'mcrn-scirocco', name: 'MCRN Scirocco', type: 'ship', faction: 'MCR', cls: 'battleship', tl: 4, shipClass: 'Donnager-class battleship', mass: 250_000,
    orbit: { body: 'Mars', r: 0.001, phase: 5.2, period: 6 } },
  { id: 'ice-hauler-pk', name: "Pur'n'Kleen Weeping Somnambulist", type: 'ship', faction: 'OPA', cls: 'ice-hauler', tl: 1, shipClass: 'Canterbury-class ice hauler', mass: 120_000,
    orbit: { body: 'Ceres', r: 0.00025, phase: 2.0, period: 40 } },
  { id: 'unn-agatha-king', name: 'UNN Agatha King', type: 'ship', faction: 'UN', cls: 'battleship', tl: 3, shipClass: 'Truman-class dreadnought', mass: 300_000,
    orbit: { body: 'Earth', r: 0.0008, phase: 0.4, period: 4 } },
  { id: 'opa-molinari', name: 'Guy Molinari', type: 'ship', faction: 'OPA', cls: 'opa-gunship', tl: 2, shipClass: 'Converted freighter', mass: 9_000,
    orbit: { body: 'Vesta', r: 0.0004, phase: 5.5, period: 35 } },
];

export function createDefaultEntities() {
  return DEFAULTS.map(d => createEntity(d));
}
