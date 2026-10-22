// ============================================================
// LONGHAUL — Ship classes, builders and tech levels
//
// Every ship in the world belongs to a class from this catalog, and a
// class is one design from one yard: a Martian Hellas-class frigate,
// an Earth-built Danube, a Belt refit of a forty-year-old hauler. A
// class fixes what the hull is for (its kind), how big it is (size),
// what its drive can do, what it carries
// (armor, point defense, torpedo tubes and magazine, railguns, mining
// gear, cargo and berths) — and how well it is built (tech level).
//
// Who builds a ship decides its tech level, and the tech level decides
// almost everything else about living with it:
//   Mars (TL3 civilian, TL4 navy) builds the best ships in the system.
//     Better sensors, quieter hulls, sharper fire control, machinery that
//     rarely breaks — and when it does, it takes the most parts and the
//     most expensive yard time to put right.
//   Earth (TL2, a few modern TL3 hulls) builds sound, ordinary ships, and
//     most of its fleet is a generation old.
//   The Belt (TL1) flies refurbished hulls and jury-rigged systems. They
//     break all the time, but a Belter fixes them with a wrench and
//     whatever scrap is to hand, and the fix holds.
// The gap is meant to be decisive: a Belt refit does not beat a Martian
// warship of its size (tests/combat.test.mjs prints the duels).
//
// What a ship physically is (its hull in metres, its docking collars,
// its interior) is built from the class in hulls.js and ship-layout.js.
// A crew complement is part of the design: `crew` is the rated range (the
// fewest who can keep watches, the most it berths) and `crewStd` what a
// ship of the class usually carries, so the hull out there has about that
// many people aboard (manifest.js).
//
// Civilian hulls are built for their trade and carry no weapons. The
// exceptions are named: liners carry two anti-debris PDCs by law, the
// armed light freighter has a self-defense fit, and mining ships can turn
// their rock-cracking gear on a hull that comes close enough.
//
// A navy's hulls are military kit: flying one takes that navy's license
// (service.js); a `stolen` one no license covers. A ship's identity
// (rollIdentity) is its class, its flag, its sub-faction (factions.js)
// and its name (names.js: unique in a game).
// ============================================================

import { random, pick, randInt, weightedPick } from '../core/rng.js';
import { FACTIONS, pickSub } from './factions.js';
import { shipName } from './names.js';

// ---- TECH LEVELS ----
// Combat: sensors (detection range ×), stealth (own signature ×), armor
// (points over the class rating), fireControl (PDC fire-control factor ×:
// radar, gun laying, the targeting AI), evade (jinking G ×), counterBurn
// (the fire-control computer turns the ship away from inbound torpedoes,
// agents.js — anything better than jury-rigged kit plots the threat axis).
// Upkeep: wear (integrity lost ×), mtbf (time between faults ×), parts
// (spares per repair or service ×), repairTime (hands-on minutes ×),
// patchHours (how long a jury-rig holds), price (yard labour and spares ×),
// condition (integrity range a ship of this TL is found in).

export const TECH = {
  1: {
    label: 'TL1', name: 'Jury-rigged', sensors: 0.7, stealth: 1.2, armor: 0, fireControl: 0.8, evade: 0.8, counterBurn: false,
    wear: 1.5, mtbf: 0.5, parts: 0.5, repairTime: 0.7, patchHours: [48, 120], price: 0.6, condition: [62, 85],
  },
  2: {
    label: 'TL2', name: 'Commercial', sensors: 1.0, stealth: 1.0, armor: 0, fireControl: 1, evade: 1, counterBurn: true,
    wear: 1, mtbf: 1, parts: 1, repairTime: 1, patchHours: [12, 36], price: 1, condition: [88, 100],
  },
  3: {
    label: 'TL3', name: 'Naval', sensors: 1.3, stealth: 0.8, armor: 0.5, fireControl: 1.15, evade: 1.1, counterBurn: true,
    wear: 0.75, mtbf: 1.6, parts: 1.6, repairTime: 1.25, patchHours: [8, 24], price: 1.6, condition: [92, 100],
  },
  4: {
    label: 'TL4', name: 'Advanced naval', sensors: 1.6, stealth: 0.55, armor: 1, fireControl: 1.3, evade: 1.2, counterBurn: true,
    wear: 0.55, mtbf: 2.4, parts: 2.4, repairTime: 1.5, patchHours: [4, 12], price: 2.5, condition: [95, 100],
  },
};

/** Who designs and builds ships (a class's `builder`). */
export const BUILDERS = {
  MCR: { name: 'Martian yards', short: 'MARS' },
  UN: { name: 'Earth & Luna yards', short: 'EARTH' },
  independent: { name: 'Independent yards', short: 'IND' },
  Belt: { name: 'Belt refit', short: 'BELT' },
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

/**
 * Structure by build: warships are compartmentalized and spall-lined, police
 * hulls a little; a civilian hull of the same size is just a hull.
 */
export const BUILD = { civilian: 1, irregular: 1, authority: 1.2, military: 1.5 };

// ---- KINDS ----
// What a hull is for. Every kind is built by more than one yard.

export const KINDS = {
  prospector: 'Prospector', courier: 'Courier', shuttle: 'Cargo shuttle', 'light-freighter': 'Light freighter',
  freighter: 'Bulk freighter', hauler: 'Ice hauler', tanker: 'Tanker', liner: 'Liner', miner: 'Mining ship',
  cutter: 'Patrol cutter', corvette: 'Corvette', frigate: 'Frigate', destroyer: 'Destroyer', battleship: 'Battleship',
  gunship: 'Gunship', raider: 'Raider',
};

// ---- CLASSES ----
// kind · builder · tl · category · size · lengthM · massT · crew [min, max]
// and crewStd (the usual complement) · atmo: rated for atmospheric entry
// ({ entry: 'belly' a lifting body on a ceramic belly | 'tail' a tail-sitter
// behind a shield ring, landing }) — only a few hulls are
// drive: sustained cruise G and maximum G (crew on juice) · armor: points
// (each stops ~12% of a hit) · pdc: point-defense mounts · tubes: torpedo
// tubes · magazine: torpedoes carried {he, nuke} (magazineCap: room for
// more) · railgun: mounts · gear: mining gear that can be turned on a hull
// ({ type, mounts }, weapons.js) · evasive: crew drilled to jink under
// fire · factions: who flies it (weights) · desc: the yard's pitch.

const UNARMED = { armor: 0, pdc: 0, tubes: 0, magazine: null, railgun: 0 };

export const CLASSES = {
  // ---------------- Civilian ----------------
  rockhopper: {
    name: 'Rockhopper prospecting skiff', kind: 'prospector', builder: 'Belt', tl: 1, category: 'civilian', size: 'S',
    lengthM: 28, massT: 260, crew: [1, 3], crewStd: 2, drive: { cruiseG: 0.5, maxG: 2 }, ...UNARMED,
    gear: { type: 'charges', mounts: 1 }, cargoT: 40, berths: 0, factions: { OPA: 8, independent: 2 }, names: 'prospector',
    desc: 'Forty years old, four owners, held together with sealant and stubbornness. It breaks every week and anyone with a wrench can fix it. Its rock-cracking charges will hurt a ship that comes within a few kilometres.',
  },
  kestrel: {
    name: 'Kestrel survey skiff', kind: 'prospector', builder: 'UN', tl: 2, category: 'civilian', size: 'S',
    lengthM: 32, massT: 320, crew: [2, 4], crewStd: 3, drive: { cruiseG: 0.7, maxG: 3 }, ...UNARMED,
    cargoT: 50, berths: 0, factions: { independent: 4, UN: 3, OPA: 1 }, names: 'prospector',
    desc: 'A Luna-built survey skiff: decent sensors, a reliable drive, a hold for samples. Unarmed.',
  },
  arsia: {
    name: 'Arsia survey skiff', kind: 'prospector', builder: 'MCR', tl: 3, category: 'civilian', size: 'S',
    lengthM: 30, massT: 300, crew: [2, 3], crewStd: 2, drive: { cruiseG: 1, maxG: 5 }, ...UNARMED,
    cargoT: 35, berths: 0, factions: { MCR: 4, independent: 1 }, names: 'prospector',
    desc: 'Martian survey skiff with naval-grade sensors and a quiet hull. It rarely breaks; when it does, the parts are dear. Unarmed.',
  },
  dart: {
    name: 'Dart courier (Belt refit)', kind: 'courier', builder: 'Belt', tl: 1, category: 'civilian', size: 'S',
    lengthM: 38, massT: 550, crew: [1, 3], crewStd: 2, drive: { cruiseG: 1, maxG: 5 }, ...UNARMED,
    cargoT: 8, berths: 2, factions: { OPA: 5, independent: 2 }, names: 'courier',
    desc: 'A stripped racing hull with a drive that runs hot. Fast enough, while it holds together. Unarmed.',
  },
  hermes: {
    name: 'Hermes-pattern courier', kind: 'courier', builder: 'UN', tl: 2, category: 'civilian', size: 'S',
    lengthM: 40, massT: 600, crew: [2, 3], crewStd: 2, atmo: { entry: 'belly', shield: 'ceramic tiles', landing: 'skids' }, drive: { cruiseG: 1, maxG: 6 }, ...UNARMED,
    cargoT: 10, berths: 4, factions: { UN: 4, independent: 3 }, names: 'courier',
    desc: 'The inner system\'s standard fast packet: mail, small freight, a few passengers in a hurry. Unarmed.',
  },
  phobos: {
    name: 'Phobos express courier', kind: 'courier', builder: 'MCR', tl: 3, category: 'civilian', size: 'S',
    lengthM: 42, massT: 620, crew: [2, 3], crewStd: 2, drive: { cruiseG: 1.5, maxG: 8 }, ...UNARMED,
    cargoT: 10, berths: 4, factions: { MCR: 4, independent: 1 }, names: 'courier',
    desc: 'The fastest civilian hull in the system and priced like it. Unarmed.',
  },
  mule: {
    name: 'Mule cargo shuttle', kind: 'shuttle', builder: 'Belt', tl: 1, category: 'civilian', size: 'S',
    lengthM: 35, massT: 900, crew: [1, 3], crewStd: 2, drive: { cruiseG: 0.5, maxG: 2 }, ...UNARMED,
    cargoT: 400, berths: 6, factions: { OPA: 5, independent: 3 }, names: 'shuttle',
    desc: 'A box with a drive. Every rock in the Belt has three of them. Unarmed.',
  },
  ascension: {
    name: 'Ascension cargo shuttle', kind: 'shuttle', builder: 'UN', tl: 2, category: 'civilian', size: 'S',
    lengthM: 36, massT: 950, crew: [2, 3], crewStd: 2, atmo: { entry: 'belly', shield: 'ceramic tiles', landing: 'skids' }, drive: { cruiseG: 0.6, maxG: 3 }, ...UNARMED,
    cargoT: 380, berths: 8, factions: { UN: 4, independent: 2 }, names: 'shuttle',
    desc: 'Luna-built lighter, the workhorse of every Earth-side port. Unarmed.',
  },
  deimos: {
    name: 'Deimos lighter', kind: 'shuttle', builder: 'MCR', tl: 3, category: 'civilian', size: 'S',
    lengthM: 34, massT: 850, crew: [2, 3], crewStd: 2, atmo: { entry: 'belly', shield: 'ceramic tiles', landing: 'skids' }, drive: { cruiseG: 1, maxG: 4 }, ...UNARMED,
    cargoT: 320, berths: 6, factions: { MCR: 4 }, names: 'shuttle',
    desc: 'A Martian orbital lighter: less hold, more drive, very little maintenance. Unarmed.',
  },
  tramp: {
    name: 'Tramp freighter (Belt refit)', kind: 'light-freighter', builder: 'Belt', tl: 1, category: 'civilian', size: 'M',
    lengthM: 58, massT: 3200, crew: [2, 6], crewStd: 4, drive: { cruiseG: 0.7, maxG: 6 }, ...UNARMED, armor: 0.5,
    cargoT: 18, berths: 8, factions: { OPA: 6, independent: 2 }, names: 'freighter',
    desc: 'Third-hand inner-system freighter, rebuilt at Ceres from two wrecks. Cheap to run and cheap to fix, and it needs fixing. Unarmed.',
  },
  'light-freighter': {
    name: 'Armed light freighter', kind: 'light-freighter', builder: 'independent', tl: 2, category: 'civilian', size: 'M',
    lengthM: 62, massT: 3500, crew: [3, 8], crewStd: 5, drive: { cruiseG: 1, maxG: 10 },
    armor: 1, pdc: 2, tubes: 2, magazine: { he: 2, nuke: 0 }, magazineCap: 6, railgun: 0,
    cargoT: 15, berths: 12, factions: { independent: 4, OPA: 1, UN: 1, MCR: 1 }, names: 'freighter', evasive: true,
    desc: 'Ganymede-built, with two PDCs and a pair of torpedo tubes on a self-defense license. Fast, tough for its size, and the closest thing to a warship a private captain can own.',
  },
  meridian: {
    name: 'Meridian light freighter', kind: 'light-freighter', builder: 'UN', tl: 2, category: 'civilian', size: 'M',
    lengthM: 64, massT: 3600, crew: [3, 6], crewStd: 4, drive: { cruiseG: 1, maxG: 7 }, ...UNARMED, armor: 1,
    cargoT: 25, berths: 10, factions: { UN: 4, independent: 3 }, names: 'freighter',
    desc: 'The commonest small freighter in the inner system: roomy hold, honest drive, no guns.',
  },
  ares: {
    name: 'Ares fast freighter', kind: 'light-freighter', builder: 'MCR', tl: 3, category: 'civilian', size: 'M',
    lengthM: 60, massT: 3300, crew: [3, 6], crewStd: 4, drive: { cruiseG: 1.2, maxG: 9 }, ...UNARMED, armor: 1,
    cargoT: 18, berths: 8, factions: { MCR: 3, independent: 1 }, names: 'freighter',
    desc: 'Martian fast freighter: naval sensors, a quiet hull, machinery that lasts. Unarmed, and it costs a fortune to keep in spares.',
  },
  'ore-scow': {
    name: 'Ore scow', kind: 'freighter', builder: 'Belt', tl: 1, category: 'civilian', size: 'L',
    lengthM: 200, massT: 36_000, crew: [6, 12], crewStd: 8, drive: { cruiseG: 0.2, maxG: 0.8 }, ...UNARMED, armor: 0.5,
    cargoT: 26_000, berths: 0, factions: { OPA: 6, independent: 2 }, names: 'freighter',
    desc: 'A bulk hull that has been patched more often than it has been painted.',
  },
  freighter: {
    name: 'Bulk freighter', kind: 'freighter', builder: 'UN', tl: 2, category: 'civilian', size: 'L',
    lengthM: 220, massT: 40_000, crew: [8, 16], crewStd: 10, drive: { cruiseG: 0.3, maxG: 1 }, ...UNARMED, armor: 1,
    cargoT: 30_000, berths: 4, factions: { UN: 4, independent: 4, OPA: 1 }, names: 'freighter',
    desc: 'The system\'s trade rides in these.',
  },
  'tharsis-bulk': {
    name: 'Tharsis bulk carrier', kind: 'freighter', builder: 'MCR', tl: 3, category: 'civilian', size: 'L',
    lengthM: 230, massT: 38_000, crew: [6, 12], crewStd: 8, drive: { cruiseG: 0.4, maxG: 1.5 }, ...UNARMED, armor: 1,
    cargoT: 28_000, berths: 4, factions: { MCR: 4, independent: 1 }, names: 'freighter',
    desc: 'Martian bulk carrier: a smaller crew, a faster drive, a smaller hold.',
  },
  'ice-hauler': {
    name: 'Ice hauler', kind: 'hauler', builder: 'Belt', tl: 1, category: 'civilian', size: 'XL',
    lengthM: 1400, massT: 120_000, crew: [25, 50], crewStd: 35, drive: { cruiseG: 0.3, maxG: 1 }, ...UNARMED,
    cargoT: 100_000, berths: 0, factions: { OPA: 6, independent: 3 }, names: 'hauler',
    desc: 'A kilometre and a half of ice and girders, older than most of its crew.',
  },
  'water-carrier': {
    name: 'Aquarius water carrier', kind: 'hauler', builder: 'UN', tl: 2, category: 'civilian', size: 'XL',
    lengthM: 1200, massT: 110_000, crew: [20, 40], crewStd: 28, drive: { cruiseG: 0.3, maxG: 1.2 }, ...UNARMED,
    cargoT: 90_000, berths: 0, factions: { UN: 3, independent: 2, MCR: 1 }, names: 'hauler',
    desc: 'Earth-built ice carrier on the Saturn–inner system run.',
  },
  'belt-tanker': {
    name: 'Belt tanker', kind: 'tanker', builder: 'Belt', tl: 1, category: 'civilian', size: 'L',
    lengthM: 280, massT: 65_000, crew: [6, 12], crewStd: 8, drive: { cruiseG: 0.25, maxG: 0.8 }, ...UNARMED,
    cargoT: 55_000, berths: 0, factions: { OPA: 5, independent: 2 }, names: 'tanker',
    desc: 'Volatiles in mismatched tanks welded to a salvaged spine.',
  },
  tanker: {
    name: 'Reaction-mass tanker', kind: 'tanker', builder: 'UN', tl: 2, category: 'civilian', size: 'L',
    lengthM: 300, massT: 70_000, crew: [8, 14], crewStd: 10, drive: { cruiseG: 0.3, maxG: 1 }, ...UNARMED,
    cargoT: 60_000, berths: 0, factions: { UN: 3, independent: 3, MCR: 1 }, names: 'tanker',
    desc: 'Reaction mass for the inner system\'s fleets.',
  },
  'colony-ship': {
    name: 'Colony transport (Belt refit)', kind: 'liner', builder: 'Belt', tl: 1, category: 'civilian', size: 'L',
    lengthM: 380, massT: 130_000, crew: [30, 60], crewStd: 45, drive: { cruiseG: 0.3, maxG: 1 }, ...UNARMED,
    cargoT: 3_000, berths: 2500, factions: { OPA: 3, independent: 1 }, names: 'liner',
    desc: 'Settlers bound outward, in bunks stacked six high. Unarmed.',
  },
  liner: {
    name: 'Passenger liner', kind: 'liner', builder: 'UN', tl: 2, category: 'civilian', size: 'L',
    lengthM: 350, massT: 120_000, crew: [40, 80], crewStd: 60, drive: { cruiseG: 0.5, maxG: 1.5 },
    armor: 1, pdc: 2, tubes: 0, magazine: null, railgun: 0,
    cargoT: 2_000, berths: 1500, factions: { UN: 4, independent: 2 }, names: 'liner',
    desc: 'Spin-ring liner. Two anti-debris PDCs, as passenger law requires.',
  },
  'valles-liner': {
    name: 'Valles Express liner', kind: 'liner', builder: 'MCR', tl: 3, category: 'civilian', size: 'L',
    lengthM: 330, massT: 110_000, crew: [40, 70], crewStd: 52, drive: { cruiseG: 0.7, maxG: 2 },
    armor: 1, pdc: 2, tubes: 0, magazine: null, railgun: 0,
    cargoT: 1_500, berths: 1200, factions: { MCR: 3, independent: 1 }, names: 'liner',
    desc: 'Martian liner: fewer berths, a faster passage, two anti-debris PDCs.',
  },
  'mining-barge': {
    name: 'Mining barge', kind: 'miner', builder: 'Belt', tl: 1, category: 'civilian', size: 'L',
    lengthM: 180, massT: 50_000, crew: [10, 20], crewStd: 14, drive: { cruiseG: 0.2, maxG: 0.8 }, ...UNARMED, armor: 1,
    gear: { type: 'driver', mounts: 2 }, cargoT: 35_000, berths: 0, factions: { OPA: 6, independent: 2 }, names: 'barge',
    desc: 'Rock-chewer with two ore mass drivers. They were never meant to be aimed at anything that moves.',
  },
  'mining-tender': {
    name: 'Mining tender', kind: 'miner', builder: 'UN', tl: 2, category: 'civilian', size: 'L',
    lengthM: 170, massT: 45_000, crew: [8, 16], crewStd: 11, drive: { cruiseG: 0.3, maxG: 1 }, ...UNARMED, armor: 1,
    gear: { type: 'driver', mounts: 1 }, cargoT: 30_000, berths: 0, factions: { independent: 3, UN: 2 }, names: 'barge',
    desc: 'Corporate mining tender with one ore mass driver.',
  },
  'pallas-refiner': {
    name: 'Pallas ore processor', kind: 'miner', builder: 'MCR', tl: 3, category: 'civilian', size: 'L',
    lengthM: 200, massT: 52_000, crew: [8, 14], crewStd: 11, drive: { cruiseG: 0.3, maxG: 1.2 }, ...UNARMED, armor: 1.5,
    gear: { type: 'driver', mounts: 2 }, cargoT: 32_000, berths: 0, factions: { MCR: 3 }, names: 'barge',
    desc: 'A Martian refinery ship, two ore mass drivers and a smelter.',
  },

  // ---------------- Authority (police, customs, station security) ----------------
  'belt-cutter': {
    name: 'Militia cutter (Belt refit)', kind: 'cutter', builder: 'Belt', tl: 1, category: 'authority', size: 'M',
    lengthM: 52, massT: 1700, crew: [4, 9], crewStd: 6, drive: { cruiseG: 0.8, maxG: 6 },
    armor: 0.5, pdc: 2, tubes: 2, magazine: { he: 4, nuke: 0 }, railgun: 0,
    cargoT: 5, berths: 6, factions: { OPA: 3 }, names: 'police', evasive: true,
    desc: 'Star Helix\'s cheapest hulls: an old shuttle with two salvaged PDCs and a pair of tubes bolted on.',
  },
  cutter: {
    name: 'Patrol cutter', kind: 'cutter', builder: 'UN', tl: 2, category: 'authority', size: 'M',
    lengthM: 55, massT: 1800, crew: [6, 10], crewStd: 8, drive: { cruiseG: 1, maxG: 8 },
    armor: 1, pdc: 3, tubes: 2, magazine: { he: 4, nuke: 0 }, railgun: 0,
    cargoT: 5, berths: 6, factions: { UN: 4, OPA: 2 }, names: 'police', evasive: true,
    desc: 'The UN\'s standard customs and police cutter, sold on second-hand to every security contractor in the Belt.',
  },
  'mcr-cutter': {
    name: 'Martian Security cutter', kind: 'cutter', builder: 'MCR', tl: 3, category: 'authority', size: 'M',
    lengthM: 55, massT: 1800, crew: [6, 10], crewStd: 8, drive: { cruiseG: 1, maxG: 9 },
    armor: 1.5, pdc: 4, tubes: 2, magazine: { he: 6, nuke: 0 }, railgun: 0,
    cargoT: 5, berths: 6, factions: { MCR: 4 }, names: 'police', evasive: true,
    desc: 'Martian police cutter, built to navy standards.',
  },

  // ---------------- Military ----------------
  'opa-corvette': {
    name: 'Refit corvette (ex-UNN Harrier)', kind: 'corvette', builder: 'Belt', tl: 1, category: 'military', size: 'M',
    lengthM: 50, massT: 2900, crew: [5, 12], crewStd: 8, drive: { cruiseG: 0.8, maxG: 8 },
    armor: 1.5, pdc: 3, tubes: 2, magazine: { he: 4, nuke: 2 }, railgun: 0,
    cargoT: 10, berths: 4, factions: { OPA: 3 }, names: 'opa', evasive: true,
    desc: 'A decommissioned UNN corvette bought for scrap and rebuilt at Tycho with salvaged PDCs. It fights; it does not win against a navy.',
  },
  'unn-corvette': {
    name: 'Harrier-class corvette', kind: 'corvette', builder: 'UN', tl: 2, category: 'military', size: 'M',
    lengthM: 50, massT: 2900, crew: [6, 12], crewStd: 10, atmo: { entry: 'tail', shield: 'ablative ring', landing: 'legs' }, drive: { cruiseG: 1, maxG: 9 },
    armor: 2, pdc: 4, tubes: 2, magazine: { he: 6, nuke: 4 }, railgun: 0,
    cargoT: 5, berths: 0, factions: { UN: 5 }, names: 'navy', evasive: true,
    desc: 'The UNN\'s numerous, thirty-year-old patrol corvette.',
  },
  'mcrn-corvette': {
    name: 'Tharsis-class corvette', kind: 'corvette', builder: 'MCR', tl: 4, category: 'military', size: 'M',
    lengthM: 46, massT: 2800, crew: [6, 12], crewStd: 9, atmo: { entry: 'tail', shield: 'ablative ring', landing: 'legs' }, drive: { cruiseG: 1, maxG: 12 },
    armor: 2, pdc: 6, tubes: 2, magazine: { he: 6, nuke: 6 }, railgun: 0,
    cargoT: 5, berths: 0, factions: { MCR: 5 }, names: 'navy', evasive: true,
    desc: 'Martian fast-attack corvette: six TL4 PDCs, a 12G drive and a stealthy hull.',
  },
  'pirate-corvette': {
    name: 'Stolen corvette (ex-UNN Harrier)', kind: 'corvette', builder: 'UN', tl: 2, category: 'irregular', size: 'M', stolen: 'UN',
    lengthM: 50, massT: 2900, crew: [5, 10], crewStd: 7, drive: { cruiseG: 1, maxG: 8 },
    armor: 2, pdc: 3, tubes: 2, magazine: { he: 6, nuke: 0 }, railgun: 0,
    cargoT: 60, berths: 4, factions: { pirate: 1 }, names: 'pirate', evasive: true,
    desc: 'A navy hull that went missing from a Luna scrapyard. One PDC was stripped for parts.',
  },
  'opa-frigate': {
    name: 'Refit frigate (ex-UNN Danube)', kind: 'frigate', builder: 'Belt', tl: 1, category: 'military', size: 'M',
    lengthM: 125, massT: 12_500, crew: [20, 40], crewStd: 28, drive: { cruiseG: 0.6, maxG: 6 },
    armor: 2, pdc: 5, tubes: 3, magazine: { he: 8, nuke: 4 }, railgun: 0,
    cargoT: 100, berths: 10, factions: { OPA: 1 }, names: 'opa', evasive: true,
    desc: 'The OPA\'s pride: an old UNN frigate with its railgun gone and half its PDCs replaced by whatever Tycho could make.',
  },
  'unn-frigate': {
    name: 'Danube-class frigate', kind: 'frigate', builder: 'UN', tl: 2, category: 'military', size: 'M',
    lengthM: 125, massT: 12_500, crew: [20, 40], crewStd: 32, drive: { cruiseG: 1, maxG: 7 },
    armor: 2.5, pdc: 8, tubes: 4, magazine: { he: 12, nuke: 8 }, railgun: 1,
    cargoT: 20, berths: 0, factions: { UN: 5 }, names: 'navy', evasive: true,
    desc: 'The backbone of the UN Navy, a generation old.',
  },
  'unn-frigate-new': {
    name: 'Everest-class frigate', kind: 'frigate', builder: 'UN', tl: 3, category: 'military', size: 'M',
    lengthM: 120, massT: 12_000, crew: [20, 40], crewStd: 30, drive: { cruiseG: 1, maxG: 9 },
    armor: 2.5, pdc: 10, tubes: 4, magazine: { he: 12, nuke: 12 }, railgun: 1,
    cargoT: 20, berths: 0, factions: { UN: 2 }, names: 'navy', evasive: true,
    desc: 'Earth\'s modern frigate: few in number, the equal of anything but Mars.',
  },
  'mcrn-frigate': {
    name: 'Hellas-class frigate', kind: 'frigate', builder: 'MCR', tl: 4, category: 'military', size: 'M',
    lengthM: 120, massT: 12_000, crew: [20, 40], crewStd: 26, drive: { cruiseG: 1, maxG: 10 },
    armor: 3, pdc: 12, tubes: 4, magazine: { he: 12, nuke: 12 }, railgun: 1,
    cargoT: 20, berths: 0, factions: { MCR: 4 }, names: 'navy', evasive: true,
    desc: 'The best frigate in the system: twelve TL4 PDCs, a keel railgun and a hull that hardly shows on radar.',
  },
  'unn-destroyer': {
    name: 'Atlas-class destroyer', kind: 'destroyer', builder: 'UN', tl: 2, category: 'military', size: 'L',
    lengthM: 230, massT: 42_000, crew: [60, 120], crewStd: 90, drive: { cruiseG: 1, maxG: 6 },
    armor: 3, pdc: 14, tubes: 6, magazine: { he: 16, nuke: 16 }, railgun: 1,
    cargoT: 50, berths: 0, factions: { UN: 3 }, names: 'navy', evasive: true,
    desc: 'UNN destroyer, refitted twice and due for a third.',
  },
  'mcrn-destroyer': {
    name: 'Valles-class destroyer', kind: 'destroyer', builder: 'MCR', tl: 4, category: 'military', size: 'L',
    lengthM: 220, massT: 40_000, crew: [60, 120], crewStd: 80, drive: { cruiseG: 1, maxG: 8 },
    armor: 3.5, pdc: 18, tubes: 6, magazine: { he: 16, nuke: 20 }, railgun: 2,
    cargoT: 50, berths: 0, factions: { MCR: 3 }, names: 'navy', evasive: true,
    desc: 'Martian destroyer with two railguns.',
  },
  'unn-battleship': {
    name: 'Leviathan-class battleship', kind: 'battleship', builder: 'UN', tl: 3, category: 'military', size: 'XL',
    lengthM: 500, massT: 260_000, crew: [200, 400], crewStd: 320, drive: { cruiseG: 0.5, maxG: 4 },
    armor: 4, pdc: 32, tubes: 12, magazine: { he: 40, nuke: 60 }, railgun: 2,
    cargoT: 500, berths: 0, factions: { UN: 3 }, names: 'navy', evasive: true,
    desc: 'Earth spends on its capital ships what it saves on everything else.',
  },
  'mcrn-battleship': {
    name: 'Olympus-class battleship', kind: 'battleship', builder: 'MCR', tl: 4, category: 'military', size: 'XL',
    lengthM: 480, massT: 250_000, crew: [200, 400], crewStd: 280, drive: { cruiseG: 0.5, maxG: 5 },
    armor: 4.5, pdc: 40, tubes: 12, magazine: { he: 40, nuke: 80 }, railgun: 3,
    cargoT: 500, berths: 0, factions: { MCR: 3 }, names: 'navy', evasive: true,
    desc: 'The flagship class of the Martian Navy.',
  },
  'opa-gunship': {
    name: 'Converted-freighter gunship', kind: 'gunship', builder: 'Belt', tl: 1, category: 'military', size: 'M',
    lengthM: 90, massT: 8000, crew: [15, 30], crewStd: 20, drive: { cruiseG: 0.5, maxG: 5 },
    armor: 1, pdc: 4, tubes: 2, magazine: { he: 6, nuke: 2 }, railgun: 0,
    cargoT: 2000, berths: 20, factions: { OPA: 1 }, names: 'opa', evasive: true,
    desc: 'A freighter with guns welded to it, flown by people who mean it.',
  },

  // ---------------- Irregular ----------------
  'pirate-gunship': {
    name: 'Pirate gunship', kind: 'gunship', builder: 'Belt', tl: 1, category: 'irregular', size: 'M',
    lengthM: 70, massT: 4000, crew: [6, 12], crewStd: 8, drive: { cruiseG: 0.5, maxG: 5 },
    armor: 1, pdc: 2, tubes: 2, magazine: { he: 8, nuke: 0 }, railgun: 0,
    cargoT: 800, berths: 6, factions: { pirate: 3 }, names: 'pirate', evasive: true,
    desc: 'A small freighter with two PDCs and tubes. Enough to frighten a hauler.',
  },
  'pirate-raider': {
    name: 'Torch raider', kind: 'raider', builder: 'Belt', tl: 1, category: 'irregular', size: 'S',
    lengthM: 35, massT: 700, crew: [3, 6], crewStd: 4, drive: { cruiseG: 1, maxG: 7 },
    armor: 0.5, pdc: 1, tubes: 2, magazine: { he: 4, nuke: 0 }, railgun: 0,
    cargoT: 20, berths: 2, factions: { pirate: 6 }, names: 'pirate', evasive: true,
    desc: 'A racing hull with tubes: hit, take, and run.',
  },
  'pirate-runner': {
    name: 'Armed runner (stolen courier)', kind: 'raider', builder: 'UN', tl: 2, category: 'irregular', size: 'S',
    lengthM: 40, massT: 620, crew: [2, 5], crewStd: 3, atmo: { entry: 'belly', shield: 'ceramic tiles', landing: 'skids' }, drive: { cruiseG: 1, maxG: 6 },
    armor: 0.5, pdc: 1, tubes: 1, magazine: { he: 3, nuke: 0 }, railgun: 0,
    cargoT: 10, berths: 2, factions: { pirate: 3 }, names: 'pirate', evasive: true,
    desc: 'A Hermes courier with a tube where the mail hold was.',
  },
};

export const CLASS_IDS = Object.keys(CLASSES);
export const PLAYER_CLASS = 'light-freighter';

/**
 * Classes a crew of eight or fewer can run are ours to choose (each has an
 * interior: ship-layout.js); we can sign on up to the class's berthed
 * maximum, and never more than PLAYER_MAX_CREW.
 */
export const PLAYABLE_MIN_CREW = 8;
export const PLAYER_MAX_CREW = 12;
export const PLAYABLE = CLASS_IDS.filter(id => {
  const c = CLASSES[id];
  return c.crew[0] <= PLAYABLE_MIN_CREW && (c.size === 'S' || c.size === 'M');
});

/** The most crew our ship of this class can berth. */
export const maxCrew = (classId) => Math.min(PLAYER_MAX_CREW, CLASSES[classId]?.crew[1] ?? PLAYER_MAX_CREW);

export const classOf = (e) => CLASSES[e?.cls] || null;

/** Display string for a ship: "MCRN Hellas-class frigate". */
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

/** Structure in damage points: size, and how it was built. */
export const hullPoints = (c) => Math.round(SIZES[c.size].hp * (BUILD[c.category] ?? 1));

/** Drives are rated for 70% of their maximum: past that, overdriven (flight.js). */
export const ratedG = (c) => c.drive.maxG * 0.7;

/** Our ship's class. */
export const playerClass = (state) => CLASSES[state.ship?.classId] || CLASSES[PLAYER_CLASS];

/** Does the class carry anything that can hurt another ship? */
export const isArmed = (c) => !!c && (c.pdc > 0 || c.tubes > 0 || c.railgun > 0 || !!c.gear);

// ---- IDENTITY ----

/**
 * A name for a new hull: from the class's culture and trade, its power and
 * sub-faction (names.js); with a game state, one no ship in that game has
 * had.
 */
function rollName(cls, faction, sub, state) {
  const c = CLASSES[cls];
  return shipName(state || null, { cls, kind: c.kind, category: c.category, names: c.names, faction, sub });
}

/** Tech level of a class: fixed by the yard that builds it. (`faction` is kept for old callers.) */
export const techFor = (cls, _faction) => CLASSES[cls]?.tl ?? 2;

function classPool(opts) {
  return CLASS_IDS.filter(id => {
    const c = CLASSES[id];
    if (opts.category && c.category !== opts.category) return false;
    if (opts.kind && c.kind !== opts.kind) return false;
    return !opts.faction || !!c.factions[opts.faction];
  });
}

/**
 * Roll an identity for a new ship: { cls, name, shipClass, faction, tl, mass }.
 * opts: { cls, kind, category, faction, near, sub, state } — `kind` asks for a type of
 * ship (a frigate) and lets the faction pick its own design; `near` is the
 * faction whose space the ship is in (its own civilians are most common there).
 * A faction that builds nothing of that kind fields the nearest thing it has.
 * `sub` puts it under a sub-faction (else one is drawn by the class's
 * category); with `state`, its name is one nobody in that game has had.
 */
export function rollIdentity(opts = {}) {
  let cls = opts.cls;
  if (!cls) {
    let pool = classPool(opts);
    if (!pool.length && opts.faction) pool = classPool({ category: opts.category, faction: opts.faction });
    if (!pool.length) pool = classPool({ category: opts.category, kind: opts.kind });
    cls = weightedPick(pool, id => {
      const f = CLASSES[id].factions;
      return opts.faction ? (f[opts.faction] || 1) : Object.values(f).reduce((a, b) => a + b, 0);
    });
  }
  const c = CLASSES[cls];
  let faction = opts.faction;
  if (!faction) {
    const ids = Object.keys(c.factions);
    faction = weightedPick(ids, f => c.factions[f] * (opts.near && f === opts.near ? 4 : 1));
  }
  // Who it flies under within its power (null: a private owner): factions.js
  const sub = opts.sub !== undefined ? opts.sub : pickSub(faction, c.category, random());
  return {
    cls, faction, tl: c.tl, sub,
    name: rollName(cls, faction, sub, opts.state),
    shipClass: c.name,
    mass: Math.round(c.massT * (0.85 + 0.3 * random())),
  };
}
