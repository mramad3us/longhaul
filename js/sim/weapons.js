// ============================================================
// LONGHAUL — Weapons: performance tables
//
// Nothing here glows. Three families, all kinetic or nuclear:
//
//   PDC — point-defense cannons: radar-laid gatling guns throwing
//         tungsten at ~1.2 km/s. Their job is killing torpedoes in the
//         last seconds of an approach; at a few km they also chew up
//         hulls. Rounds are finite.
//   Torpedoes — small fusion-drive missiles with a fixed Δv budget,
//         HE (shaped charge: section damage, can disable) or nuclear
//         (kills, and hurts anything close by). They fly real
//         trajectories for minutes to weeks.
//   Railguns — naval spinal/turret mounts. A slug at tens of km/s is
//         unguided: it hits wherever the target is not, unless the
//         target holds still. Ruinous against anything predictable.
// And one that isn't a weapon at all: mining gear (ore mass drivers,
// rock-cracking charges) turned on a hull in an emergency.
//
// Performance scales with the tech level of the ship that carries
// the weapon (fire-control radar, motors, coil efficiency).
// ============================================================

// ---- POINT DEFENSE ----
// lambda: kill rate per mount-second against a torpedo inside the envelope
// rangeM: anti-torpedo envelope · strafeM: effective range against hulls
// sigmaRad: angular dispersion of a burst

export const PDC = {
  1: { lambda: 0.25, rangeM: 25_000, strafeM: 4_000, sigmaRad: 1.0e-3 },
  2: { lambda: 0.4, rangeM: 40_000, strafeM: 6_000, sigmaRad: 0.7e-3 },
  3: { lambda: 0.5, rangeM: 55_000, strafeM: 10_000, sigmaRad: 0.5e-3 },
  4: { lambda: 0.55, rangeM: 70_000, strafeM: 15_000, sigmaRad: 0.35e-3 },
};
export const PDC_RPS = 50;                 // rounds per mount-second of fire
export const PDC_MUZZLE = 1200;            // m/s
export const PDC_STRAFE_DUTY = 0.3;        // fraction of a minute a mount is on target while strafing
export const PDC_BURST_DP = 6;             // damage of one minute of hits on a hull
export const PDC_MAX_EXPOSURE_S = 20;      // a torpedo is in the envelope at most this long
export const PDC_AUTO_FACTOR = 0.6;        // fire control without a gunner at the weapons station

// ---- TORPEDOES ----
// Motor by tech level: maximum acceleration (G) and total Δv (m/s). A
// torpedo's drive is a ship's drive in miniature: enough Δv to run down a
// ship burning away at 1G for a few hours — not for days.

export const TORPEDO_MOTOR = {
  1: { maxG: 12, dv: 100_000 },
  2: { maxG: 18, dv: 150_000 },
  3: { maxG: 25, dv: 250_000 },
  4: { maxG: 32, dv: 400_000 },
};

export const WARHEADS = {
  he: { id: 'he', name: 'HE torpedo', short: 'HE', dp: 70, price: 1800 },
  nuke: { id: 'nuke', name: 'Nuclear torpedo', short: 'NUKE', dp: 600, scaleM: 300, fuzeM: 1500, price: 6000, contraband: true },
};

/**
 * Flight profiles: the closing speed the torpedo builds and then holds,
 * burning again whenever the target pulls away. Faster means less time
 * inside the point-defense envelope — and a bright plume the target sees
 * coming, and more Δv spent if it runs. How fast a torpedo can close and
 * still hold its terminal lock depends on its seeker: FAST_VC by tech
 * level; COLD COAST closes at a fraction of that.
 */
export const FAST_VC = { 1: 15_000, 2: 20_000, 3: 25_000, 4: 30_000 };
export const PROFILES = {
  fast: {
    id: 'fast', label: 'FAST', vcFrac: 1,
    desc: 'Close at up to 15–30 km/s by tech level (what the seeker can hold); against a ship running, burn at full G early and coast in. Short flight, little time under the PDCs — but the plume is seen early, and in datalink with us it shows to their short-range sensors even coasting.',
  },
  cold: {
    id: 'cold', label: 'COLD COAST', vcFrac: 0.4,
    desc: 'Boost to 40% of that, then coast dark, its datalink listening only: invisible beyond ~30,000 km until the last minutes. Slow, and point defense gets a long look.',
  },
};

/** Closing speed (m/s) a torpedo of tech level `tl` holds on a profile. */
export const profileVc = (profile, tl) => FAST_VC[tl] * PROFILES[profile].vcFrac;

/**
 * A seeker holds its terminal lock up to this much past FAST_VC; closing
 * faster, the chance it holds falls with the square of the excess
 * (ordnance.js). So a torpedo too fast (a runner that stopped running, a
 * launch from a ship closing hard) brakes down to it on the way in.
 */
export const SEEKER_SLACK = 1.25;
export const seekerVc = (tl) => FAST_VC[tl] * SEEKER_SLACK;

export const TERMINAL_S = 8;               // seconds of terminal homing: sets the capture basket
export const TORPEDO_ARM_MIN = 1;          // minutes after launch before the drive lights
export const TORPEDO_LIFE_DAYS = 60;       // reactor endurance: self-destruct after this
export const TORPEDO_RELOAD_MIN = 3;       // autoloader cycle per tube
export const PN_GAIN = 3;                  // proportional-navigation constant

// ---- RAILGUNS ----
// speed: slug velocity relative to the firing ship · sigma: angular error (rad)

export const RAILGUN = {
  2: { speed: 20_000, sigma: 4e-6 },
  3: { speed: 30_000, sigma: 2e-6 },
  4: { speed: 45_000, sigma: 1e-6 },
};
export const RAIL_DP = 45;
export const RAIL_RELOAD_MIN = 1;          // capacitor recharge per mount
export const RAIL_RANGE_M = 30_000_000;    // past this no fire-control solution is worth a slug

// ---- MINING GEAR ----
// Tools of the trade, not weapons: unguided, slow, aimed by eye, useless
// against a torpedo. They hurt a ship only inside a few kilometres — which
// is exactly where a pirate comes to loot a ship it thinks is helpless.
// rangeM: furthest useful shot · speed: projectile (m/s) · sigmaRad:
// dispersion · dp: damage of a minute of hits per mount. They throw rock,
// so they never run dry.

export const MINING_GEAR = {
  charges: { id: 'charges', name: 'rock-cracking charges', rangeM: 3_000, speed: 300, sigmaRad: 4e-3, dp: 3 },
  driver: { id: 'driver', name: 'ore mass driver', rangeM: 8_000, speed: 2_500, sigmaRad: 2.5e-3, dp: 4 },
};

// ---- EVASION ----
// A jinking ship changes its thrust vector at random every few seconds.
// Over a flight time t, a weapon aimed at its predicted position misses
// by a random displacement of this size (m): one segment of random
// acceleration early on, a random walk of velocity kicks later.

export const JINK_PERIOD_S = 8;
export const EVADE_G = 2.5;                // player's evasive jinking acceleration

export function jinkSigma(evadeG, tSec) {
  if (evadeG <= 0 || tSec <= 0) return 0;
  const a = evadeG * 9.80665;
  return a * Math.min(0.5 * tSec * tSec, Math.sqrt(JINK_PERIOD_S / 3) * Math.pow(tSec, 1.5));
}

/** P(hit) for a Gaussian miss (σ per axis, m) against a target of radius R (m), centered aim. */
export function hitChance(radiusM, sigmaM) {
  if (sigmaM <= 0) return 1;
  return 1 - Math.exp(-(radiusM * radiusM) / (2 * sigmaM * sigmaM));
}

// ---- DOCTRINE UNDER TORPEDO FIRE ----
// What a fire-control computer that plots the threat axis (TECH.counterBurn,
// TL2 and up) makes of inbound torpedoes, for NPC crews (agents.js) and our
// stances (stance.js) alike: turn away and burn from any torpedo this close,
// so it arrives slowly, long under the PDCs, and spends its Δv catching up;
// and close on the enemy no faster than this while one is inbound, since
// every m/s of closing speed is a m/s on the enemy's torpedoes.
export const COUNTER_BURN_S = 45 * 60;
export const UNDER_FIRE_CLOSE_MS = 5_000;

// ---- AMMUNITION ----

export const AMMO_PRICES = { pdcRounds: 0.05, he: WARHEADS.he.price, nuke: WARHEADS.nuke.price };
