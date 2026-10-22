// ============================================================
// LONGHAUL — Politics: what the powers want, and what they do about it
//
// RELATIONS. Each pair of powers has a relation (−100 open war … +100
// alliance) and a phase it is in:
//
//   allied ≥ 55 · friendly ≥ 20 · neutral · cold war ≤ −20 · crisis ≤ −45 · war
//
// The phases between are read off the relation (with a little hysteresis
// so a border isn't crossed every other day); WAR is declared, and ended
// by a ceasefire, as events. Earth and Mars are never friends: their
// relation never rises above −25, so they live between a cold war and an
// open one. Two quantities move them:
//
//   PRESSURE (0–1) builds while they are not fighting: the arms race,
//     incidents (warships lost in a standoff, a proxy's raids exposed, a
//     spy caught), and the weight of each side's hawks. It pulls the
//     relation down: in equilibrium the relation sits at its baseline less
//     ~60 × pressure, so a cold war drifts into a crisis over a season and,
//     past −72, war is declared. Fighting spends it.
//   EXHAUSTION (0–1) builds during a war, faster with losses. A ceasefire
//     becomes likely once it passes 0.4; the relation is then set back to
//     crisis and cools toward the baseline over a month or two.
//
// So the Earth–Mars relation oscillates on a scale of months: years of
// cold war, a crisis, a short hot war, a ceasefire, and the long slide
// back. The other pairs (each inner power with the Belt) work the same
// way from milder baselines and rarely go to war.
//
// SUB-FACTIONS (factions.js) share each power's influence. Their agendas
// lean it: hawks and militants toward war, doves and moderates away,
// companies toward a profitable cold war. Influence moves with events: a
// war that drags on hands it to the doves, a crisis to the hawks, a
// scandal costs whoever it lands on. Rival sub-factions of one power
// fight each other in the dark (IN-FIGHTING): leaks, budget fights,
// arrests, smears, and sabotage at a yard (which delays the ships it is
// building: forces.js). Some of it reaches the newsfeed. Now and then a
// sub-faction wants a job done against a rival quietly (a covert job,
// contracts.js), and a licensed captain of that power may be asked.
//
// PROXIES. In a cold war or a crisis the powers fight through others: a
// power backs a mercenary company, a pirate clan or a Belter cell against
// its rival's shipping and stations (a PROXY zone, conflict.js). The
// backer denies it. When the money is traced, it is an incident.
//
// All of this runs once a day, on a handful of numbers: it costs nothing
// at any world size. News leaves from where it happened (the capital of
// the power it concerns) and reaches us at light speed (intel.js).
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { random, randRange, randInt, pick, chance, gaussian, weightedPick } from '../core/rng.js';
import { getBody, bodyPos } from './ephemeris.js';
import { FACTIONS, POWERS, SUBFACTIONS, politicalSubs } from './factions.js';
import { relay } from './intel.js';

export const pairKey = (a, b) => [a, b].sort().join('-');
export const PAIRS = [pairKey('UN', 'MCR'), pairKey('UN', 'OPA'), pairKey('MCR', 'OPA')];

export const PHASES = {
  allied: { label: 'ALLIED', rank: 5 },
  friendly: { label: 'FRIENDLY', rank: 4 },
  neutral: { label: 'NEUTRAL', rank: 3 },
  cold: { label: 'COLD WAR', rank: 2 },
  crisis: { label: 'CRISIS', rank: 1 },
  war: { label: 'WAR', rank: 0 },
};
const BANDS = [['allied', 55], ['friendly', 20], ['neutral', -20], ['cold', -45], ['crisis', -Infinity]];
const HYSTERESIS = 3;
export const WAR_AT = -72;               // a crisis this deep can turn into a declared war
const CEASEFIRE_REL = -50;               // where a ceasefire leaves them
const CEASEFIRE_FROM = 0.4;              // exhaustion past which a ceasefire becomes likely

/** Baseline relation of each pair, and its ceiling (Earth and Mars are never friends). */
const BASE = { 'MCR-UN': -32, 'OPA-UN': -10, 'MCR-OPA': -15 };
const CEILING = { 'MCR-UN': -25 };
/** How fast pressure builds by itself (the arms race): Earth and Mars build it fastest. */
const DRIFT = { 'MCR-UN': 0.0018, 'OPA-UN': 0.0012, 'MCR-OPA': 0.0012 };
/** …and how fast it lets down by itself (with the drift and the hawks, where it would settle). */
const RELIEF = { 'MCR-UN': 0.008, 'OPA-UN': 0.008, 'MCR-OPA': 0.008 };
/** A crisis feeds itself (alerts, mobilization, every incident read as the worst) unless it is the cooling after a ceasefire. */
const SPIRAL = 0.012;
/** How much each agenda leans its power toward war (+) or away from it (−). */
const LEAN = { hawk: 1, militant: 1, covert: 0.2, profit: 0.3, dove: -1, moderate: -0.6, labor: -0.2 };

export function createPolitics() {
  const pairs = {};
  for (const k of PAIRS) pairs[k] = { rel: BASE[k], phase: phaseOf(BASE[k], null), since: 0, pressure: randRange(0.05, 0.25), exhaustion: 0, incidents: 0, losses: 0 };
  const subs = {};
  for (const f of POWERS) for (const id of politicalSubs(f)) subs[id] = { influence: SUBFACTIONS[id].influence };
  const rivalry = {};
  for (const f of POWERS) {
    const ids = politicalSubs(f);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) rivalry[`${ids[i]}|${ids[j]}`] = rivalryBase(ids[i], ids[j]);
  }
  const P = {
    pairs, subs, rivalry, proxies: [], covert: [], headlines: [], nextProxy: 1,
    // (conflict.js: hot zones and the encounter director)
    zones: [], nextZone: 1, quietUntil: 6 * 60, tension: {},
  };
  syncTension(P);
  return P;
}

/** Sub-factions with opposed agendas start further apart. */
function rivalryBase(a, b) {
  const la = LEAN[SUBFACTIONS[a].agenda] ?? 0, lb = LEAN[SUBFACTIONS[b].agenda] ?? 0;
  return Math.min(1, 0.15 + Math.abs(la - lb) * 0.3);
}

// ---- READING THE RELATIONS ----

/** Put two powers in a phase (test suites and the dev panel). */
export function setPhase(state, a, b, phase, rel = { war: -85, crisis: -60, cold: -35, neutral: 0, friendly: 35, allied: 70 }[phase]) {
  const p = pairOf(state, a, b);
  if (!p) return;
  p.phase = phase; p.rel = rel; p.truce = false; p.since = state.clock.minute;
  syncTension(state.politics);
}

/** A pair's state, or null when either side is not a power. */
export function pairOf(state, a, b) {
  if (a === b || !POWERS.includes(a) || !POWERS.includes(b)) return null;
  return state.politics.pairs?.[pairKey(a, b)] || null;
}

/** The relation between two factions (−100 … 100). Pirates are everyone's enemy; independents nobody's. */
export function relation(state, a, b) {
  if (a === b) return 100;
  if (a === 'pirate' || b === 'pirate') return -100;
  return pairOf(state, a, b)?.rel ?? 0;
}

export function phaseBetween(state, a, b) {
  if (a === b) return 'allied';
  if (a === 'pirate' || b === 'pirate') return 'war';
  return pairOf(state, a, b)?.phase || 'neutral';
}

export const atWar = (state, a, b) => phaseBetween(state, a, b) === 'war' && a !== 'pirate' && b !== 'pirate';

/** The powers at war with `faction` right now. */
export function enemiesOf(state, faction) {
  return POWERS.filter(f => f !== faction && atWar(state, faction, f));
}

/** Who a power's hawks and doves add up to: −1 (all doves) … 1 (all hawks). */
export function hawkLean(state, power) {
  let lean = 0;
  for (const id of politicalSubs(power)) lean += (state.politics.subs[id]?.influence ?? 0) * (LEAN[SUBFACTIONS[id].agenda] ?? 0);
  return lean;
}

/** The sub-faction of a power with the most say now. */
export function leadingSub(state, power) {
  let best = null, bi = -1;
  for (const id of politicalSubs(power)) { const v = state.politics.subs[id]?.influence ?? 0; if (v > bi) { bi = v; best = id; } }
  return best;
}

function phaseOf(rel, current) {
  // Hysteresis: a phase holds until the relation is a few points past its border
  for (const [ph, lo] of BANDS) {
    const edge = !current ? lo : PHASES[ph].rank > PHASES[current].rank ? lo + HYSTERESIS : lo - HYSTERESIS;
    if (rel >= edge) return ph;
  }
  return 'crisis';
}

/** The old 0–1 tension figure, for the zones' intensity and the boards (0 friends … 1 open war). */
function syncTension(P) {
  for (const k of PAIRS) {
    const p = P.pairs[k];
    P.tension[k] = p.phase === 'war' ? Math.max(0.85, clamp01((50 - p.rel) / 150)) : clamp01((50 - p.rel) / 150);
  }
}

// ---- INCIDENTS (reported by the rest of the sim) ----

/**
 * Something happened between two powers that makes it worse: a warship
 * lost, a spy caught, a proxy's money traced. `weight` ~1 for a loss.
 */
export function incident(state, a, b, weight = 1) {
  const p = pairOf(state, a, b);
  if (!p) return;
  if (p.phase === 'war') p.losses += weight;
  else p.incidents += weight;
}

// ---- THE DAY ----

/** Once a day (conflict.js calls it before the zones are looked at). */
export function dailyRelations(state, emit = () => {}) {
  const P = state.politics;
  const now = state.clock.minute;
  if (P.frozen) return;                 // (test suites hold the powers where they put them)
  for (const k of PAIRS) {
    const p = P.pairs[k];
    const [a, b] = k.split('-');
    const lean = (hawkLean(state, a) + hawkLean(state, b)) / 2;
    if (p.phase === 'war') {
      p.exhaustion = clamp01(p.exhaustion + 0.014 + 0.006 * p.losses);
      p.pressure = Math.max(0, p.pressure - 0.035);
      p.rel += 0.04 * (WAR_AT - 8 - p.rel) + 1.5 * gaussian();
      if (p.exhaustion > CEASEFIRE_FROM && chance(0.5 * (p.exhaustion - CEASEFIRE_FROM) + 0.02)) {
        p.phase = 'crisis'; p.since = now; p.rel = CEASEFIRE_REL; p.pressure = 0; p.truce = true;
        headline(state, [a, b], `Ceasefire: ${FACTIONS[a].name} and ${FACTIONS[b].name} agree to stand down their fleets. Neither calls it peace.`, 'ceasefire');
        emit('politics-phase', { pair: k, phase: 'crisis', ceasefire: true });
      }
    } else {
      p.exhaustion = Math.max(0, p.exhaustion - 0.01);
      // the arms race and the hawks wind it up; time, and the doves, let it down
      const spiral = p.phase === 'crisis' && !p.truce ? SPIRAL : 0;
      p.pressure = clamp01(p.pressure + DRIFT[k] + 0.005 * lean + spiral - RELIEF[k] * p.pressure + 0.03 * p.incidents + 0.003 * gaussian());
      p.rel += 0.04 * (BASE[k] - p.rel) - 1.8 * p.pressure + 2 * gaussian();
      if (CEILING[k] != null) p.rel = Math.min(CEILING[k], p.rel);
      const was = p.phase;
      if (p.rel <= WAR_AT && chance(0.3 + 0.3 * Math.max(0, lean))) {
        p.phase = 'war'; p.since = now; p.exhaustion = 0;
        headline(state, [a, b], `WAR: ${FACTIONS[a].name} and ${FACTIONS[b].name} are at war. Both navies have orders to engage on sight.`, 'war');
        emit('politics-phase', { pair: k, phase: 'war' });
      } else {
        p.phase = phaseOf(p.rel, p.phase);
        if (p.phase !== 'crisis') p.truce = false;
        if (p.phase !== was) {
          p.since = now;
          headline(state, [a, b], phaseNews(a, b, was, p.phase), 'phase');
          emit('politics-phase', { pair: k, phase: p.phase, was });
        }
      }
    }
    p.rel = Math.max(-100, Math.min(100, p.rel));
    p.incidents = 0;
    p.losses = 0;
  }
  influenceDay(state);
  infighting(state, emit);
  proxiesDay(state, emit);
  syncTension(P);
}

function phaseNews(a, b, was, now) {
  const A = FACTIONS[a].name, B = FACTIONS[b].name;
  const worse = PHASES[now].rank < PHASES[was].rank;
  switch (now) {
    case 'crisis': return `Crisis between ${A} and ${B}: ambassadors recalled, fleets put on alert.`;
    case 'cold': return worse ? `Talks between ${A} and ${B} collapse. Both sides blame the other.` : `The crisis between ${A} and ${B} cools to the old cold war.`;
    case 'neutral': return worse ? `${A} and ${B} trade accusations over the lanes; trade talks suspended.` : `${A} and ${B} reopen trade talks.`;
    case 'friendly': return `${A} and ${B} sign a navigation and trade accord.`;
    case 'allied': return `${A} and ${B} announce a mutual defence pact.`;
    default: return `${A}–${B} relations change.`;
  }
}

// ---- INFLUENCE AND IN-FIGHTING ----

function influenceDay(state) {
  const P = state.politics;
  for (const power of POWERS) {
    const ids = politicalSubs(power);
    // War weariness hands influence to the doves; a long crisis to the hawks
    let tired = 0, tense = 0;
    for (const k of PAIRS) {
      if (!k.split('-').includes(power)) continue;
      const p = P.pairs[k];
      tired = Math.max(tired, p.phase === 'war' ? p.exhaustion : 0);
      tense = Math.max(tense, p.phase !== 'war' ? p.pressure : 0);
    }
    for (const id of ids) {
      const s = P.subs[id];
      const lean = LEAN[SUBFACTIONS[id].agenda] ?? 0;
      // (a coalition is sticky: every share is pulled back toward its usual weight)
      s.influence += 0.005 * gaussian() + 0.003 * lean * (tense - tired) + 0.02 * (SUBFACTIONS[id].influence - s.influence);
    }
    normalize(P, ids);
  }
}

function normalize(P, ids) {
  for (const id of ids) P.subs[id].influence = Math.max(0.05, P.subs[id].influence);
  const sum = ids.reduce((s, id) => s + P.subs[id].influence, 0);
  for (const id of ids) P.subs[id].influence /= sum;
}

/** What a feud between two sub-factions of one power can come to, and who it suits. */
const FEUDS = [
  { kind: 'leak', w: (a) => a.agenda === 'covert' ? 3 : 1, text: (A, B) => `Leaked files embarrass the ${B.name}; the ${A.short} denies any part in it.` },
  { kind: 'budget', w: (a, b) => (a.agenda === 'hawk' || b.agenda === 'hawk') ? 3 : 1, text: (A, B) => `Budget fight: the ${A.name} wins the vote against the ${B.name}.` },
  { kind: 'arrest', w: (a) => a.agenda === 'covert' ? 2 : 0.5, text: (A, B) => `Arrests: ${A.short} officers detain staff of the ${B.name} on espionage charges.` },
  { kind: 'smear', w: () => 1, text: (A, B) => `A press campaign against the ${B.name}, quietly paid for, people say, by the ${A.name}.` },
  { kind: 'sabotage', w: (a) => (a.agenda === 'covert' || a.agenda === 'militant') ? 1.5 : 0.3, text: (A, B, P) => `An "accident" at a ${P} yard: the ${B.short}'s new hulls are delayed. Nobody is charged.` },
];

function infighting(state, emit) {
  const P = state.politics;
  const now = state.clock.minute;
  P.covert = P.covert.filter(c => c.until > now);
  for (const key of Object.keys(P.rivalry)) {
    const [a, b] = key.split('|');
    const base = rivalryBase(a, b);
    P.rivalry[key] = clamp01(P.rivalry[key] + 0.03 * gaussian() + 0.05 * (base - P.rivalry[key]));
    if (!chance(0.02 * P.rivalry[key])) continue;
    // Who moves against whom: the stronger rival more often
    const [atk, def] = chance(P.subs[a].influence / (P.subs[a].influence + P.subs[b].influence)) ? [a, b] : [b, a];
    const A = SUBFACTIONS[atk], B = SUBFACTIONS[def];
    const feud = weightedPick(FEUDS, f => f.w(A, B));
    const power = A.parent;
    const swing = randRange(0.015, 0.04);
    P.subs[atk].influence += swing;
    P.subs[def].influence -= swing;
    normalize(P, politicalSubs(power));
    P.rivalry[key] = clamp01(P.rivalry[key] + 0.1);
    if (feud.kind === 'sabotage') emit('yard-sabotage', { faction: power, days: randInt(2, 6) });
    // Some of it is in the open; the rest is the kind of thing a sub-faction wants done quietly
    if (chance(0.6)) headline(state, [power], feud.text(A, B, FACTIONS[power].short), 'infighting');
    if (chance(0.5)) P.covert.push({ sub: atk, rival: def, power, at: now, until: now + randInt(4, 10) * DAY_MIN });
  }
}

// ---- PROXIES ----

/** Who will fight for money: the mercenaries, a clan, or a Belter cell (against the inners). */
function proxyFor(backer, target) {
  const pool = ['ind-merc', 'clan-rust', 'clan-dark', 'clan-knives'];
  if (backer !== 'OPA' && target !== 'OPA') pool.push('opa-ceres', 'opa-ceres');
  return pick(pool);
}

function proxiesDay(state, emit) {
  const P = state.politics;
  const now = state.clock.minute;
  for (const px of [...P.proxies]) {
    if (now < px.until) {
      // The money is traced: an incident between the backer and the target
      if (!px.exposed && chance(0.03)) {
        px.exposed = true;
        incident(state, px.backer, px.target, 1.5);
        headline(state, [px.target], `Investigators trace the money behind the ${SUBFACTIONS[px.sub].name}'s raids to ${FACTIONS[px.backer].name}. ${FACTIONS[px.backer].short} denies everything.`, 'proxy');
      }
      continue;
    }
    P.proxies.splice(P.proxies.indexOf(px), 1);
  }
  for (const k of PAIRS) {
    const p = P.pairs[k];
    if (p.phase !== 'cold' && p.phase !== 'crisis') continue;
    if (P.proxies.some(x => pairKey(x.backer, x.target) === k) || !chance(0.01 + 0.04 * p.pressure)) continue;
    const [a, b] = k.split('-');
    // The side whose spies have more say is likelier to pay for it
    const spy = (f) => politicalSubs(f).filter(id => SUBFACTIONS[id].agenda === 'covert' || SUBFACTIONS[id].agenda === 'militant').reduce((s, id) => s + P.subs[id].influence, 0.1);
    const backer = chance(spy(a) / (spy(a) + spy(b))) ? a : b;
    const target = backer === a ? b : a;
    const px = { id: `proxy-${P.nextProxy++}`, backer, target, sub: proxyFor(backer, target), since: now, until: now + randInt(15, 45) * DAY_MIN, exposed: false };
    P.proxies.push(px);
    emit('proxy-war', { proxy: px });
  }
}

// ---- NEWS ----

const CAPITAL = { UN: 'Earth', MCR: 'Mars', OPA: 'Ceres' };

/** A political headline: kept for the record, and sent to us from the capital it concerns. */
export function headline(state, powers, text, kind = 'politics') {
  const P = state.politics;
  P.headlines.push({ at: state.clock.minute, text, kind, powers });
  if (P.headlines.length > 40) P.headlines.shift();
  const where = bodyPos(getBody(CAPITAL[powers[0]] || 'Earth'), state.clock.minute / DAY_MIN);
  relay(state, where, 'politics-news', { text, kind, powers });
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
