// ============================================================
// LONGHAUL — Physical & simulation constants
// Single source of truth. Never redefine these locally.
// ============================================================

export const AU_M = 149_597_870_700;      // meters per AU
export const AU_KM = 149_597_870.7;       // km per AU
export const GM_SUN = 1.32712440018e20;   // m³/s²
export const G0 = 9.80665;                // m/s² per G
export const TWO_PI = Math.PI * 2;

export const MIN_S = 60;                  // seconds per game-minute (the sim step)
export const DAY_MIN = 1440;              // game-minutes per day

// Game speed settings: game-minutes per real second
export const SPEED_MIN_PER_SEC = [0, 1, 60, 1440];

// Sensor ranges (AU)
export const RANGE = {
  SHORT: 0.001,          // ~150k km — all sensors
  MEDIUM: 0.01,          // ~1.5M km — radar
  LONG: 0.1,             // ~15M km — telescopes / drive plumes
  RADIO: 0.1,            // ~15M km — high-gain comms
  SOS: 0.3,              // distress beacons are loud
  DOCK_M: 50_000,        // within 50 km of a station = in its traffic control zone
  FORMATION_M: 1_900,    // within this and co-moving = formation (inside a suit's 2 km reach, boarding.js EVA_RANGE_M, with room for the hold to wander)
};

export const km = (v) => v * 1000 / AU_M;        // km → AU
export const metersToAU = (m) => m / AU_M;
export const auToKm = (au) => au * AU_KM;
