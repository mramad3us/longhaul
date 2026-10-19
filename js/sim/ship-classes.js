// ============================================================
// LONGHAUL — Ship classes, sizes and tech levels
//
// Every ship in the world belongs to a class from this catalog. A
// class fixes what the hull is for (role), how big it is (size), how
// it looks (shape), what its drive can do, and what it carries —
// armor, point defense, torpedo tubes and magazine, railguns, cargo
// and berths. Civilian classes are built for their trade (haulers
// carry, couriers run, liners carry people) and are mostly unarmed;
// military classes trade cargo for guns, armor and drive.
//
// Tech level (TL1–TL4) is how well it is built: sensors, stealth,
// point-defense fire control, torpedo motors, railguns, armor. Who
// builds a ship decides its TL — Belt workshops make TL1–2, Earth's
// yards TL2–3, Mars TL3–4. A class lists the TLs it exists at; the
// faction flying it picks within that range.
// ============================================================

import { random, pick, randInt, weightedPick } from '../core/rng.js';
import { FACTIONS } from './factions.js';

// ---- TECH LEVELS ----
// sensors: detection range multiplier · stealth: own signature multiplier
// armor: bonus armor points over the class rating

export const TECH = {
  1: { label: 'TL1', name: 'Improvised', sensors: 0.7, stealth: 1.2, armor: 0 },
  2: { label: 'TL2', name: 'Commercial', sensors: 1.0, stealth: 1.0, armor: 0 },
  3: { label: 'TL3', name: 'Naval', sensors: 1.3, stealth: 0.8, armor: 0.5 },
  4: { label: 'TL4', name: 'Advanced naval', sensors: 1.6, stealth: 0.55, armor: 1 },
};

// ---- SIZES ----
// hp: structure in damage points · radarAU: range a cold, silent hull of
// this size shows on radar (before stealth) · reactor: the fusion
// detonation if containment goes (damage points at the core, e-folding
// distance in meters) · radius: effective target radius as a fraction
// of hull length (mean presented cross-section)

export const SIZES = {
  S: { label: 'Small craft', hp: 60, radarAU: 0.0008, reactor: { dp: 300, scaleM: 400 } },
  M: { label: 'Medium', hp: 120, radarAU: 0.0015, reactor: { dp: 600, scaleM: 800 } },
  L: { label: 'Large', hp: 300, radarAU: 0.004, reactor: { dp: 1200, scaleM: 1500 } },
  XL: { label: 'Capital', hp: 800, radarAU: 0.01, reactor: { dp: 2500, scaleM: 3000 } },
};
export const TARGET_RADIUS_FRAC = 0.15;

// ---- SHAPES ----
// Silhouettes, bow to stern: each segment is [length fraction, half-width
// as a fraction of hull length]. The first segment tapers to the bow.
// Features: ring (spin habitat at a length fraction), tanks (spheres
// along the spine), cargo (ice/cargo block segment index), fins.

export const SHAPES = {
  skiff: { segs: [[0.3, 0.12], [0.45, 0.2], [0.25, 0.16]] },
  needle: { segs: [[0.35, 0.06], [0.45, 0.09], [0.2, 0.11]] },
  shuttle: { segs: [[0.2, 0.12], [0.6, 0.18], [0.2, 0.15]] },
  freighter: { segs: [[0.18, 0.08], [0.12, 0.13], [0.5, 0.17], [0.2, 0.12]] },
  box: { segs: [[0.1, 0.07], [0.72, 0.2], [0.18, 0.11]], cargo: 1 },
  hauler: { segs: [[0.05, 0.05], [0.05, 0.015], [0.8, 0.13], [0.1, 0.04]], cargo: 2 },
  tanker: { segs: [[0.1, 0.06], [0.7, 0.025], [0.2, 0.08]], tanks: 4 },
  liner: { segs: [[0.15, 0.07], [0.2, 0.1], [0.5, 0.12], [0.15, 0.09]], ring: 0.3 },
  barge: { segs: [[0.2, 0.22], [0.6, 0.28], [0.2, 0.14]] },
  wedge: { segs: [[0.35, 0.1], [0.45, 0.17], [0.2, 0.15]] },
  corvette: { segs: [[0.3, 0.07], [0.5, 0.13], [0.2, 0.16]], fins: true },
  frigate: { segs: [[0.2, 0.06], [0.6, 0.11], [0.2, 0.14]], fins: true },
  destroyer: { segs: [[0.15, 0.05], [0.2, 0.09], [0.5, 0.1], [0.15, 0.13]], fins: true },
  dreadnought: { segs: [[0.1, 0.04], [0.15, 0.08], [0.6, 0.1], [0.15, 0.12]], fins: true },
  gunship: { segs: [[0.2, 0.1], [0.6, 0.18], [0.2, 0.14]] },
};

// ---- CLASSES ----
// drive: sustained cruise G and maximum G (crew on juice) · armor: points
// (each stops ~12% of a hit) · pdc: point-defense mounts · tubes: torpedo
// tubes · magazine: torpedoes carried {he, nuke} · railgun: mounts ·
// evasive: crew drilled to jink under fire · factions: who flies it (weights)

export const CLASSES = {
  // Civilian
  prospector: {
    name: 'Prospector skiff', role: 'prospector', category: 'civilian', size: 'S', lengthM: 30, massT: 300, crew: [2, 4],
    shape: 'skiff', drive: { cruiseG: 0.5, maxG: 2 }, armor: 0, pdc: 0, tubes: 0, magazine: null, railgun: 0,
    cargoT: 40, berths: 0, tl: [1, 2], factions: { OPA: 6, independent: 3 }, names: 'prospector',
  },
  courier: {
    name: 'Fast courier', role: 'courier', category: 'civilian', size: 'S', lengthM: 40, massT: 600, crew: [2, 3],
    shape: 'needle', drive: { cruiseG: 1, maxG: 6 }, armor: 0, pdc: 0, tubes: 0, magazine: null, railgun: 0,
    cargoT: 10, berths: 4, tl: [2, 3], factions: { UN: 3, MCR: 3, independent: 2 }, names: 'courier',
  },
  shuttle: {
    name: 'Cargo shuttle', role: 'shuttle', category: 'civilian', size: 'S', lengthM: 35, massT: 900, crew: [2, 3],
    shape: 'shuttle', drive: { cruiseG: 0.5, maxG: 2 }, armor: 0, pdc: 0, tubes: 0, magazine: null, railgun: 0,
    cargoT: 400, berths: 6, tl: [1, 2], factions: { OPA: 4, independent: 4, UN: 1 }, names: 'shuttle',
  },
  'light-freighter': {
    name: 'Light freighter', role: 'freighter', category: 'civilian', size: 'M', lengthM: 62, massT: 3500, crew: [3, 8],
    shape: 'freighter', drive: { cruiseG: 1, maxG: 10 }, armor: 1, pdc: 2, tubes: 2, magazine: { he: 2, nuke: 0 }, railgun: 0,
    magazineCap: 6, cargoT: 15, berths: 12, tl: [2, 2], factions: { independent: 4, OPA: 2, UN: 1, MCR: 1 }, names: 'freighter',
    evasive: true,
  },
  freighter: {
    name: 'Bulk freighter', role: 'freighter', category: 'civilian', size: 'L', lengthM: 220, massT: 40_000, crew: [8, 16],
    shape: 'box', drive: { cruiseG: 0.3, maxG: 1 }, armor: 1, pdc: 1, tubes: 0, magazine: null, railgun: 0,
    cargoT: 30_000, berths: 4, tl: [1, 2], factions: { independent: 4, OPA: 3, UN: 2, MCR: 1 }, names: 'freighter',
  },
  'ice-hauler': {
    name: 'Ice hauler', role: 'hauler', category: 'civilian', size: 'XL', lengthM: 1400, massT: 120_000, crew: [25, 50],
    shape: 'hauler', drive: { cruiseG: 0.3, maxG: 1 }, armor: 0, pdc: 0, tubes: 0, magazine: null, railgun: 0,
    cargoT: 100_000, berths: 0, tl: [1, 2], factions: { OPA: 6, independent: 3 }, names: 'hauler',
  },
  tanker: {
    name: 'Tanker', role: 'tanker', category: 'civilian', size: 'L', lengthM: 300, massT: 70_000, crew: [8, 14],
    shape: 'tanker', drive: { cruiseG: 0.3, maxG: 1 }, armor: 0, pdc: 1, tubes: 0, magazine: null, railgun: 0,
    cargoT: 60_000, berths: 0, tl: [1, 2], factions: { independent: 4, OPA: 3, UN: 1 }, names: 'tanker',
  },
  liner: {
    name: 'Passenger liner', role: 'liner', category: 'civilian', size: 'L', lengthM: 350, massT: 120_000, crew: [40, 80],
    shape: 'liner', drive: { cruiseG: 0.5, maxG: 1.5 }, armor: 1, pdc: 2, tubes: 0, magazine: null, railgun: 0,
    cargoT: 2_000, berths: 1500, tl: [2, 3], factions: { UN: 4, MCR: 2, independent: 2 }, names: 'liner',
  },
  'mining-barge': {
    name: 'Mining barge', role: 'miner', category: 'civilian', size: 'L', lengthM: 180, massT: 50_000, crew: [10, 20],
    shape: 'barge', drive: { cruiseG: 0.2, maxG: 0.8 }, armor: 1, pdc: 0, tubes: 0, magazine: null, railgun: 0,
    cargoT: 35_000, berths: 0, tl: [1, 2], factions: { OPA: 6, independent: 2 }, names: 'barge',
  },

  // Authority (police, customs, station security)
  cutter: {
    name: 'Patrol cutter', role: 'patrol', category: 'authority', size: 'M', lengthM: 55, massT: 1800, crew: [6, 10],
    shape: 'wedge', drive: { cruiseG: 1, maxG: 8 }, armor: 1, pdc: 3, tubes: 2, magazine: { he: 4, nuke: 0 }, railgun: 0,
    cargoT: 5, berths: 6, tl: [2, 3], factions: { UN: 3, MCR: 3, OPA: 3 }, names: 'police', evasive: true,
  },

  // Military
  corvette: {
    name: 'Corvette', role: 'warship', category: 'military', size: 'M', lengthM: 46, massT: 2800, crew: [6, 12],
    shape: 'corvette', drive: { cruiseG: 1, maxG: 12 }, armor: 2, pdc: 6, tubes: 2, magazine: { he: 6, nuke: 6 }, railgun: 0,
    cargoT: 5, berths: 0, tl: [3, 4], factions: { UN: 4, MCR: 5 }, names: 'navy', evasive: true,
  },
  frigate: {
    name: 'Frigate', role: 'warship', category: 'military', size: 'M', lengthM: 120, massT: 12_000, crew: [20, 40],
    shape: 'frigate', drive: { cruiseG: 1, maxG: 9 }, armor: 2.5, pdc: 10, tubes: 4, magazine: { he: 12, nuke: 12 }, railgun: 1,
    cargoT: 20, berths: 0, tl: [3, 4], factions: { UN: 4, MCR: 4 }, names: 'navy', evasive: true,
  },
  destroyer: {
    name: 'Destroyer', role: 'warship', category: 'military', size: 'L', lengthM: 220, massT: 40_000, crew: [60, 120],
    shape: 'destroyer', drive: { cruiseG: 1, maxG: 7 }, armor: 3, pdc: 16, tubes: 6, magazine: { he: 16, nuke: 20 }, railgun: 1,
    cargoT: 50, berths: 0, tl: [3, 4], factions: { UN: 4, MCR: 3 }, names: 'navy', evasive: true,
  },
  battleship: {
    name: 'Battleship', role: 'warship', category: 'military', size: 'XL', lengthM: 480, massT: 250_000, crew: [200, 400],
    shape: 'dreadnought', drive: { cruiseG: 0.5, maxG: 5 }, armor: 4, pdc: 36, tubes: 12, magazine: { he: 40, nuke: 80 }, railgun: 2,
    cargoT: 500, berths: 0, tl: [3, 4], factions: { UN: 3, MCR: 3 }, names: 'navy', evasive: true,
  },
  'opa-gunship': {
    name: 'OPA gunship', role: 'warship', category: 'military', size: 'M', lengthM: 90, massT: 8000, crew: [15, 30],
    shape: 'gunship', drive: { cruiseG: 0.5, maxG: 5 }, armor: 1, pdc: 4, tubes: 2, magazine: { he: 6, nuke: 2 }, railgun: 0,
    cargoT: 2000, berths: 20, tl: [1, 2], factions: { OPA: 1 }, names: 'opa', evasive: true,
  },

  // Irregular
  'pirate-raider': {
    name: 'Pirate raider', role: 'pirate', category: 'irregular', size: 'S', lengthM: 35, massT: 700, crew: [3, 6],
    shape: 'needle', drive: { cruiseG: 1, maxG: 7 }, armor: 0.5, pdc: 1, tubes: 2, magazine: { he: 4, nuke: 0 }, railgun: 0,
    cargoT: 20, berths: 2, tl: [1, 2], factions: { pirate: 1 }, names: 'pirate', evasive: true,
  },
  'pirate-gunship': {
    name: 'Pirate gunship', role: 'pirate', category: 'irregular', size: 'M', lengthM: 70, massT: 4000, crew: [6, 12],
    shape: 'gunship', drive: { cruiseG: 0.5, maxG: 5 }, armor: 1, pdc: 2, tubes: 2, magazine: { he: 8, nuke: 0 }, railgun: 0,
    cargoT: 800, berths: 6, tl: [1, 2], factions: { pirate: 1 }, names: 'pirate', evasive: true,
  },
};

export const CLASS_IDS = Object.keys(CLASSES);
export const PLAYER_CLASS = 'light-freighter';

export const classOf = (e) => CLASSES[e?.cls] || null;

/** Display string for a ship: "TL4 MCRN Corvette". */
export function classLabel(e) {
  const c = classOf(e);
  if (!c) return e?.shipClass || 'Ship';
  const navy = c.category === 'military' ? FACTIONS[e.faction]?.navy : null;
  return `${navy ? navy + ' ' : ''}${c.name}`;
}

/** Ships whose crews jink under fire (civilians fly straight and pray). */
export const isEvasive = (c) => !!c?.evasive;

/** A hull's effective target radius (m). */
export const targetRadius = (c) => Math.max(5, c.lengthM * TARGET_RADIUS_FRAC);

// ---- IDENTITY ----

const NAMES = {
  prospector: { pre: ['Lucky', 'Iron', 'Red', 'Dust', 'Last', 'Old'], suf: ['Strike', 'Vein', 'Claim', 'Pick', 'Digger', 'Chance'] },
  courier: { pre: ['Swift', 'Flash', 'Quick', 'Razor', 'Bright'], suf: ['Arrow', 'Dart', 'Wing', 'Bolt', 'Needle'] },
  shuttle: { pre: ['Box', 'Load', 'Haul', 'Bulk', 'Short'], suf: ['Runner', 'Lifter', 'Cart', 'Sled', 'Hop'] },
  freighter: { pre: ['Star', 'Deep', 'Far', 'Void', 'Long'], suf: ['Venture', 'Prospect', 'Horizon', 'Trader', 'Promise'] },
  hauler: { pre: ['Ice', 'Frost', 'Cryo', 'Cold', 'Weeping'], suf: ['Hauler', 'Runner', 'Mule', 'Ox', 'Dray', 'Somnambulist'] },
  tanker: { pre: ['Full', 'Heavy', 'Wet', 'Deep'], suf: ['Tank', 'Belly', 'Drum', 'Well'] },
  liner: { pre: ['Tycho', 'Ceres', 'Eros', 'Luna', 'Ganymede'], suf: ['Star', 'Express', 'Transit', 'Grace', 'Pearl'] },
  barge: { pre: ['Rock', 'Ore', 'Gravel', 'Stone'], suf: ['Breaker', 'Crusher', 'Chewer', 'Grinder'] },
  police: { pre: ['Vigilant', 'Steady', 'Warden', 'Sentry', 'Constant', 'Bulwark'], suf: [''] },
  navy: {
    UN: ['Agatha King', 'Seung Un', 'Ravi', 'Thomas Prince', 'Kittur Chennamma', 'Okimbo', 'Nathan Hale', 'Xiaoling', 'Aravalli', 'Bremen'],
    MCR: ['Scirocco', 'Hammurabi', 'Barkeith', 'Tachi', 'Xuesen', 'Gelan', 'Raptor', 'Dewalt', 'Tolkien', 'Hellion'],
  },
  opa: ['Guy Molinari', 'Connaught', 'Free Belt', 'Pella', 'Behemoth Ghost', 'Lady Kali', 'Dawn Bringer'],
  pirate: ['Black Sky', 'Rust Queen', 'Gutter Saint', 'Bad Debt', 'Knife Season', 'No Return', 'Hungry Dark', 'Low Tide', 'Scavenger King', 'Dead Reckoning'],
};

function rollName(cls, faction) {
  const c = CLASSES[cls];
  const pool = NAMES[c.names];
  if (c.names === 'navy') return `${FACTIONS[faction]?.navy || faction} ${pick(pool[faction] || pool.UN)}`;
  if (c.names === 'opa' || c.names === 'pirate') return pick(pool);
  if (c.names === 'police') return `${FACTIONS[faction]?.short || ''} ${pick(pool.pre)} ${randInt(2, 99)}`.trim();
  return `${pick(pool.pre)} ${pick(pool.suf)}`;
}

/** Tech level a faction fields for a class (clamped to the class's range). */
export function techFor(cls, faction) {
  const c = CLASSES[cls];
  const tech = FACTIONS[faction]?.tech || { civilian: 2 };
  const want = c.category === 'military' ? (tech.navy ?? tech.civilian)
    : c.category === 'authority' ? (tech.police ?? tech.civilian) : tech.civilian;
  return Math.max(c.tl[0], Math.min(c.tl[1], want));
}

/**
 * Roll an identity for a new ship: { cls, name, shipClass, faction, tl, mass }.
 * opts: { cls, category, role, faction, near } — `near` is the faction whose
 * space the ship is in (its own civilians are most common there).
 */
export function rollIdentity(opts = {}) {
  let cls = opts.cls;
  if (!cls) {
    const pool = CLASS_IDS.filter(id => {
      const c = CLASSES[id];
      if (opts.category && c.category !== opts.category) return false;
      if (opts.role && c.role !== opts.role) return false;
      return !opts.faction || !!c.factions[opts.faction];
    });
    cls = weightedPick(pool, id => {
      const f = CLASSES[id].factions;
      return opts.faction ? f[opts.faction] : Object.values(f).reduce((a, b) => a + b, 0);
    });
  }
  const c = CLASSES[cls];
  let faction = opts.faction;
  if (!faction) {
    const ids = Object.keys(c.factions);
    faction = weightedPick(ids, f => c.factions[f] * (opts.near && f === opts.near ? 4 : 1));
  }
  return {
    cls, faction, tl: techFor(cls, faction),
    name: rollName(cls, faction),
    shipClass: c.name,
    mass: Math.round(c.massT * (0.85 + 0.3 * random())),
  };
}

/** Best-guess class for a ship from an old save's class name. */
export function classForName(name = '') {
  const n = name.toLowerCase();
  if (/donnager|truman|battle|dreadnought/.test(n)) return 'battleship';
  if (/destroyer/.test(n)) return 'destroyer';
  if (/frigate/.test(n)) return 'frigate';
  if (/corvette/.test(n)) return 'corvette';
  if (/converted freighter|gunship/.test(n)) return 'opa-gunship';
  if (/canterbury|ice hauler|hauler/.test(n)) return 'ice-hauler';
  if (/tanker/.test(n)) return 'tanker';
  if (/liner/.test(n)) return 'liner';
  if (/barge/.test(n)) return 'mining-barge';
  if (/skiff|prospector/.test(n)) return 'prospector';
  if (/courier/.test(n)) return 'courier';
  if (/shuttle/.test(n)) return 'shuttle';
  if (/freighter/.test(n)) return 'freighter';
  return null;
}
