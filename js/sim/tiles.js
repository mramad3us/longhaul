// ============================================================
// LONGHAUL — Ship tile types (data only; art lives in svg-icons.js)
// ============================================================

export const TileType = {
  EMPTY: 0,
  HULL_WALL: 1,
  INTERIOR_WALL: 2,
  FLOOR: 3,
  DOOR: 4,
  LADDER: 5,
  CONSOLE: 6,
  BUNK: 7,
  TABLE: 8,
  ENGINE: 9,
  REACTOR: 10,
  STORAGE: 11,
  LIFE_SUPPORT: 12,
  AIRLOCK: 13,
  MEDBAY: 14,
  NAV_CONSOLE: 15,
  CRASH_COUCH: 16,
  TERMINAL: 17,
  EVA_LOCKER: 18,
  RADIO: 19,
  TRANSPONDER: 20,
};

export const TILE_NAMES = {
  [TileType.HULL_WALL]: 'Hull Wall',
  [TileType.INTERIOR_WALL]: 'Interior Wall',
  [TileType.FLOOR]: 'Floor',
  [TileType.DOOR]: 'Door',
  [TileType.LADDER]: 'Ladder',
  [TileType.CONSOLE]: 'Console',
  [TileType.BUNK]: 'Bunk',
  [TileType.TABLE]: 'Table',
  [TileType.ENGINE]: 'Epstein Drive',
  [TileType.REACTOR]: 'Fusion Reactor',
  [TileType.STORAGE]: 'Storage Bay',
  [TileType.LIFE_SUPPORT]: 'Life Support',
  [TileType.AIRLOCK]: 'Airlock',
  [TileType.MEDBAY]: 'Medical Bay',
  [TileType.NAV_CONSOLE]: 'Navigation Console',
  [TileType.CRASH_COUCH]: 'Crash Couch',
  [TileType.TERMINAL]: 'Terminal',
  [TileType.EVA_LOCKER]: 'EVA Suit Locker',
  [TileType.RADIO]: 'Communications Array',
  [TileType.TRANSPONDER]: 'Transponder',
};

export const TILE_DESCRIPTIONS = {
  [TileType.CONSOLE]: 'General-purpose ship terminal. Comms, sensors, and system monitoring.',
  [TileType.NAV_CONSOLE]: 'Navigation and flight control. Plots courses and manages burn sequences.',
  [TileType.ENGINE]: 'Epstein fusion drive. Provides thrust for interplanetary travel.',
  [TileType.REACTOR]: 'Fusion reactor core. Powers every system including the drive. Containment failure is catastrophic.',
  [TileType.STORAGE]: 'Cargo and supply storage.',
  [TileType.LIFE_SUPPORT]: 'Atmospheric recycling: CO₂ scrubbers, O₂/N₂ injection. Keeps the crew breathing.',
  [TileType.AIRLOCK]: 'Pressurized airlock for EVA and docking operations.',
  [TileType.MEDBAY]: 'Autodoc bed. Stabilizes and heals injured crew. One patient at a time.',
  [TileType.CRASH_COUCH]: 'Gel-filled acceleration couch with juice injector, for sustained burns above 1.5G.',
  [TileType.TERMINAL]: 'Workstation terminal. Crew interface for system operations.',
  [TileType.EVA_LOCKER]: 'EVA suit locker. Holds one suit with 48h of independent life support.',
  [TileType.RADIO]: 'High-gain communications array. Contacts ships and stations in range; broadcasts SOS.',
  [TileType.TRANSPONDER]: 'Identity transponder. Can be silenced for stealth — the drive plume is still visible while burning.',
};

/** Tiles with info panels / actions. */
export const INTERACTIVE_TILES = new Set([
  TileType.CONSOLE, TileType.NAV_CONSOLE, TileType.ENGINE,
  TileType.REACTOR, TileType.STORAGE, TileType.LIFE_SUPPORT,
  TileType.AIRLOCK, TileType.MEDBAY, TileType.CRASH_COUCH,
  TileType.TERMINAL, TileType.EVA_LOCKER,
  TileType.RADIO, TileType.TRANSPONDER,
]);

/** Crew can stand on / walk through these. */
export const WALKABLE = new Set([TileType.FLOOR, TileType.DOOR, TileType.LADDER, TileType.MEDBAY]);

/** Solid for sliding bodies (inertial events). */
export const BLOCKING = new Set([TileType.HULL_WALL, TileType.INTERIOR_WALL, TileType.ENGINE, TileType.REACTOR]);

/** Pressurized volume (not structure). */
export const isInterior = (t) => t !== TileType.EMPTY && t !== TileType.HULL_WALL && t !== TileType.INTERIOR_WALL;

/** Structural mass per tile type, kg. */
export const TILE_MASS = {
  [TileType.EMPTY]: 0,
  [TileType.HULL_WALL]: 800,
  [TileType.INTERIOR_WALL]: 200,
  [TileType.FLOOR]: 150,
  [TileType.DOOR]: 120,
  [TileType.LADDER]: 40,
  [TileType.CONSOLE]: 85,
  [TileType.NAV_CONSOLE]: 120,
  [TileType.BUNK]: 60,
  [TileType.TABLE]: 35,
  [TileType.ENGINE]: 2200,
  [TileType.REACTOR]: 4500,
  [TileType.STORAGE]: 50,
  [TileType.LIFE_SUPPORT]: 180,
  [TileType.AIRLOCK]: 350,
  [TileType.MEDBAY]: 95,
  [TileType.CRASH_COUCH]: 150,
  [TileType.TERMINAL]: 70,
  [TileType.EVA_LOCKER]: 60,
  [TileType.RADIO]: 90,
  [TileType.TRANSPONDER]: 45,
};
