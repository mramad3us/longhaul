// ============================================================
// LONGHAUL — Conflict: tension, hot zones, encounters
//
// POLITICS. Each pair of powers has a tension (0 calm … 1 open war)
// that wanders day to day, pulled back toward its baseline and pushed
// up by fighting.
//
// HOT ZONES are where it shows. They are born procedurally from the
// influence field: wherever two powers' reach overlaps (a contested
// moon, a belt rock with a Martian claim) tension can flare into a
// naval STANDOFF, a BLOCKADE, or — if it runs hot — a SKIRMISH; where
// nobody's writ runs, PIRATES gather; where the Belt chafes under an
// inner power, an INSURGENCY simmers. A zone sits on a body (it moves
// with it), has a radius and an intensity, grows or fades, and ends.
// Zones shape everything nearby: who patrols, who lurks, what the
// station boards offer, what turns up wrecked.
//
// THE ENCOUNTER DIRECTOR runs hourly around our ship only. From the
// local politics — who holds this space, how firmly, which zones we
// are in — it decides whether a patrol, a pirate, a pair of warships
// or a ship in trouble appears at the edge of sensor range. Far from
// us, zones produce outcomes (wrecks, news) without simulating ships,
// so the cost never grows with the size of the world.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { random, randRange, randInt, pick, chance, weightedPick, gaussian } from '../core/rng.js';
import { BODIES, bodyPos, circularSpeed } from './ephemeris.js';
import { getWorld, orbitStateAt } from './world.js';
import { createEntity } from './entities.js';
import { rollIdentity } from './ship-classes.js';
import { FACTIONS, controlAt } from './factions.js';
import { spawnAgent, makeHostile } from './agents.js';
import { offerUnderAttack } from './missions.js';

export const ZONE_KINDS = {
  standoff: { label: 'NAVAL STANDOFF', powers: 2, desc: 'Two navies watching each other. Patrols search everyone.' },
  blockade: { label: 'BLOCKADE', powers: 2, desc: 'A navy is stopping traffic. Inspections at the cordon; smugglers pay well.' },
  skirmish: { label: 'SKIRMISH', powers: 2, desc: 'Warships are shooting. Stay out of the way — or profit from the wreckage.' },
  pirates: { label: 'PIRATE ACTIVITY', powers: 0, desc: 'Raiders working the lanes. Bounties posted; escorts in demand.' },
  insurgency: { label: 'INSURGENCY', powers: 1, desc: 'Belter militants against an inner power. Information is worth money.' },
};

const BASELINE = { 'MCR-UN': 0.45, 'OPA-UN': 0.3, 'MCR-OPA': 0.35 };
const MAX_ZONES = 6;
const MAX_AMBIENT = 6;                 // agents the director keeps around us at most
const MAX_ZONE_WRECKS = 4;
const QUIET_MIN = [6 * 60, 24 * 60];   // rest after an encounter (minutes)

export const pairKey = (a, b) => [a, b].sort().join('-');

export function createPolitics() {
  // quietUntil: no new encounters around us before this minute (the director rests after each one)
  return { tension: { ...BASELINE }, zones: [], nextZone: 1, quietUntil: 6 * 60 };
}

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
  // Tension wanders, pulled toward its baseline; fighting pushes it up
  for (const k of Object.keys(P.tension)) {
    const fights = P.zones.filter(z => z.kind === 'skirmish' && pairKey(...z.factions) === k).length;
    P.tension[k] = clamp01(P.tension[k] + 0.03 * gaussian() + 0.05 * (BASELINE[k] - P.tension[k]) + 0.02 * fights);
  }
  // Zones grow, fade, escalate, end
  for (const z of [...P.zones]) {
    const t = z.factions.length === 2 ? tension(state, ...z.factions) : 0.5;
    z.intensity = clamp01(z.intensity + 0.08 * gaussian() + 0.08 * (t - 0.5));
    if (z.kind === 'standoff' && t > 0.65 && z.intensity > 0.7 && chance(0.3)) {
      z.kind = 'skirmish';
      emit('zone-news', { zone: z, text: `Shots fired near ${z.body}: the ${FACTIONS[z.factions[0]].navy}–${FACTIONS[z.factions[1]].navy} standoff has turned into a fight.` });
    }
    if (now >= z.until || z.intensity < 0.08) {
      P.zones.splice(P.zones.indexOf(z), 1);
      if (z.kind === 'skirmish') P.tension[pairKey(...z.factions)] = clamp01(tension(state, ...z.factions) - 0.05);
      emit('zone-news', { zone: z, ended: true, text: `${ZONE_KINDS[z.kind].label} near ${z.body} is over.` });
    }
  }
  // New flashpoints
  const avg = Object.values(P.tension).reduce((a, b) => a + b, 0) / 3;
  if (P.zones.length < MAX_ZONES && chance(0.25 + 0.6 * avg)) {
    const z = spawnZone(state);
    if (z) emit('zone-news', { zone: z, started: true, text: zoneHeadline(z) });
  }
}

/** Candidate flashpoints from the influence field right now. */
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
      const t = tension(state, ctl.faction, ctl.rival);
      const pair = [ctl.faction, ctl.rival];
      out.push({ body: b.name, kind: 'standoff', factions: pair, w: t });
      out.push({ body: b.name, kind: 'blockade', factions: chance(0.5) ? pair : [pair[1], pair[0]], w: t * 0.7 });
      if (t > 0.6) out.push({ body: b.name, kind: 'skirmish', factions: pair, w: (t - 0.5) * 2 });
    }
    if (ctl.level < 0.6 && (belt || outer)) out.push({ body: b.name, kind: 'pirates', factions: ['pirate'], w: (1 - ctl.level) * (belt ? 1 : 0.6) });
    const inner = ctl.faction === 'UN' || ctl.faction === 'MCR';
    if (inner && ctl.influence.OPA > 0.2) out.push({ body: b.name, kind: 'insurgency', factions: [ctl.faction], w: 0.5 * tension(state, ctl.faction, 'OPA') });
  }
  return out.filter(c => c.w > 0.02);
}

export function spawnZone(state, forced = null) {
  const cands = forced ? [forced] : zoneCandidates(state);
  if (!cands.length) return null;
  const c = forced || weightedPick(cands, x => x.w);
  const P = state.politics;
  const now = state.clock.minute;
  const z = {
    id: `zone-${P.nextZone++}`, kind: c.kind, factions: c.factions, body: c.body,
    r: randRange(0.002, 0.01), phase: random() * Math.PI * 2,
    radius: c.kind === 'skirmish' ? randRange(0.01, 0.03) : randRange(0.02, 0.06),
    intensity: randRange(0.35, 0.7), born: now, until: now + randInt(5, 30) * DAY_MIN, wrecks: 0,
  };
  P.zones.push(z);
  return z;
}

function zoneHeadline(z) {
  const f = (i) => FACTIONS[z.factions[i]];
  switch (z.kind) {
    case 'standoff': return `${f(0).navy} and ${f(1).navy} warships are facing off near ${z.body}.`;
    case 'blockade': return `${f(0).navy} has declared a blockade around ${z.body}. All traffic subject to search.`;
    case 'skirmish': return `Fighting reported near ${z.body} between ${f(0).navy} and ${f(1).navy} forces.`;
    case 'pirates': return `Ships going missing near ${z.body}. Pirate activity suspected.`;
    case 'insurgency': return `Bombings and sabotage on ${z.body}: Belter militants against ${f(0).name}.`;
    default: return `Trouble near ${z.body}.`;
  }
}

/** Off-screen consequences: ships lost in the zone become wrecks to salvage. */
function zoneIncidents(state, z, emit) {
  const rate = { skirmish: 0.06, pirates: 0.04, blockade: 0.01, standoff: 0.005, insurgency: 0.01 }[z.kind] || 0;
  if (z.wrecks >= MAX_ZONE_WRECKS || !chance(rate * z.intensity)) return;
  const world = getWorld(state);
  const victim = z.kind === 'skirmish'
    ? rollIdentity({ category: 'military', faction: pick(z.factions) })
    : rollIdentity({ category: 'civilian' });
  const e = createEntity({
    id: world.newId('wreck'), name: `${victim.name} (wreck)`, type: 'ship', faction: victim.faction, cls: victim.cls, tl: victim.tl,
    shipClass: victim.shipClass, mass: victim.mass, transponder: false,
    orbit: { body: z.body, r: z.r + randRange(-0.003, 0.003), phase: z.phase + randRange(-0.5, 0.5), period: 0 },
    tags: { wreck: true, zone: z.id, despawnAt: state.clock.minute + 8 * DAY_MIN },
  });
  e.combat = { hp: 0, hpMax: 1, drive: 0, reactor: 0, weapons: 0, sensors: 0, crew: 0, status: 'wreck', containment: null, scrammed: true, rounds: 0, magazine: { he: 0, nuke: 0 }, tubes: [], rail: [] };
  world.add(e);
  z.wrecks++;
  emit('zone-incident', { zone: z, entity: e, text: `${victim.shipClass} ${victim.name} lost near ${z.body}.` });
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
    if (z.kind === 'skirmish') roll.push({ kind: 'battle', p: 0.2 * z.intensity, zone: z });
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
  switch (r.kind) {
    case 'patrol': case 'picket': {
      const { pos, vel } = nearUs(state, randRange(0.003, 0.012));
      const home = r.kind === 'picket' ? { kind: 'body', id: r.body } : null;
      const e = spawnAgent(state, { role: r.kind, cls: 'cutter', faction: r.faction, pos, vel, ambient: true, zone: r.zone || null, home });
      emit('encounter', { kind: r.kind, id: e.id, name: e.name, faction: e.faction });
      return e;
    }
    case 'pirate': {
      const { pos, vel } = nearUs(state, randRange(0.006, 0.02));
      const e = spawnAgent(state, { role: 'pirate', cls: chance(0.7) ? 'pirate-raider' : 'pirate-gunship', faction: 'pirate', pos, vel, ambient: true, zone: r.zone || null, transponder: false });
      emit('encounter', { kind: 'pirate', id: e.id, name: e.name, faction: 'pirate' });
      return e;
    }
    case 'ambush': {
      const { pos, vel } = nearUs(state, randRange(0.004, 0.015));
      const victim = spawnAgent(state, { role: 'civilian', category: 'civilian', pos, vel, ambient: true });
      const ang = random() * Math.PI * 2;
      const ppos = { x: pos.x + Math.cos(ang) * 0.0008, y: pos.y + Math.sin(ang) * 0.0008 };
      const pirate = spawnAgent(state, { role: 'pirate', cls: chance(0.6) ? 'pirate-raider' : 'pirate-gunship', faction: 'pirate', pos: ppos, vel: { ...vel }, ambient: true, transponder: false, zone: r.zone || null });
      makeHostile(state, pirate, victim.id);
      makeHostile(state, victim, pirate.id);
      getWorld(state).setSos(victim, true);
      offerUnderAttack(state, victim, [pirate.id], emit);
      return victim;
    }
    case 'battle': {
      const z = r.zone;
      const [fa, fb] = z.factions;
      const { pos, vel } = nearUs(state, randRange(0.004, 0.012));
      const off = 0.0015;
      const ang = random() * Math.PI * 2;
      const cls = () => pick(['corvette', 'corvette', 'frigate', 'destroyer']);
      const a = spawnAgent(state, { role: 'navy', cls: cls(), faction: fa, pos, vel, ambient: true, zone: z.id, enemies: [fb] });
      const bpos = { x: pos.x + Math.cos(ang) * off, y: pos.y + Math.sin(ang) * off };
      const b = spawnAgent(state, { role: 'navy', cls: cls(), faction: fb, pos: bpos, vel: restFrame(bpos), ambient: true, zone: z.id, enemies: [fa] });
      makeHostile(state, a, b.id);
      makeHostile(state, b, a.id);
      emit('encounter', { kind: 'battle', id: a.id, name: `${a.name} and ${b.name}`, faction: fa });
      return a;
    }
  }
  return null;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
