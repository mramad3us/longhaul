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
//
// Each power is a coalition of SUB-FACTIONS, and the independents are a
// crowd of masters of their own (below; how they pull and feud:
// politics.js).
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

// ---- SUB-FACTIONS ----
// A power is not one mind. Each is a coalition of sub-factions that work
// for its general interest and for their own agendas, and fight each
// other for influence over it, mostly in the dark: budget fights, leaks,
// arrests, a convenient accident at a yard (politics.js). Their share of
// influence decides which way the power leans: hawks push toward war,
// doves away from it, the intelligence services run covert work abroad
// and at home, the companies want trade and quietly pay for proxies.
//
// The independents have no top: each of their sub-factions is a power of
// its own size, answering to nobody (a farming concord, a miners'
// cooperative, a mercenary company). The pirate clans are independents
// too, outlaws to everyone: their ships keep the faction 'pirate', the
// law's word for them, and carry their clan as `sub`.
//
//   agenda   hawk · dove · covert · profit · militant · moderate · labor ·
//            police · trade · mercenary · plunder
//   fleet    which of the power's hulls fly under it (category weights:
//            civilian, authority, military, irregular), for rollIdentity
//   influence its starting share of its power's politics (police and the
//            independents don't take part)

export const SUBFACTIONS = {
  // ---------------- United Nations ----------------
  'unn-fleet': { parent: 'UN', name: 'UNN Fleet Command', short: 'UNN', agenda: 'hawk', influence: 0.3, fleet: { military: 1 },
    desc: 'The admirals of the oldest navy in the system: a big fleet, a long memory, and a budget to defend every year.' },
  'un-intel': { parent: 'UN', name: 'Earth Intelligence Directorate', short: 'EID', agenda: 'covert', influence: 0.15, fleet: {},
    desc: 'Earth\'s spies: wiretaps on Mars, money for anyone who makes Mars\'s life hard, and files on half the Assembly.' },
  'un-assembly': { parent: 'UN', name: 'Assembly Peace Caucus', short: 'APC', agenda: 'dove', influence: 0.3, fleet: {},
    desc: 'The delegates who remember what the last war cost: thirty billion voters and a fleet that is getting old.' },
  'un-corp': { parent: 'UN', name: 'Luna-Kepler Consolidated', short: 'LKC', agenda: 'profit', influence: 0.25, fleet: { civilian: 0.35 },
    desc: 'The biggest shipping and mining combine on Earth. It wants the lanes open, and pays quiet men when they are not.' },
  'un-security': { parent: 'UN', name: 'UN Security', short: 'UNS', agenda: 'police', fleet: { authority: 1 },
    desc: 'The UN\'s police in space: cutters on every station beat of Earth\'s.' },
  // ---------------- Mars ----------------
  'mcrn-fleet': { parent: 'MCR', name: 'MCRN Admiralty', short: 'MCRN', agenda: 'hawk', influence: 0.35, fleet: { military: 1 },
    desc: 'Mars\'s navy: the best ships ever built, crewed by the best-drilled crews, and very sure of both.' },
  'mcr-intel': { parent: 'MCR', name: 'Martian Naval Intelligence', short: 'MNI', agenda: 'covert', influence: 0.15, fleet: {},
    desc: 'Small, sharp and patient. MNI watches Earth, the Belt and the Congress with the same eyes.' },
  'mcr-congress': { parent: 'MCR', name: 'Congressional Unity Caucus', short: 'CUC', agenda: 'dove', influence: 0.3, fleet: {},
    desc: 'Terraforming first: every hull the navy builds is a century more under the domes.' },
  'mcr-corp': { parent: 'MCR', name: 'Hecate Arms & Drive', short: 'HAD', agenda: 'profit', influence: 0.2, fleet: { civilian: 0.3 },
    desc: 'Mars\'s drive-maker and arms yard. A war is a contract; a cold war is a longer one.' },
  'mcr-security': { parent: 'MCR', name: 'Martian Security', short: 'MSS', agenda: 'police', fleet: { authority: 1 },
    desc: 'The Republic\'s police cutters: precise, polite, and armed better than most navies.' },
  // ---------------- The Belt ----------------
  'opa-tycho': { parent: 'OPA', name: 'Tycho Council', short: 'TYCHO', agenda: 'moderate', influence: 0.35, fleet: { military: 0.7 },
    desc: 'The builders: a seat at the table with the inners, a navy of refits, and patience.' },
  'opa-ceres': { parent: 'OPA', name: 'Ceres Free Belt', short: 'CFB', agenda: 'militant', influence: 0.3, fleet: { military: 0.3 },
    desc: 'The cells that never stopped fighting: bombings on inner stations, and ships that answer to nobody at Tycho.' },
  'opa-unions': { parent: 'OPA', name: 'Belt Unions', short: 'UNIONS', agenda: 'labor', influence: 0.35, fleet: { civilian: 0.4 },
    desc: 'Dockers, miners and ice haulers: they can shut a port with a vote, and do.' },
  'opa-starhelix': { parent: 'OPA', name: 'Star Helix Security', short: 'SH', agenda: 'police', fleet: { authority: 1 },
    desc: 'The Belt\'s police contractor, keeping the peace on the OPA\'s stations for a fee.' },
  // ---------------- Independents (each its own master) ----------------
  'ind-ganymede': { parent: null, name: 'Ganymede Agricultural Concord', short: 'GAC', agenda: 'trade', fleet: { civilian: 0.2 },
    desc: 'The breadbasket of the outer planets, and neutral as long as both navies need to eat.' },
  'ind-vesta': { parent: null, name: 'Vesta Miners\' Cooperative', short: 'VMC', agenda: 'trade', fleet: { civilian: 0.15 },
    desc: 'The prospectors and ore haulers round Vesta, owned by the people who dig.' },
  'ind-traders': { parent: null, name: 'Free Traders\' Guild', short: 'FTG', agenda: 'trade', fleet: { civilian: 0.4 },
    desc: 'Independent captains who share rates, news and lawyers, and nothing else.' },
  'ind-water': { parent: null, name: 'Pur\'n\'Kleen Water', short: 'PNK', agenda: 'trade', fleet: { civilian: 0.15 },
    desc: 'Ice from the rings to anyone who pays: the oldest water company in the Belt.' },
  'ind-merc': { parent: null, name: 'Brannock Security Services', short: 'BSS', agenda: 'mercenary', fleet: { irregular: 1 },
    desc: 'A mercenary company with refit warships and no questions: convoy guards for some, deniable raiders for whoever pays most.' },
  // ---------------- Pirate clans (independents, outlaws to all) ----------------
  'clan-rust': { parent: null, outlaw: true, name: 'Rust Queens', short: 'RUST', agenda: 'plunder', fleet: { irregular: 1 }, lairs: ['Hygiea', 'Vesta', 'Ceres'],
    desc: 'The oldest clan in the Belt: salvage, protection, and a long memory for debts.' },
  'clan-dark': { parent: null, outlaw: true, name: 'Hungry Dark', short: 'DARK', agenda: 'plunder', fleet: { irregular: 1 }, lairs: ['Jupiter', 'Callisto', 'Europa'],
    desc: 'Raiders of the gulf beyond the Belt, who run cold and leave nothing behind.' },
  'clan-knives': { parent: null, outlaw: true, name: 'Knife Season', short: 'KNIVES', agenda: 'plunder', fleet: { irregular: 1 }, lairs: ['Pallas', 'Juno', 'Hygiea'],
    desc: 'Young, loud and fast: they hit the Belt lanes and boast about it on open channels.' },
  'clan-ghost': { parent: null, outlaw: true, name: 'Ghost Belt', short: 'GHOST', agenda: 'plunder', fleet: { irregular: 1 }, lairs: ['Saturn', 'Titan', 'Uranus'],
    desc: 'Nobody has seen their faces. Ships go quiet in the outer dark and are found weeks later, stripped.' },
};

export const SUB_IDS = Object.keys(SUBFACTIONS);
/** The sub-factions of a power (or the independents for 'independent', the clans for 'pirate'). */
export function subsOf(faction) {
  if (faction === 'pirate') return SUB_IDS.filter(id => SUBFACTIONS[id].outlaw);
  if (faction === 'independent') return SUB_IDS.filter(id => !SUBFACTIONS[id].parent && !SUBFACTIONS[id].outlaw);
  return SUB_IDS.filter(id => SUBFACTIONS[id].parent === faction);
}
/** The sub-factions of a power that take part in its politics (not its police). */
export const politicalSubs = (faction) => subsOf(faction).filter(id => SUBFACTIONS[id].influence != null);
export const subName = (id) => SUBFACTIONS[id]?.name || null;
/** The faction a sub-faction's ships fly as. */
export const subFaction = (id) => { const s = SUBFACTIONS[id]; return !s ? null : s.parent || (s.outlaw ? 'pirate' : 'independent'); };

/**
 * Which sub-faction a new hull of a power flies under, by its category
 * (null: a private owner). Weights are each sub-faction's share of that
 * category; what is left over is private.
 */
export function pickSub(faction, category, roll) {
  const subs = subsOf(faction);
  const total = subs.reduce((s, id) => s + (SUBFACTIONS[id].fleet?.[category] || 0), 0);
  if (total > 1) roll *= total;                  // (the clans share the pirates evenly)
  let acc = 0;
  for (const id of subs) {
    acc += SUBFACTIONS[id].fleet?.[category] || 0;
    if (roll < acc) return id;
  }
  return null;
}


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
