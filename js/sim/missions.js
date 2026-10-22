// ============================================================
// LONGHAUL — Distress calls (SOS missions)
// Random emergencies near the ship: fuel-dry drifters, dead drives,
// runaway torches, scrammed reactors. Accept → intercept → hold
// formation → hail to complete the rescue.
// UNDER ATTACK calls come from the encounter director (conflict.js):
// a ship with pirates on it. Drive them off or kill them, then hail.
// ============================================================

import { AU_M, RANGE, DAY_MIN } from '../core/constants.js';
import { random, randRange, randInt, pick, weightedPick, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { circularSpeed } from './ephemeris.js';
import { createEntity } from './entities.js';
import { rollIdentity } from './ship-classes.js';
import { controlAt } from './factions.js';
import { createPlan, simulatePlan, STANDOFF } from './nav.js';

export const SosType = {
  FUEL_DRY: 'FUEL_DRY',
  ENGINE_FAILURE: 'ENGINE_FAILURE',
  RUNAWAY: 'RUNAWAY',
  REACTOR_SCRAM: 'REACTOR_SCRAM',
  UNDER_ATTACK: 'UNDER_ATTACK',
};

const DEF = {
  UNDER_ATTACK: { weight: 0, timer: 2 * DAY_MIN, rewards: { credits: 3500, parts: 4, pdcRounds: 4000 },
    accept: 'Move to engage', decline: 'Stay clear',
    story: [
      'MAYDAY — the {name}, a {cls}: "We have a raider on us, they\'re launching! Any ship, any ship — we have no guns!"',
      'Panic on the open channel. The {cls} {name} is being run down by pirates: "They want the cargo and they don\'t care if we\'re alive. Please — anyone."',
    ],
    rescue: 'The {name}\'s captain comes on, hoarse: "We thought we were dead." They send over what they can spare from the hold and swear to buy you a drink on any station in the Belt.' },
  FUEL_DRY: { weight: 4, timer: 2160, rewards: { credits: 900, water: 200, food: 100 },
    accept: 'Plot rescue intercept', decline: 'Log position and continue',
    story: [
      'A distress beacon cuts through the static. The {name}, a {cls}, is broadcasting mayday — tanks dry, drifting on residual vector. {crew} souls aboard, scrubbers on battery reserve.',
      'Emergency beacon. The {name}, a {cls} registered to {faction}, reports fuel exhaustion mid-transit. Cold-drifting, life support on emergency power.',
    ],
    rescue: 'You run the fuel umbilical across and pump enough reaction mass to get them moving. Their captain comes on comms, voice shaking with relief, and transfers what supplies they can spare.' },
  ENGINE_FAILURE: { weight: 3, timer: 1440, rewards: { credits: 1200, fuel: 500 },
    accept: 'Plot rescue intercept', decline: 'Log position and continue',
    story: [
      'Mayday: the {name}, a {cls}, reports catastrophic drive failure — assembly seized mid-burn. Reserves intact, no way to maneuver. {crew} crew requesting immediate assistance.',
      'Distress call from the {cls} {name}: main drive offline, cause unknown. Drifting unpowered with fuel aboard. Requesting tow or repair.',
    ],
    rescue: 'Your engineer talks their crew through a field bypass of the damaged drive assembly. After twenty tense minutes their engine coughs back to life. They insist on paying in reaction mass.' },
  RUNAWAY: { weight: 1, timer: 480, rewards: { credits: 2500, fuel: 200, medSupplies: 10 },
    accept: 'Emergency intercept — NOW', decline: 'Cannot assist — log and continue',
    story: [
      'PRIORITY — the {name}, a {cls}, on all frequencies: throttle control failure, drive locked at full burn. Crew under {g}G sustained. Without intervention the G-load will kill them.',
      'Critical distress: {cls} {name} reports a stuck throttle. Epstein running uncontrolled at {g}G. Crew losing consciousness. Ship accelerating on an uncontrolled vector.',
    ],
    rescue: 'Matching their burn is brutal. You hold formation while your engineer patches into their fuel management and cuts the flow. The silence when their drive dies is deafening. Battered, but alive.' },
  REACTOR_SCRAM: { weight: 2, timer: 720, rewards: { credits: 1500, medSupplies: 15, o2Tank: 50 },
    accept: 'Plot rescue course', decline: 'Log position and continue',
    story: [
      'Emergency beacon from the {name}, a {cls}: reactor scram, total power loss. Dark ship — no heat, no recyclers. {crew} crew in EVA suits, about {hours} hours of suit O₂.',
      'The {name} has gone dark. Automated beacon reports containment failure on this {cls}. Survival depends on suit reserves.',
    ],
    rescue: 'You crack their emergency lock and find the crew huddled in the machine shop, breath fogging their visors. Your medic gets to work while the engineer jury-rigs their containment.' },
};

const CHATTER = {
  FUEL_DRY: { normal: ['{name} to any ship... fuel dry, requesting assistance. We can hold for now.', 'This is {name}, mayday on all channels. Fuel exhausted. Drifting.'],
    urgent: ['{name} here... CO₂ is building. Scrubbers at half capacity. Please hurry.', 'Getting hard to breathe on the {name}. Anyone out there?'],
    critical: ['{name} to any... ship... air is... getting bad...', 'Mayday mayday... {name}... crew losing consciousness...'] },
  ENGINE_FAILURE: { normal: ['{name}, engine down. Power and life support holding. Standing by.', 'This is the {name}. Main drive inoperable. Requesting tow.'],
    urgent: ['{name} here. Still drifting, further from the lanes every hour...', '{name} requesting anyone in range.'],
    critical: ['{name}... if anyone hears this... supplies running low.', '{name} broadcasting... hope fading...'] },
  RUNAWAY: { normal: ['MAYDAY — {name} — throttle stuck! We cannot shut down the drive!', '{name} emergency — {g}G and the controls are dead!'],
    urgent: ['{name}... crew is... passing out... too much G...', 'Can barely... reach the panel... {name} needs help NOW...'],
    critical: ['{name}... {g}G sustained... structural warnings...', '... ... {name} ... anyone ...'] },
  REACTOR_SCRAM: { normal: ['{name} beacon — reactor scram, total blackout. On suit O₂.', 'This is {name}, we are dark. Total power loss.'],
    urgent: ['{name}... suit O₂ at fifty percent. Temperature dropping.', 'Getting cold in here. {name} to any ship.'],
    critical: ['{name}... suit O₂ critical... can barely move...', '... {name} ... cold ... please ...'] },
  UNDER_ATTACK: { normal: ['{name}: they\'re still on us — burning everything we have!', 'This is {name}, raider closing, we have no point defense!'],
    urgent: ['{name}: they hit the drive section — we\'re losing thrust!', 'Anyone — {name} — they\'re lining up another salvo!'],
    critical: ['{name}... hull breached... we can\'t hold them off...', '... {name} ... they\'re matching course ... boarding ...'] },
};

const SPAWN_CHANCE = 0.0007;     // per minute when eligible (~4%/h)
const COOLDOWN = 720;
const MAX_OPEN = 3;

export function createMissions() {
  return { list: [], cooldown: 180, nextId: 1 };
}

const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);

export function activeMissions(state) {
  return state.missions.list.filter(m => m.status === 'offered' || m.status === 'accepted');
}

export function missionById(state, id) {
  return state.missions.list.find(m => m.id === id) || null;
}

export function missionForEntity(state, entityId) {
  return state.missions.list.find(m => m.entityId === entityId && m.status === 'accepted') || null;
}

/** Can we get there in time, at a G the target can't outrun? */
export function assessIntercept(state, entity, timerMin) {
  const g = entity.thrust > 0 ? Math.min(entity.thrust + 1, 7) : 1;
  const plan = createPlan('closing', { kind: 'entity', id: entity.id }, { accelG: g, standoff: STANDOFF.TACTICAL });
  const est = simulatePlan(state, plan, { maxMinutes: timerMin + 60 });
  const fuelOK = est.fuel <= state.resources.fuel.current * 0.95;
  const juice = g > 1.5;
  if (!est.arrived) return { feasible: false, g, juice, minutes: Infinity, reason: `Nav computer: no intercept solution inside ${Math.round(timerMin / 60)}h at ${g.toFixed(1)}G.` };
  if (!fuelOK) return { feasible: false, g, juice, minutes: est.minutes, reason: 'Nav computer: intercept would exhaust our reaction mass.' };
  if (est.minutes > timerMin) return { feasible: false, g, juice, minutes: est.minutes, reason: `Nav computer: earliest intercept in ${Math.round(est.minutes / 60)}h — they don't have that long.` };
  return { feasible: true, g, juice, minutes: est.minutes, reason: '' };
}

function spawn(state, emit) {
  const world = getWorld(state);
  const type = weightedPick(Object.keys(DEF).filter(k => DEF[k].weight > 0), k => DEF[k].weight);
  const d = DEF[type];
  const sp = state.flight.pos;
  const id = rollIdentity({ category: 'civilian', near: controlAt(sp.x, sp.y, state.clock.minute).faction, state });
  const ang = random() * Math.PI * 2;
  const dist = randRange(0.004, 0.025);              // 600k – 3.7M km
  const pos = { x: sp.x + Math.cos(ang) * dist, y: sp.y + Math.sin(ang) * dist };
  // roughly co-orbiting with us, plus whatever they were doing when it went wrong
  const r = Math.hypot(pos.x, pos.y);
  const v = circularSpeed(r);
  const th = Math.atan2(pos.y, pos.x) + Math.PI / 2;
  const pa = random() * Math.PI * 2, pm = randRange(50, 300);
  const vel = { vx: v * Math.cos(th) + pm * Math.cos(pa), vy: v * Math.sin(th) + pm * Math.sin(pa) };
  const runaway = type === SosType.RUNAWAY;
  const g = runaway ? Math.round(randRange(2, 5) * 10) / 10 : 0;
  const entity = world.add(createEntity({
    id: world.newId('sos'), name: id.name, type: 'ship', faction: id.faction, cls: id.cls, tl: id.tl, shipClass: id.shipClass, mass: id.mass,
    pos, vel, thrust: g, heading: random() * Math.PI * 2, sos: true, transponder: true, t: state.clock.minute,
    tags: { sos: true },
  }));

  const crew = randInt(2, 14);
  const hours = Math.floor(d.timer / 60);
  const story = fill(pick(d.story), { name: id.name, cls: id.shipClass, faction: id.faction, crew, g: g.toFixed(1), hours });
  const m = {
    id: `sos-${state.missions.nextId++}`,
    kind: 'sos',
    type,
    title: `SOS — ${id.name}`,
    description: story,
    entityId: entity.id,
    status: 'offered',
    timer: d.timer,
    timerMax: d.timer,
    rewards: { ...d.rewards },
    crewAboard: crew,
    offeredAt: state.clock.minute,
    acceptText: d.accept,
    declineText: d.decline,
  };
  entity.tags.missionId = m.id;
  state.missions.list.push(m);
  state.missions.cooldown = COOLDOWN;
  const feasibility = assessIntercept(state, entity, d.timer);
  emit('sos-offered', { mission: m, entity, distanceAU: dist, feasibility });
}

/**
 * A ship near us is being attacked (the encounter director set it up):
 * offer the call. Our point defense covers it once we accept.
 */
export function offerUnderAttack(state, victim, attackers, emit = () => {}) {
  const d = DEF.UNDER_ATTACK;
  const m = {
    id: `sos-${state.missions.nextId++}`, kind: 'sos', type: SosType.UNDER_ATTACK,
    title: `SOS — ${victim.name} under attack`,
    description: fill(pick(d.story), { name: victim.name, cls: victim.shipClass }),
    entityId: victim.id, attackers: [...attackers], status: 'offered',
    timer: d.timer, timerMax: d.timer, rewards: { ...d.rewards }, crewAboard: randInt(4, 20),
    offeredAt: state.clock.minute, acceptText: d.accept, declineText: d.decline,
  };
  victim.tags.missionId = m.id;
  state.missions.list.push(m);
  const dist = Math.hypot(victim.pos.x - state.flight.pos.x, victim.pos.y - state.flight.pos.y);
  emit('sos-offered', { mission: m, entity: victim, distanceAU: dist, feasibility: assessIntercept(state, victim, d.timer) });
  return m;
}

/** Are this mission's attackers dead, gone, beaten or no longer interested? */
function attackersGone(state, m) {
  const world = getWorld(state);
  return (m.attackers || []).every(id => {
    const a = world.get(id);
    return !a || !a.agent || a.combat?.status === 'wreck' || a.combat?.status === 'surrendered' || a.agent.mode === 'leave' || !a.agent.hostile.includes(m.entityId);
  });
}

export function acceptMission(state, id) {
  const m = missionById(state, id);
  if (!m || m.status !== 'offered') return false;
  m.status = 'accepted';
  if (m.type === SosType.UNDER_ATTACK && !state.combat.protect.includes(m.entityId)) state.combat.protect.push(m.entityId);
  return true;
}

export function declineMission(state, id) {
  const m = missionById(state, id);
  if (!m || m.status !== 'offered') return false;
  m.status = 'declined';
  retire(state, m, 3 * DAY_MIN);
  return true;
}

/** Hail in formation completes the rescue. */
export function completeRescue(state, id) {
  const m = missionById(state, id);
  if (!m || m.status !== 'accepted') return { success: false, text: 'No active rescue.' };
  const e = getWorld(state).get(m.entityId);
  if (!e) return { success: false, text: 'Contact lost.' };
  const h = state.flight.hold;
  const d = Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y) * AU_M;
  if (m.type === SosType.UNDER_ATTACK && !attackersGone(state, m)) return { success: false, text: 'They are still under fire — deal with the raiders first.' };
  if (!(h && h.id === e.id) || d > 10_000) return { success: false, text: 'Hold formation within 10 km to transfer crew and equipment.' };
  m.status = 'completed';
  m.completedAt = state.clock.minute;
  grant(state, m.rewards);
  getWorld(state).setSos(e, false);
  if (!e.driven) e.thrust = 0;
  if (e.agent) e.agent.mode = 'drift';
  retire(state, m, 2 * DAY_MIN);
  return { success: true, text: fill(DEF[m.type].rescue, { name: e.name }), rewards: m.rewards };
}

function grant(state, rewards) {
  for (const [k, v] of Object.entries(rewards)) {
    const r = state.resources[k];
    if (r) r.current = Math.min(r.max, r.current + v);
  }
}

/** Schedule the mission's ship to leave the simulation later. */
function retire(state, m, afterMin) {
  const e = getWorld(state).get(m.entityId);
  if (e) e.tags.despawnAt = state.clock.minute + afterMin;
}

function fail(state, m, reason, emit) {
  const answered = m.status === 'accepted';
  m.status = answered ? 'failed' : 'lost';     // unanswered calls just fall silent
  m.failReason = reason;
  const e = getWorld(state).get(m.entityId);
  if (e && !e.tags.wreck) {
    getWorld(state).setSos(e, false);
    e.transponder = false;       // dark hulk now
    if (!e.driven) e.thrust = 0;
    e.name = `${e.name} (derelict)`;
  }
  retire(state, m, 2 * DAY_MIN);
  if (state.autopilot?.missionId === m.id) state.autopilot.missionId = null;
  emit(answered ? 'sos-failed' : 'sos-lost', { mission: m, reason });
}

export function missionsTick(state, emit = () => {}) {
  const M = state.missions;
  const world = getWorld(state);
  if (M.cooldown > 0) M.cooldown--;

  for (const m of M.list) {
    if (m.status !== 'offered' && m.status !== 'accepted') continue;
    m.timer--;
    const e = world.get(m.entityId);
    if (!e) { fail(state, m, m.type === SosType.UNDER_ATTACK ? 'Destroyed — nothing left but debris' : 'Contact lost', emit); continue; }
    if (e.tags.wreck) { fail(state, m, 'The raiders gutted the ship', emit); continue; }
    if (m.timer <= 0) { fail(state, m, 'Too late — no survivors', emit); continue; }
    if (m.status === 'accepted') {
      const d = Math.hypot(e.pos.x - state.flight.pos.x, e.pos.y - state.flight.pos.y);
      if (d > RANGE.SOS) { fail(state, m, 'Beacon out of range — signal lost', emit); continue; }
    }
    // Runaways eventually burn out
    if (m.type === SosType.RUNAWAY && e.thrust > 0 && m.timer < 30) e.thrust = 0;
    if (m.status === 'accepted' && (m.timer % 30 === 0 || (m.timer < 60 && m.timer % 10 === 0))) {
      const frac = m.timer / m.timerMax;
      const tier = frac > 0.5 ? 'normal' : frac > 0.2 ? 'urgent' : 'critical';
      emit('sos-chatter', { mission: m, from: e.name, text: fill(pick(CHATTER[m.type][tier]), { name: e.name, g: (e.thrust || 0).toFixed(1) }) });
    }
  }

  // Trim history (finished ships are despawned by the world's background pass)
  if (state.clock.minute % 60 === 0) {
    const keep = M.list.filter(m => m.status === 'offered' || m.status === 'accepted');
    const done = M.list.filter(m => !(m.status === 'offered' || m.status === 'accepted')).slice(-30);
    M.list = [...done, ...keep];
  }

  const open = M.list.filter(m => m.status === 'offered' || m.status === 'accepted').length;
  if (M.cooldown <= 0 && open < MAX_OPEN && !state.combatStations && chance(SPAWN_CHANCE)) spawn(state, emit);
}

/** Dev/testing hook: force a distress call now. */
export function forceDistress(state, emit) {
  spawn(state, emit);
}

