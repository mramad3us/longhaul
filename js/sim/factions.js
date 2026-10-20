// ============================================================
// LONGHAUL — Factions & spheres of influence
//
// Three powers divide the system: the United Nations (Earth & Luna),
// the Martian Congressional Republic, and the Outer Planets Alliance
// (the Belt and the outer moons). Independents and criminals fill the
// gaps.
//
// Influence is a smooth field: each power projects it from the bodies
// it holds (and the OPA from the Belt as a whole), falling off with
// distance. Sources ride on the ephemeris, so borders move as the
// planets do — Earth and Mars drift in and out of each other's reach,
// and the space between them is sometimes nobody's. The strongest
// power at a point controls it; where two are close it is contested;
// where none reaches it is lawless.
// ============================================================

import { getBody, bodyPos } from './ephemeris.js';
import { DAY_MIN } from '../core/constants.js';

export const FACTIONS = {
  UN: { id: 'UN', name: 'United Nations', desc: "Earth and Luna: thirty billion people, the oldest navy in the system and most of its money. UN ships are many, sound, and a generation old.", short: 'UN', navy: 'UNN', police: 'UN Security', color: '#4A90D9' },
  MCR: { id: 'MCR', name: 'Martian Congressional Republic', desc: "Mars: a frontier world under a terraforming project that will take centuries, and the best warships ever built. MCRN crews are drilled hard and fly TL4 hulls.", short: 'MCR', navy: 'MCRN', police: 'Martian Security', color: '#C1553B' },
  OPA: { id: 'OPA', name: 'Outer Planets Alliance', desc: "The Outer Planets Alliance: Belter unions, cells and militias holding the stations of the Belt. Refit hulls, jury-rigged kit, and crews who can fix anything with a wrench.", short: 'OPA', navy: 'OPA', police: 'Star Helix Security', color: '#E2A355' },
  independent: { id: 'independent', name: 'Independent', desc: "Corporations, private captains and stations that answer to no flag, for as long as nobody makes them.", short: 'IND', navy: null, police: null, color: '#8A8A6A' },
  pirate: { id: 'pirate', name: 'Pirates', desc: "Raiders working the lanes where nobody's writ runs. Their demand is often a bluff, but they will take what they can off a wreck.", short: 'PIRATE', navy: null, police: null, color: '#C05AA0' },
};

/** The three powers that hold territory. */
export const POWERS = ['UN', 'MCR', 'OPA'];

/** Display color for a faction ('player' marks our own ordnance). */
export const factionColor = (id) => id === 'player' ? '#4FD1C5' : FACTIONS[id]?.color || '#8A8A6A';
export const factionName = (id) => FACTIONS[id]?.name || 'Unknown';


// ---- INFLUENCE SOURCES ----
// Body sources: strength s at the body, Gaussian falloff with radius r (AU).
// Ring sources: strength s along a heliocentric annulus at radius a ± w (AU).

export const INFLUENCE_SOURCES = [
  { faction: 'UN', body: 'Earth', s: 1.0, r: 0.45 },
  { faction: 'UN', body: 'Venus', s: 0.5, r: 0.15 },
  { faction: 'UN', body: 'Mercury', s: 0.35, r: 0.1 },
  { faction: 'UN', body: 'Ganymede', s: 0.4, r: 0.08 },
  { faction: 'MCR', body: 'Mars', s: 1.0, r: 0.35 },
  { faction: 'MCR', body: 'Pallas', s: 0.35, r: 0.1 },
  { faction: 'MCR', body: 'Ganymede', s: 0.45, r: 0.08 },
  { faction: 'MCR', body: 'Callisto', s: 0.4, r: 0.08 },
  { faction: 'OPA', ring: { a: 2.75, w: 0.5 }, s: 0.5 },
  { faction: 'OPA', body: 'Ceres', s: 0.9, r: 0.15 },
  { faction: 'OPA', body: 'Pallas', s: 0.6, r: 0.1 },
  { faction: 'OPA', body: 'Hygiea', s: 0.5, r: 0.1 },
  { faction: 'OPA', body: 'Juno', s: 0.7, r: 0.1 },
  { faction: 'OPA', body: 'Vesta', s: 0.35, r: 0.1 },
  { faction: 'OPA', body: 'Europa', s: 0.3, r: 0.1 },
  { faction: 'OPA', body: 'Titan', s: 0.6, r: 0.3 },
  { faction: 'OPA', body: 'Uranus', s: 0.4, r: 1.2 },
  { faction: 'OPA', body: 'Neptune', s: 0.4, r: 1.5 },
];

export const CONTROL_MIN = 0.25;      // influence a power needs to hold space
export const LAWLESS_MAX = 0.15;      // below this nobody polices anything
const CONTEST_RATIO = 0.6;            // a rival this close to the leader contests the space

const _bp = { x: 0, y: 0 };

/**
 * Influence of each power at a heliocentric point (AU) and minute.
 * Contributions combine like independent probabilities (1 − Π(1 − cᵢ)),
 * so overlapping sources reinforce without ever exceeding 1.
 */
export function influenceAt(x, y, minute, out = {}) {
  const days = minute / DAY_MIN;
  const keep = { UN: 1, MCR: 1, OPA: 1 };
  const rSun = Math.hypot(x, y);
  for (const src of INFLUENCE_SOURCES) {
    let c;
    if (src.ring) {
      const k = (rSun - src.ring.a) / src.ring.w;
      c = src.s * Math.exp(-k * k);
    } else {
      bodyPos(getBody(src.body), days, _bp);
      const k = Math.hypot(x - _bp.x, y - _bp.y) / src.r;
      if (k > 4) continue;
      c = src.s * Math.exp(-k * k);
    }
    keep[src.faction] *= 1 - c;
  }
  out.UN = 1 - keep.UN; out.MCR = 1 - keep.MCR; out.OPA = 1 - keep.OPA;
  return out;
}

/**
 * Who holds a point: { faction | null, level, rival | null, contested, lawless, influence }.
 * `level` is the leader's influence (0–1): how thick its patrols are.
 */
export function controlAt(x, y, minute) {
  const inf = influenceAt(x, y, minute);
  const ranked = POWERS.slice().sort((a, b) => inf[b] - inf[a]);
  const [first, second] = ranked;
  const level = inf[first];
  const rivalLevel = inf[second];
  const holds = level >= CONTROL_MIN;
  const contested = holds && rivalLevel >= CONTROL_MIN * 0.8 && rivalLevel >= level * CONTEST_RATIO;
  return {
    faction: holds ? first : null,
    level,
    rival: contested ? second : null,
    contested,
    lawless: level < LAWLESS_MAX,
    influence: inf,
  };
}

/** Short label for a point's political status. */
export function spaceLabel(ctl) {
  if (ctl.contested) return `CONTESTED ${FACTIONS[ctl.faction].short}·${FACTIONS[ctl.rival].short}`;
  if (ctl.faction) return `${FACTIONS[ctl.faction].short} SPACE`;
  return ctl.lawless ? 'LAWLESS' : 'UNCLAIMED';
}
