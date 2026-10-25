// ============================================================
// LONGHAUL — Conflict: hot zones and encounters
//
// POLITICS (politics.js) decides how the powers stand with each other:
// cold war, crisis, war, a ceasefire. This module is where it shows.
//
// HOT ZONES are born from the influence field and the state of the
// powers, not from a script. Each day, with a chance that rises with the
// heat of the system, a flashpoint is chosen among the bodies:
//   where two powers' reach overlaps: a naval STANDOFF in a cold war; a
//     standoff, a BLOCKADE or a SKIRMISH in a crisis; a skirmish or a
//     blockade in a war;
//   where nobody's writ runs, in the Belt or beyond: PIRATE ACTIVITY, a
//     clan's work (factions.js);
//   where an inner power holds a place with real Belter presence: an
//     INSURGENCY (the Ceres Free Belt's cells).
// Two kinds come from politics directly:
//   a WAR FRONT for every war: the place both navies reach for (Ganymede,
//     or Mars itself when Earth is close), big, crowded and long-lived,
//     with control points the squadrons fight over. It ends with the war.
//   a PROXY WAR for every proxy a power pays (politics.js): the proxy's
//     raiders hit the target power's shipping where its reach is thin.
// A zone sits at an offset from its body and moves with it. It has a
// radius and an intensity that follows the state of its powers. A hot
// standoff escalates into a skirmish; a ceasefire silences the guns.
//
// Zones call for ships (forces.js): navies send squadrons from their
// yards, and each power in the fight sends a COMMAND SHIP to the rear of
// it (licensed captains report there). Pirate zones gather packs; proxy
// zones the proxy's raiders. Far from us those hulls stay on rails and a
// zone produces outcomes, hourly: warships of both sides on station may
// lose one (the side facing the stronger squadron the likelier), raiders
// may take a passing hauler (and now and then lose one to its escort), a
// blockade may stop one that runs it (and with the runners' navy on
// station, the two squadrons now and then come to blows), a proxy's
// raiders are hunted by the navy of the power they prey on, and an
// insurgency's cells cost the navy hulls while it stops their runners.
// The losses are real ships, left as wrecks where they
// fell, and every one between two powers is an incident (politics.js):
// it feeds the crisis, or wears the war down. News of all of it travels
// at light speed (intel.js).
//
// THE ENCOUNTER DIRECTOR runs hourly around our ship only. From the
// local politics — who holds this space, how firmly, which zones we
// are in — it decides whether a patrol, a pirate, a pair of warships
// or a ship in trouble turns up. It calls on the ships that are there
// first: a police cutter on its beat is sent to look at us, a pirate
// lying up nearby wakes, a hauler already in the lane is the one that
// gets jumped. Only when nobody suitable is near does it bring someone
// in from beyond sensor range. The cost never grows with the world.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { random, randRange, randInt, pick, chance, weightedPick, gaussian } from '../core/rng.js';
import { BODIES, bodyPos, circularSpeed } from './ephemeris.js';
import { getWorld, orbitStateAt } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity, CLASSES } from './ship-classes.js';
import { classStrength } from './combatants.js';
import { FACTIONS, POWERS, SUBFACTIONS, controlAt, influenceAt, subsOf } from './factions.js';
import { spawnAgent, makeHostile, wake } from './agents.js';
import { offerUnderAttack } from './missions.js';
import { relay } from './intel.js';
import { createPolitics, dailyRelations, phaseBetween, incident, PAIRS, pairKey } from './politics.js';
import {
  deployToZone, standDown, forcesAt, wreckInPlace, nearestAsleep, awakeNear, rouse, forcesOn, proxyIdentity, sabotageYard,
} from './forces.js';

export { createPolitics, pairKey };

export const ZONE_KINDS = {
  standoff: { label: 'NAVAL STANDOFF', powers: 2, desc: 'Two navies watching each other. Patrols search everyone.' },
  blockade: { label: 'BLOCKADE', powers: 2, desc: 'A navy is stopping traffic. Inspections at the cordon; smugglers pay well.' },
  skirmish: { label: 'SKIRMISH', powers: 2, desc: 'Warships are shooting. Stay out of the way — or profit from the wreckage.' },
  front: { label: 'WAR FRONT', powers: 2, desc: 'Two navies at war, fighting for the space round a body: squadrons on both sides, control points, wrecks.' },
  proxy: { label: 'PROXY WAR', powers: 1, desc: 'Deniable raiders, paid by one power, hitting another\'s shipping. Everyone knows; nobody can prove it.' },
  pirates: { label: 'PIRATE ACTIVITY', powers: 0, desc: 'Raiders working the lanes. Bounties posted; escorts in demand.' },
  insurgency: { label: 'INSURGENCY', powers: 1, desc: 'Belter militants against an inner power. Information is worth money.' },
};

/** Zone kinds between two powers (a power's navy is in them). */
export const NAVAL_KINDS = new Set(['standoff', 'blockade', 'skirmish', 'front']);

const MAX_ZONES = 8;                   // flashpoints at once…
export const ZONE_CAP = MAX_ZONES + 2;  // …and with a war's front and a proxy's raiding ground on top, at most
const MAX_AMBIENT = 6;                 // agents the director keeps around us at most
// A zone's losses: at most this many in any WRECK_WINDOW_MIN (a wreck's
// life: forces.js wreckInPlace), so a long war is fought all the way through
// at a pace the yards can answer, and its wrecks stay few; and a lifetime
// ceiling, never met by a war of the usual length.
const MAX_ZONE_WRECKS = 4;
const MAX_FRONT_WRECKS = 10;
const WRECK_WINDOW_MIN = 8 * DAY_MIN;
const MAX_ZONE_LOSSES = 40, MAX_FRONT_LOSSES = 80;
const QUIET_MIN = [6 * 60, 24 * 60];   // rest after an encounter (minutes)
const FRONT_POINTS = ['ALPHA', 'BRAVO', 'CHARLIE'];

/** The 0–1 heat between two powers (politics.js keeps it in step with their relation). */
export const tension = (state, a, b) => state.politics.tension[pairKey(a, b)] ?? 0;

/** Where a zone is now (AU). */
export function zonePos(zone, minute) {
  const pos = { x: 0, y: 0 }, vel = { vx: 0, vy: 0 };
  orbitStateAt({ body: zone.body, r: zone.r, phase: zone.phase, period: 0 }, minute, pos, vel);
  return pos;
}

/** Zones whose radius (× slack) covers a point. */
export function zonesAt(state, pos, slack = 1) {
  const now = state.clock.minute;
  return state.politics.zones.filter(z => {
    const p = zonePos(z, now);
    return Math.hypot(p.x - pos.x, p.y - pos.y) <= z.radius * slack;
  });
}

/** The zones a power is fighting in (its navy, or its shipping under a proxy's guns). */
export const zonesOf = (state, faction) => state.politics.zones.filter(z => z.factions.includes(faction));

// ---- TICK ----

export function politicsTick(state, emit = () => {}) {
  const now = state.clock.minute;
  if (now % DAY_MIN === 300) dailyPolitics(state, emit);
  if (now % 60 === 17) for (const z of state.politics.zones) zoneIncidents(state, z, emit);
  if (now % 60 === 41) director(state, emit);
}

function dailyPolitics(state, emit) {
  const P = state.politics;
  const now = state.clock.minute;
  dailyRelations(state, (type, payload) => {
    if (type === 'yard-sabotage') sabotageYard(state, payload.faction, payload.days);
    emit(type, payload);
  });
  // Zones follow their powers: grow, fade, escalate, fall silent, end
  for (const z of [...P.zones]) {
    const ph = z.factions.length === 2 ? phaseBetween(state, ...z.factions) : null;
    const want = ph === 'war' ? 0.85 : ph === 'crisis' ? 0.6 : ph === 'cold' ? 0.4 : ph ? 0.2 : 0.55;
    z.intensity = clamp01(z.intensity + 0.06 * gaussian() + 0.15 * (want - z.intensity));
    if (z.kind === 'standoff' && (ph === 'war' || (ph === 'crisis' && z.intensity > 0.7 && chance(0.15)))) {
      z.kind = 'skirmish';
      news(state, z, `Shots fired near ${z.body}: the ${FACTIONS[z.factions[0]].navy}–${FACTIONS[z.factions[1]].navy} standoff has turned into a fight.`);
    } else if (z.kind === 'skirmish' && ph !== 'war' && P.pairs[pairKey(...z.factions)]?.truce) {
      z.kind = 'standoff';
      news(state, z, `The guns fall silent near ${z.body}: ${FACTIONS[z.factions[0]].navy} and ${FACTIONS[z.factions[1]].navy} hold their positions under the ceasefire.`);
    }
    const calm = ph === 'neutral' || ph === 'friendly' || ph === 'allied';
    const over = now >= z.until || z.intensity < 0.08 || (z.kind === 'front' && ph !== 'war') || (NAVAL_KINDS.has(z.kind) && calm)
      || (z.kind === 'proxy' && !P.proxies.some(x => x.id === z.proxy));
    if (over) endZone(state, z);
  }
  // Every war has its front; every proxy its raiding ground
  for (const k of PAIRS) {
    const pr = k.split('-');
    if (P.pairs[k].phase !== 'war' || P.zones.length >= ZONE_CAP || P.zones.some(z => z.kind === 'front' && pairKey(...z.factions) === k)) continue;
    const c = frontCandidate(state, pr);
    if (c) { const z = spawnZone(state, c); if (z) news(state, z, zoneHeadline(z), { started: true }); }
  }
  for (const px of P.proxies) {
    if (P.zones.length >= ZONE_CAP || P.zones.some(z => z.proxy === px.id)) continue;
    const c = proxyCandidate(state, px);
    if (c) { const z = spawnZone(state, c); if (z) news(state, z, zoneHeadline(z), { started: true }); }
  }
  // New flashpoints
  const heat = PAIRS.reduce((s, k) => s + (P.tension[k] || 0), 0) / PAIRS.length;
  if (P.zones.length < MAX_ZONES && chance(0.2 + 0.5 * heat)) {
    const z = spawnZone(state);
    if (z) news(state, z, zoneHeadline(z), { started: true });
  }
}

function endZone(state, z) {
  const P = state.politics;
  P.zones.splice(P.zones.indexOf(z), 1);
  standDown(state, z);
  news(state, z, z.kind === 'front' ? `The front at ${z.body} is quiet. Both fleets pull back.` : `${ZONE_KINDS[z.kind].label} near ${z.body} is over.`, { ended: true });
}

/** Zone news leaves from the zone and reaches us at light speed. */
function news(state, z, text, { started = false, ended = false } = {}) {
  relay(state, zonePos(z, state.clock.minute), 'zone-news', { zoneId: z.id, body: z.body, kind: z.kind, started, ended, text, factions: z.factions },
    { id: z.id, kind: z.kind, body: z.body, factions: z.factions, r: z.r, phase: z.phase, radius: z.radius, ended });
}

/** The clan that works a body's lanes (its lairs), or any. */
function clanFor(body) {
  const clans = subsOf('pirate');
  return clans.find(id => SUBFACTIONS[id].lairs?.includes(body)) || pick(clans);
}

/** Candidate flashpoints from the influence field and the state of the powers right now. */
export function zoneCandidates(state) {
  const now = state.clock.minute;
  const days = now / DAY_MIN;
  const taken = new Set(state.politics.zones.map(z => z.body));
  const out = [];
  for (const b of BODIES) {
    if (!b.a || b.type === 'star' || taken.has(b.name)) continue;
    const p = bodyPos(b, days);
    const ctl = controlAt(p.x, p.y, now);
    const r = Math.hypot(p.x, p.y);
    const belt = r > 2 && r < 3.6, outer = r >= 3.6;
    if (ctl.contested) {
      const pair = [ctl.faction, ctl.rival];
      const ph = phaseBetween(state, ...pair);
      const flip = () => chance(0.5) ? pair : [pair[1], pair[0]];
      if (ph === 'neutral') out.push({ body: b.name, kind: 'standoff', factions: pair, w: 0.05 });
      if (ph === 'cold') out.push({ body: b.name, kind: 'standoff', factions: pair, w: 0.4 });
      if (ph === 'crisis') out.push({ body: b.name, kind: 'standoff', factions: pair, w: 0.6 }, { body: b.name, kind: 'blockade', factions: flip(), w: 0.5 }, { body: b.name, kind: 'skirmish', factions: pair, w: 0.2 });
      if (ph === 'war') out.push({ body: b.name, kind: 'skirmish', factions: pair, w: 1 }, { body: b.name, kind: 'blockade', factions: flip(), w: 0.4 });
    }
    if (ctl.level < 0.6 && (belt || outer)) out.push({ body: b.name, kind: 'pirates', factions: ['pirate'], sub: clanFor(b.name), w: (1 - ctl.level) * (belt ? 1 : 0.6) });
    const inner = ctl.faction === 'UN' || ctl.faction === 'MCR';
    if (inner && ctl.influence.OPA > 0.2) out.push({ body: b.name, kind: 'insurgency', factions: [ctl.faction], sub: 'opa-ceres', w: 0.5 * tension(state, ctl.faction, 'OPA') });
  }
  return out.filter(c => c.w > 0.02);
}

/** Where two powers at war fight: the body both reach furthest, contested or not. */
function frontCandidate(state, pair) {
  const now = state.clock.minute, days = now / DAY_MIN;
  const taken = new Set(state.politics.zones.filter(z => z.kind !== 'standoff' && z.kind !== 'skirmish').map(z => z.body));
  let best = null, bw = 0.08;
  const inf = {};
  for (const b of BODIES) {
    if (!b.a || b.type === 'star' || taken.has(b.name)) continue;
    const p = bodyPos(b, days);
    influenceAt(p.x, p.y, now, inf);
    const w = Math.min(inf[pair[0]], inf[pair[1]]);
    if (w > bw) { bw = w; best = b.name; }
  }
  return best ? { body: best, kind: 'front', factions: pair, w: 1 } : null;
}

/** A proxy's raiding ground: where its target's reach is real but thin, out in the Belt or beyond. */
function proxyCandidate(state, px) {
  const now = state.clock.minute, days = now / DAY_MIN;
  const taken = new Set(state.politics.zones.map(z => z.body));
  const inf = {};
  const pool = [];
  for (const b of BODIES) {
    if (!b.a || b.type === 'star' || taken.has(b.name)) continue;
    const p = bodyPos(b, days);
    if (Math.hypot(p.x, p.y) < 1.8) continue;
    influenceAt(p.x, p.y, now, inf);
    if (inf[px.target] >= 0.15) pool.push({ name: b.name, w: inf[px.target] * (1.2 - inf[px.target]) });
  }
  if (!pool.length) return null;
  const b = weightedPick(pool, x => x.w);
  return { body: b.name, kind: 'proxy', factions: [px.target], proxy: px.id, sub: px.sub, backer: px.backer, until: px.until, w: 1 };
}

export function spawnZone(state, forced = null) {
  const cands = forced ? [forced] : zoneCandidates(state);
  if (!cands.length) return null;
  const c = forced || weightedPick(cands, x => x.w);
  const P = state.politics;
  const now = state.clock.minute;
  const front = c.kind === 'front';
  const z = {
    id: `zone-${P.nextZone++}`, kind: c.kind, factions: c.factions, body: c.body,
    r: randRange(0.002, 0.01), phase: random() * Math.PI * 2,
    radius: front ? randRange(0.04, 0.07) : c.kind === 'skirmish' ? randRange(0.01, 0.03) : randRange(0.02, 0.06),
    intensity: front ? 0.85 : randRange(0.35, 0.7), born: now,
    until: c.until ?? now + (front ? 120 : randInt(5, 30)) * DAY_MIN, wrecks: 0,
    ...(c.sub ? { sub: c.sub } : {}), ...(c.proxy ? { proxy: c.proxy, backer: c.backer } : {}),
  };
  // A front is fought over a few control points round the body (contracts.js: holding one)
  if (front) z.points = FRONT_POINTS.slice(0, randInt(2, 3)).map((name, i) => ({ name, held: c.factions[i % 2], phase: z.phase + (i - 1) * 0.35 }));
  P.zones.push(z);
  deployToZone(state, z);
  return z;
}

function zoneHeadline(z) {
  const f = (i) => FACTIONS[z.factions[i]];
  const sub = z.sub ? SUBFACTIONS[z.sub] : null;
  switch (z.kind) {
    case 'standoff': return `${f(0).navy} and ${f(1).navy} warships are facing off near ${z.body}.`;
    case 'blockade': return `${f(0).navy} has declared a blockade around ${z.body}. All traffic subject to search.`;
    case 'skirmish': return `Fighting reported near ${z.body} between ${f(0).navy} and ${f(1).navy} forces.`;
    case 'front': return `The ${f(0).navy} and ${f(1).navy} fleets are fighting for ${z.body}: a war front has formed there.`;
    case 'proxy': return `Raiders flying ${sub ? `${sub.name} colours` : 'no colours'} are hitting ${f(0).short} shipping near ${z.body}.`;
    case 'pirates': return `Ships going missing near ${z.body}. ${sub ? `The ${sub.name} are suspected.` : 'Pirate activity suspected.'}`;
    case 'insurgency': return `Bombings and sabotage on ${z.body}: ${sub ? sub.name : 'Belter'} cells against ${f(0).name}.`;
    default: return `Trouble near ${z.body}.`;
  }
}

/**
 * Off-screen consequences, hourly. With the background forces running,
 * the losses are real hulls: warships on station at a standoff, a
 * skirmish or a front (and at a blockade or a proxy's raiding ground when
 * both sides are there), traffic in the lanes through a pirate zone, a
 * proxy's raiding ground or a blockade, raiders lost to a hauler's guns,
 * an insurgency's navy hulls and the runners it stops. Nobody there,
 * nothing happens (the squadrons may still be on their way). Without them
 * (test suites), and an insurgency's toll with nothing passing, a loss is
 * rolled up from the zone's politics. A wreck stays where it fell.
 */
const INCIDENT_RATE = { front: 0.1, skirmish: 0.06, pirates: 0.04, proxy: 0.04, blockade: 0.01, standoff: 0.005, insurgency: 0.01 };

function zoneIncidents(state, z, emit) {
  const front = z.kind === 'front', now = state.clock.minute;
  if (z.wrecks >= (front ? MAX_FRONT_LOSSES : MAX_ZONE_LOSSES)) return;
  const recent = (z.lossAt ||= []);
  while (recent.length && now - recent[0] > WRECK_WINDOW_MIN) recent.shift();
  if (recent.length >= (front ? MAX_FRONT_WRECKS : MAX_ZONE_WRECKS)) return;
  const rate = (INCIDENT_RATE[z.kind] || 0) * z.intensity;
  if (forcesOn(state)) {
    const loss = zoneLoss(state, z, rate);
    if (loss) { reportLoss(state, z, loss.e, loss.text); return; }
    if (loss !== undefined) return;
    // (an insurgency's toll this hour with nothing passing to take it: rolled up, as without the forces)
  } else if (!chance(rate)) return;
  const world = getWorld(state);
  const victim = z.kind === 'skirmish' || z.kind === 'front'
    ? rollIdentity({ category: 'military', faction: pick(z.factions), state })
    : rollIdentity({ category: 'civilian', state });
  const e = createEntity({
    id: world.newId('wreck'), name: `${victim.name} (wreck)`, type: 'ship', faction: victim.faction, cls: victim.cls, tl: victim.tl,
    shipClass: victim.shipClass, mass: victim.mass, transponder: false,
    orbit: { body: z.body, r: z.r + randRange(-0.003, 0.003), phase: z.phase + randRange(-0.5, 0.5), period: 0 },
    tags: { wreck: true, zone: z.id, despawnAt: state.clock.minute + 8 * DAY_MIN },
  });
  if (victim.sub) e.sub = victim.sub;
  e.combat = { hp: 0, hpMax: 1, drive: 0, reactor: 0, weapons: 0, sensors: 0, crew: 0, status: 'wreck', containment: null, scrammed: true, rounds: 0, magazine: { he: 0, nuke: 0 }, tubes: [], rail: [] };
  world.add(e);
  reportLoss(state, z, e, `${victim.shipClass} ${victim.name} lost near ${z.body}.`);
}

/** Of the hours a blockade could cost a ship, the share its squadron and the runners' navy (on station too) fight instead. */
const BLOCKADE_CLASH = 0.3;
/** Of a proxy zone's hours, the share the target power's navy (on station) spends hunting the raiders. */
const PROXY_HUNT = 0.5;
/** Of a pirate zone's takings, the share that costs the raiders one instead (a hauler's guns, its escort). */
const PIRATE_TOLL = 0.15;
/** Of an insurgency's hours with the navy on station, the share the cells cost it a hull (a mine, a bomb aboard). */
const CELL_STRIKE = 0.4;

/**
 * Who, if anyone, the zone costs this hour: { e, text }, or null. (An
 * insurgency with nobody there to hit and nobody passing: undefined, for
 * the toll rolled up from its politics.)
 */
function zoneLoss(state, z, rate) {
  const there = forcesAt(state, z);
  const [f0, f1] = z.factions;
  const ours = there[f0] || [];
  if (z.kind === 'skirmish' || z.kind === 'standoff' || z.kind === 'front') return clash(z, ours, there[f1] || [], rate);
  if (z.kind === 'blockade' && ours.length && there[f1]?.length && chance(BLOCKADE_CLASH)) return clash(z, ours, there[f1], rate);
  if (z.kind === 'proxy' && ours.length && there.$proxy?.length && chance(PROXY_HUNT)) return clash(z, ours, there.$proxy, rate);
  if (z.kind === 'insurgency') {
    if (ours.length && chance(CELL_STRIKE)) {
      if (!chance(rate)) return null;
      const e = pick(ours);
      return { e, text: `${e.shipClass} ${e.name} lost to a cell's mine near ${z.body}.` };
    }
    if (!chance(rate)) return null;
    const lane = traffickedNear(state, z);
    if (!lane) return undefined;
    return { e: lane, text: ours.length ? `${lane.shipClass} ${lane.name} disabled near ${z.body} by the ${FACTIONS[f0].navy}, suspected of running for the cells.` : `${lane.shipClass} ${lane.name} bombed by the cells near ${z.body}.` };
  }
  const hunters = z.kind === 'pirates' ? (there.pirate || []) : z.kind === 'proxy' ? (there.$proxy || []) : ours;
  if (!hunters.length || !chance(rate * Math.min(1, hunters.length / 3))) return null;
  const lane = traffickedNear(state, z, z.kind === 'proxy' ? f0 : null);
  if (!lane) return null;
  if (z.kind === 'pirates' && chance(PIRATE_TOLL)) {
    const e = pick(hunters);
    return { e, text: `${e.shipClass} ${e.name} lost near ${z.body}, to the guns of the ${lane.name} it meant to take.` };
  }
  const how = z.kind === 'pirates' ? 'taken by raiders' : z.kind === 'proxy' ? `taken by ${SUBFACTIONS[z.sub]?.name || 'raiders'}` : `disabled running the ${FACTIONS[f0].navy} blockade`;
  return { e: lane, text: `${lane.shipClass} ${lane.name} ${how} near ${z.body}.` };
}

/**
 * Two squadrons on station come to blows (as often as the hour's rate and
 * their numbers allow), and one of them loses a ship. Which: each side's
 * hulls fall as fast as the other side's guns allow and as hard as its own
 * hulls are to kill (Lanchester's linear law, a hull's worth its
 * toughness: side A loses ∝ nA·mightB/mightA). So twenty-two UNN corvettes
 * against five MCRN frigates of the same total might lose about five hulls
 * for each of the Martians', the worth lost on each side about even, and
 * a few good ships are not traded one for one against many poor ones. At a
 * front the loser may lose ground too, a control point it held.
 */
function clash(z, a, b, rate) {
  if (!a.length || !b.length || !chance(rate * Math.min(1, (a.length + b.length) / 4))) return null;
  const might = (side) => side.reduce((m, e) => m + (CLASSES[e.cls] ? classStrength(e.cls) : 1), 0);
  const ma = might(a), mb = might(b);
  const la = a.length * mb / ma, lb = b.length * ma / mb;
  const side = chance(la / (la + lb)) ? a : b;
  const e = pick(side);
  if (z.points && chance(0.35)) {
    const held = z.points.filter(pt => pt.held === e.faction);
    if (held.length) pick(held).held = z.factions.find(f => f !== e.faction);
  }
  const raider = e.tags?.force?.role === 'proxy';
  return { e, text: raider ? `${e.shipClass} ${e.name} hunted down near ${z.body} by the ${FACTIONS[z.factions[0]].navy}.`
    : `${e.shipClass} ${e.name} lost near ${z.body}${z.kind === 'standoff' ? '' : ' in the fighting'}.` };
}

/**
 * A traffic ship in transit through the zone (of one power, for a proxy's
 * raiders), if any. Far from us a ship's place on the world's hash may be
 * up to a day old (world.js): those filed within half an AU are looked at,
 * each placed exactly before it counts (in a random order, at most
 * LANE_LOOKS of them: a lane's loss is rare, the crowd round a hub large).
 */
const LANE_PAD_AU = 0.5, LANE_LOOKS = 500;
function traffickedNear(state, z, faction = null) {
  const world = getWorld(state), now = state.clock.minute;
  const p = zonePos(z, now);
  const cands = world.query(p, z.radius + LANE_PAD_AU).filter(e => e.tags?.traffic && e.transit && !e.agent && !e.tags.wreck && (!faction || e.faction === faction));
  const pool = [];
  for (let k = 0; k < cands.length && k < LANE_LOOKS; k++) {
    const j = k + Math.floor(random() * (cands.length - k));
    const e = cands[j]; cands[j] = cands[k];
    world.refresh(e, now); world.hash.update(e);
    if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y) <= z.radius) pool.push(e);
  }
  return pool.length ? pick(pool) : null;
}

function reportLoss(state, z, e, text) {
  if (!e.tags.wreck) wreckInPlace(state, e, z.body);
  e.tags.zone = z.id;
  z.wrecks++;
  (z.lossAt ||= []).push(state.clock.minute);
  // Every loss between two powers is an incident: it feeds a crisis, or wears a war down
  if (z.factions.length === 2 && NAVAL_KINDS.has(z.kind)) incident(state, z.factions[0], z.factions[1], z.kind === 'blockade' ? 0.3 : 1);
  else if (z.kind === 'insurgency') incident(state, 'OPA', z.factions[0], 0.5);
  else if (z.kind === 'proxy' && z.backer) incident(state, z.backer, z.factions[0], 0.2);
  relay(state, e.pos, 'zone-incident', { zoneId: z.id, entityId: e.id, chart: e.id, text, source: 'NEWSFEED' });
}

// ---- ENCOUNTERS ----

function ambientCount(state) {
  let n = 0;
  for (const e of getWorld(state).driven) if (e.agent?.ambient && !e.agent.contract) n++;
  return n;
}

/** A position and local-rest-frame velocity at `distAU` from us. */
function nearUs(state, distAU) {
  const sp = state.flight.pos;
  const ang = random() * Math.PI * 2;
  const pos = { x: sp.x + Math.cos(ang) * distAU, y: sp.y + Math.sin(ang) * distAU };
  return { pos, vel: restFrame(pos) };
}

function restFrame(pos) {
  const v = circularSpeed(Math.hypot(pos.x, pos.y));
  const th = Math.atan2(pos.y, pos.x) + Math.PI / 2;
  const pa = random() * Math.PI * 2, pm = randRange(20, 200);
  return { vx: v * Math.cos(th) + pm * Math.cos(pa), vy: v * Math.sin(th) + pm * Math.sin(pa) };
}

/** Hourly, around our ship: does anyone show up? */
export function director(state, emit = () => {}) {
  const now = state.clock.minute;
  if (state.lost || now < (state.politics.quietUntil ?? 0) || ambientCount(state) >= MAX_AMBIENT) return null;
  const sp = state.flight.pos;
  const ctl = controlAt(sp.x, sp.y, now);
  const zones = zonesAt(state, sp, 1.5);
  const lawless = Math.max(0, 1 - ctl.level / 0.6);
  const nearStation = getWorld(state).stations.some(s => Math.hypot(s.pos.x - sp.x, s.pos.y - sp.y) < 0.005);
  const roll = [];

  // Police on their beat
  if (ctl.faction) roll.push({ kind: 'patrol', p: 0.06 * ctl.level, faction: ctl.faction });
  for (const z of zones) {
    if (z.kind === 'standoff') roll.push({ kind: 'patrol', p: 0.12 * z.intensity, faction: pick(z.factions), zone: z.id });
    if (z.kind === 'blockade') roll.push({ kind: 'picket', p: 0.2 * z.intensity, faction: z.factions[0], zone: z.id, body: z.body });
    if (z.kind === 'skirmish' || z.kind === 'front') roll.push({ kind: 'battle', p: (z.kind === 'front' ? 0.3 : 0.2) * z.intensity, zone: z });
    if (z.kind === 'proxy') roll.push({ kind: 'raid', p: 0.1 * z.intensity, zone: z });
    if (z.kind === 'pirates') roll.push({ kind: 'pirate', p: 0.12 * z.intensity, zone: z.id }, { kind: 'ambush', p: 0.05 * z.intensity, zone: z.id });
  }
  if (!nearStation) roll.push({ kind: 'pirate', p: 0.04 * lawless }, { kind: 'ambush', p: 0.02 * lawless });

  for (const r of roll) {
    if (!chance(r.p)) continue;
    const e = spawnEncounter(state, r, emit);
    if (e) { state.politics.quietUntil = now + randInt(QUIET_MIN[0], QUIET_MIN[1]); return e; }
  }
  return null;
}

/** Make one encounter happen now (also a dev/test hook). */
export function spawnEncounter(state, r, emit = () => {}) {
  // Ships already out there first; null means "already here", undefined "nobody near"
  const local = forcesOn(state) ? fromPopulation(state, r, emit) : undefined;
  if (local !== undefined) return local;
  switch (r.kind) {
    case 'patrol': case 'picket': {
      const { pos, vel } = nearUs(state, randRange(0.003, 0.012));
      const home = r.kind === 'picket' ? { kind: 'body', id: r.body } : null;
      const e = spawnAgent(state, { role: r.kind, kind: 'cutter', category: 'authority', faction: r.faction, pos, vel, ambient: true, zone: r.zone || null, home });
      emit('encounter', { kind: r.kind, id: e.id, name: e.name, faction: e.faction });
      return e;
    }
    case 'pirate': {
      const { pos, vel } = nearUs(state, randRange(0.006, 0.02));
      const e = spawnAgent(state, { role: 'pirate', category: 'irregular', faction: 'pirate', pos, vel, ambient: true, zone: r.zone || null, transponder: false });
      emit('encounter', { kind: 'pirate', id: e.id, name: e.name, faction: 'pirate' });
      return e;
    }
    case 'ambush': {
      const { pos, vel } = nearUs(state, randRange(0.004, 0.015));
      const victim = spawnAgent(state, { role: 'civilian', category: 'civilian', pos, vel, ambient: true });
      return ambush(state, victim, r, emit);
    }
    case 'raid': {
      // A proxy's raider, out for the target power's shipping (and its contractors)
      const z = r.zone;
      const { pos, vel } = nearUs(state, randRange(0.006, 0.02));
      const id = proxyIdentity(z.sub);
      const e = spawnAgent(state, { role: 'pirate', cls: id.cls, faction: id.faction, sub: z.sub, pos, vel, ambient: true, zone: z.id, transponder: false, flags: { prey: z.factions[0] }, tags: { proxy: z.sub, wanted: true } });
      emit('encounter', { kind: 'raid', id: e.id, name: e.name, faction: e.faction });
      return e;
    }
    case 'battle': {
      const z = r.zone;
      const [fa, fb] = z.factions;
      const { pos, vel } = nearUs(state, randRange(0.004, 0.012));
      const off = 0.0015;
      const ang = random() * Math.PI * 2;
      const kind = () => pick(['corvette', 'corvette', 'frigate', 'destroyer']);
      const a = spawnAgent(state, { role: 'navy', kind: kind(), category: 'military', faction: fa, pos, vel, ambient: true, zone: z.id, enemies: [fb] });
      const bpos = { x: pos.x + Math.cos(ang) * off, y: pos.y + Math.sin(ang) * off };
      const b = spawnAgent(state, { role: 'navy', kind: kind(), category: 'military', faction: fb, pos: bpos, vel: restFrame(bpos), ambient: true, zone: z.id, enemies: [fa] });
      makeHostile(state, a, b.id);
      makeHostile(state, b, a.id);
      emit('encounter', { kind: 'battle', id: a.id, name: `${a.name} and ${b.name}`, faction: fa });
      return a;
    }
  }
  return null;
}

/** A pirate already on `victim` (a mayday for us to answer). */
function ambush(state, victim, r, emit) {
  const ang = random() * Math.PI * 2;
  const vp = victim.pos;
  const ppos = { x: vp.x + Math.cos(ang) * 0.0008, y: vp.y + Math.sin(ang) * 0.0008 };
  const pirate = spawnAgent(state, { role: 'pirate', category: 'irregular', faction: 'pirate', pos: ppos, vel: { ...victim.vel }, ambient: true, transponder: false, zone: r.zone || null });
  makeHostile(state, pirate, victim.id);
  makeHostile(state, victim, pirate.id);
  getWorld(state).setSos(victim, true);
  offerUnderAttack(state, victim, [pirate.id], emit);
  return victim;
}

/**
 * The director's errand for ships already out there: a cutter on its beat
 * sent to look at us, a pirate lying up nearby, a hauler in the lane.
 * Returns the ship, null when the encounter is already here (a zone's
 * warships, awake around us), or undefined when nobody suitable is near.
 */
function fromPopulation(state, r, emit) {
  switch (r.kind) {
    case 'patrol': {
      const e = awakeNear(state, 'police', r.faction).find(o => o.agent.flags.routine) || nearestAsleep(state, 'police', r.faction);
      if (!e) return undefined;
      if (!e.agent) rouse(state, e);
      const a = e.agent;
      a.flags.routine = false;
      a.flags.checked = false;
      a.flags.beat = a.home;
      a.home = { kind: 'player' };
      a.mode = 'cruise';
      emit('encounter', { kind: 'patrol', id: e.id, name: e.name, faction: e.faction });
      return e;
    }
    case 'pirate': {
      if (awakeNear(state, 'pirate').length) return null;
      const e = nearestAsleep(state, 'pirate');
      if (!e) return undefined;
      rouse(state, e);
      emit('encounter', { kind: 'pirate', id: e.id, name: e.name, faction: 'pirate' });
      return e;
    }
    case 'raid': {
      if (awakeNear(state, 'proxy').length) return null;
      const e = nearestAsleep(state, 'proxy');
      if (!e) return undefined;
      rouse(state, e);
      emit('encounter', { kind: 'raid', id: e.id, name: e.name, faction: e.faction });
      return e;
    }
    case 'battle': case 'picket': {
      const zoneId = r.kind === 'battle' ? r.zone?.id : r.zone;
      return awakeNear(state, 'navy').some(o => o.tags.force.zone === zoneId) ? null : undefined;
    }
    case 'ambush': {
      const lane = getWorld(state).query(state.flight.pos, 0.015).filter(o => o.tags?.traffic && o.transit && !o.agent);
      if (!lane.length) return undefined;
      return ambush(state, wake(state, pick(lane), 'civilian'), r, emit);
    }
  }
  return undefined;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
