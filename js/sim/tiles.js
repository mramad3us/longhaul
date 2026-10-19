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
  GALLEY: 21,
  HEAD: 22,
  WATER_RECYCLER: 23,
  WORKBENCH: 24,
  OPS_CONSOLE: 25,
  ENG_CONSOLE: 26,
  REC: 27,
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
  [TileType.GALLEY]: 'Galley',
  [TileType.HEAD]: 'Head',
  [TileType.WATER_RECYCLER]: 'Water Reclamation',
  [TileType.WORKBENCH]: 'Machine Shop',
  [TileType.OPS_CONSOLE]: 'Ops Station',
  [TileType.ENG_CONSOLE]: 'Engineering Station',
  [TileType.REC]: 'Exercise Rig',
};

export const TILE_DESCRIPTIONS = {
  [TileType.CONSOLE]: 'General-purpose ship terminal. Comms, sensors, and system monitoring.',
  [TileType.NAV_CONSOLE]: 'The helm: flight computer and manual flight controls, built into an acceleration couch. If the flight computer fails, someone has to fly from here.',
  [TileType.OPS_CONSOLE]: 'Sensors and communications station. A watchstander here tracks contacts faster and spots debris in time to dodge it.',
  [TileType.ENG_CONSOLE]: 'Engineering watch station: drive, reactor and plant telemetry. An engineer on watch catches faults before they bite.',
  [TileType.BUNK]: 'Rack with sleep restraints. Crew sleep here off watch — on a small ship, bunks are shared between watches.',
  [TileType.TABLE]: 'Mess table. Meals and company.',
  [TileType.GALLEY]: 'Food preparation. With a cook on duty the crew eats hot meals; without, it\'s self-serve or cold rations.',
  [TileType.HEAD]: 'Shower and toilet. Water goes to the reclamation plant.',
  [TileType.WATER_RECYCLER]: 'Water reclamation: recovers ~95% of the ship\'s water. Without it the tanks run down fast.',
  [TileType.WORKBENCH]: 'Machine shop. Engineers refurbish scrapped components into spare parts.',
  [TileType.REC]: 'Exercise rig and entertainment screen. Keeps bodies and minds in shape on long hauls.',
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
  TileType.BUNK, TileType.TABLE, TileType.GALLEY, TileType.HEAD, TileType.WATER_RECYCLER,
  TileType.WORKBENCH, TileType.OPS_CONSOLE, TileType.ENG_CONSOLE, TileType.REC,
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
  [TileType.GALLEY]: 160,
  [TileType.HEAD]: 120,
  [TileType.WATER_RECYCLER]: 420,
  [TileType.WORKBENCH]: 380,
  [TileType.OPS_CONSOLE]: 140,
  [TileType.ENG_CONSOLE]: 140,
  [TileType.REC]: 110,
};
