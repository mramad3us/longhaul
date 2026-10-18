// ============================================================
// LONGHAUL — Crew: identity, physiology, medicine
// Everything here runs per game-minute.
// ============================================================

import { random, randInt, pick } from '../core/rng.js';

export const G_THRESHOLDS = {
  MICRO_G: 0.01,     // below: floating
  COMFORTABLE: 0.3,
  STANDARD: 1.0,
  HIGH: 1.5,         // above: strain, juice required for long burns
  DANGEROUS: 2.5,    // above: injury without a couch
  LETHAL: 8.0,
};

export const GState = {
  FLOATING: 'floating',
  STANDING: 'standing',
  STRAINED: 'strained',
  PRONE: 'prone',      // pinned to the deck by high G
  SECURED: 'secured',  // couch or medbay bed
};

export const ROLES = ['Captain', 'Pilot', 'Engineer', 'Medic', 'Gunner', 'Mechanic', 'Scientist', 'Cook'];
const ROLE_SKILL = {
  Captain: 'piloting', Pilot: 'piloting', Engineer: 'engineering', Medic: 'medical',
  Gunner: 'security', Mechanic: 'engineering', Scientist: 'medical', Cook: 'medical',
};
// Where each role spends its watch
export const ROLE_HOME_DECK = { Captain: 0, Pilot: 0, Engineer: 4, Medic: 1, Gunner: 3, Mechanic: 4, Scientist: 2, Cook: 2 };

const SURNAMES = ['Chen', 'Nakamura', 'Okafor', 'Petrov', 'Morales', 'Kim', 'Al-Rashid', 'Johansson',
  'Mbeki', 'Kowalski', 'Tanaka', 'Adeyemi', 'Novak', 'Vasquez', 'Singh', 'Dawes', 'Ashford', 'Mao'];

export const CONDITION_LABELS = {
  dead: 'DEAD', critical: 'CRITICAL', 'brain-damage': 'BRAIN DAMAGE', crushed: 'CRUSHED',
  'cardiac-stress': 'CARDIAC STRESS', injured: 'INJURED', unconscious: 'UNCONSCIOUS',
  starving: 'STARVING', dehydrated: 'DEHYDRATED', hypoxic: 'HYPOXIC', hypercapnia: 'HYPERCAPNIA',
  decompression: 'DECOMPRESSION', 'juice-hangover': 'JUICE HANGOVER', fracture: 'FRACTURE',
  'internal-bleeding': 'INTERNAL BLEEDING',
};

export function createCrew(count, homeFixtures = null) {
  const names = [...SURNAMES];
  const crew = [];
  for (let i = 0; i < Math.min(count, ROLES.length); i++) {
    const role = ROLES[i];
    const name = names.splice(randInt(0, names.length - 1), 1)[0];
    const base = () => 20 + randInt(0, 39);
    const skills = { piloting: base(), security: base(), engineering: base(), medical: base() };
    skills[ROLE_SKILL[role]] = Math.min(100, skills[ROLE_SKILL[role]] + 25 + randInt(0, 14));
    crew.push({
      id: i,
      name,
      role,
      skills,
      body: { head: 100, torso: 100, leftArm: 100, rightArm: 100, leftLeg: 100, rightLeg: 100 },
      heart: { health: 100, bpm: 68 + randInt(0, 11), stress: 0, stressMinutes: 0, bpSystolic: 120, bpDiastolic: 80 },
      consciousness: 100,
      morale: 70 + randInt(0, 29),
      dead: false,
      deathTimer: -1,
      conditions: [],
      juiced: false,
      juiceHangover: 0,
      suit: { wearing: false, o2: 0, lockerId: null },
      hunger: 0,          // minutes since last meal ration was available
      thirst: 0,
      // interior state (crew-ai)
      homeDeck: ROLE_HOME_DECK[role] ?? 0,
      pos: { sx: 3 + (i % 3), sy: 0 },
      path: [],
      activity: 'idle',
      task: null,
      seat: null,
      gState: GState.FLOATING,
      pause: 0,
    });
  }
  return crew;
}

export const randomCaptainName = () =>
  `${pick('AKRMDSLJPFTNE'.split(''))}. ${pick(SURNAMES)}`;

// ---- HELPERS ----

export function hasCondition(m, c) { return m.conditions.includes(c); }
export function addCondition(m, c) { if (!m.conditions.includes(c)) m.conditions.push(c); }
export function removeCondition(m, c) { const i = m.conditions.indexOf(c); if (i >= 0) m.conditions.splice(i, 1); }
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function overallHealth(m) {
  if (m.dead) return 0;
  const b = m.body;
  return Math.round(b.head * 0.25 + b.torso * 0.3 + b.leftArm * 0.1 + b.rightArm * 0.1 + b.leftLeg * 0.125 + b.rightLeg * 0.125);
}

export const isConscious = (m) => !m.dead && m.consciousness > 10;
export const isAble = (m) => isConscious(m) && !hasCondition(m, 'critical');

export function needsMedical(m) {
  if (m.dead) return false;
  return overallHealth(m) < 85 || m.heart.health < 70 || hasCondition(m, 'critical') ||
    hasCondition(m, 'internal-bleeding') || hasCondition(m, 'fracture') || !isConscious(m);
}

/** Movement speed multiplier from injuries and gravity (0 = can't move). */
export function mobility(m, gForce) {
  if (!isConscious(m)) return 0;
  const legs = (m.body.leftLeg + m.body.rightLeg) / 200;
  if (gForce < G_THRESHOLDS.MICRO_G) return legs > 0 ? 0.6 : 0.3;     // hand over hand
  if (legs <= 0) return 0;
  let g;
  if (gForce < 0.3) g = 0.6 + (gForce / 0.3) * 0.4;
  else if (gForce <= 1.0) g = 1;
  else if (gForce < G_THRESHOLDS.DANGEROUS) g = Math.max(0.2, 1 - (gForce - 1) / 1.5);
  else g = 0;
  return g * (0.3 + 0.7 * legs);
}

// ---- G-FORCE PHYSIOLOGY (per game-minute) ----

/** Above this the couch gives a high dose: more protection, more supplies, real risk. */
export const HIGH_DOSE_G = 6;
const HIGH_DOSE_BOOSTER_MIN = 120;   // a high dose needs a booster every 2 h

/**
 * Effective G after couch and juice protection. Consumes med supplies when a
 * dose is given (standard: 1; high dose: 2 up front + 1 per booster).
 */
export function protectedG(m, gForce, secured, resources) {
  const med = resources.medSupplies;
  if (!secured) { m.juiced = false; m.juiceDose = null; return gForce; }
  if (gForce > G_THRESHOLDS.HIGH && med.current > 0) {
    const dose = gForce > HIGH_DOSE_G ? 'high' : 'standard';
    if (!m.juiced || (dose === 'high' && m.juiceDose !== 'high')) {
      med.current = Math.max(0, med.current - (dose === 'high' ? 2 : 1));
      m.juiceMin = 0;
    } else if (dose === 'high' && ++m.juiceMin % HIGH_DOSE_BOOSTER_MIN === 0) {
      med.current = Math.max(0, med.current - 1);
    }
    m.juiced = true;
    m.juiceDose = dose;
    return gForce / (dose === 'high' ? 4.5 : 3);   // 6G feels like 2G; 10G like 2.2G
  }
  return gForce * 0.7;              // couch alone
}

/** When a juiced burn ends, the body pays for it (high doses twice as hard). */
export function endJuice(m, peakG) {
  if (!m.juiced || m.dead) { m.juiced = false; m.juiceDose = null; return 0; }
  const high = m.juiceDose === 'high';
  m.juiced = false;
  m.juiceDose = null;
  const minutes = Math.round(4320 * Math.min(Math.max(peakG, 1.5) / 5, high ? 2 : 1));
  m.juiceHangover = Math.max(m.juiceHangover, minutes);
  addCondition(m, 'juice-hangover');
  return minutes;
}

export function gStateFor(m, gForce, secured) {
  if (secured && gForce >= G_THRESHOLDS.MICRO_G) return GState.SECURED;
  if (gForce < G_THRESHOLDS.MICRO_G) return secured ? GState.SECURED : GState.FLOATING;
  if (gForce <= G_THRESHOLDS.HIGH) return GState.STANDING;
  if (gForce <= G_THRESHOLDS.DANGEROUS) return GState.STRAINED;
  return GState.PRONE;
}

/**
 * Apply one minute of G-load and recovery. Returns a list of event strings
 * ('died', 'critical', 'brain-damage') that happened this minute.
 */
export function physiologyTick(m, effectiveG, gForceRaw) {
  if (m.dead) return [];
  const ev = [];
  const b = m.body, h = m.heart;

  // ---- Death spiral: heart failure → critical → death unless stabilized
  if (h.health <= 0 || hasCondition(m, 'critical')) {
    h.health = Math.max(0, h.health);
    if (!hasCondition(m, 'critical')) {
      m.deathTimer = 5 + random() * 35;          // minutes until death without first aid
      addCondition(m, 'critical');
      m.consciousness = 10;
      ev.push('critical');
    }
    m.deathTimer -= 1;
    if (m.deathTimer <= 0) { kill(m); ev.push('died'); return ev; }
  }

  // ---- G damage
  const G = effectiveG;
  if (G >= G_THRESHOLDS.LETHAL) {
    b.head = clamp(b.head - 2); b.torso = clamp(b.torso - 2.5);
    b.leftArm = clamp(b.leftArm - 1.5); b.rightArm = clamp(b.rightArm - 1.5);
    b.leftLeg = clamp(b.leftLeg - 2); b.rightLeg = clamp(b.rightLeg - 2);
    h.stress = clamp(h.stress + 8); h.health = clamp(h.health - 1.5);
    m.morale = clamp(m.morale - 3);
    addCondition(m, 'crushed'); addCondition(m, 'cardiac-stress');
  } else if (G >= G_THRESHOLDS.DANGEROUS) {
    b.torso = clamp(b.torso - 0.4); b.leftLeg = clamp(b.leftLeg - 0.6); b.rightLeg = clamp(b.rightLeg - 0.6);
    h.stress = clamp(h.stress + 4); h.health = clamp(h.health - 0.3);
    m.morale = clamp(m.morale - 1);
    addCondition(m, 'crushed'); addCondition(m, 'cardiac-stress');
  } else if (G >= G_THRESHOLDS.HIGH) {
    b.leftLeg = clamp(b.leftLeg - 0.05); b.rightLeg = clamp(b.rightLeg - 0.05);
    h.stress = clamp(h.stress + 1.5); m.morale = clamp(m.morale - 0.2);
    removeCondition(m, 'crushed');
    if (h.stress > 50) addCondition(m, 'cardiac-stress');
  } else {
    // Rest: slow natural recovery (brain damage does not heal on its own)
    h.stress = clamp(h.stress - (G >= G_THRESHOLDS.COMFORTABLE ? 5 : 4));
    removeCondition(m, 'crushed');
    if (h.stress < 20) removeCondition(m, 'cardiac-stress');
    if (G >= G_THRESHOLDS.COMFORTABLE) m.morale = clamp(m.morale + 0.05);
    if (!hasCondition(m, 'internal-bleeding')) {
      b.torso = clamp(b.torso + 0.01);
      b.leftArm = clamp(b.leftArm + 0.02); b.rightArm = clamp(b.rightArm + 0.02);
      b.leftLeg = clamp(b.leftLeg + 0.02); b.rightLeg = clamp(b.rightLeg + 0.02);
      if (!hasCondition(m, 'brain-damage')) b.head = clamp(b.head + 0.01);
    }
  }

  if (!hasCondition(m, 'cardiac-stress') && !hasCondition(m, 'critical') && h.health < 100) {
    h.health = clamp(h.health + 0.15);
  }

  // ---- High-dose juice: the drugs keep you conscious, not intact — stroke risk
  if (m.juiceDose === 'high' && random() < 0.0006 * Math.max(0, gForceRaw - HIGH_DOSE_G)) {
    b.head = clamp(b.head - (8 + random() * 10));
    m.consciousness = clamp(m.consciousness - 20, 10, 100);
    ev.push('stroke');
  }

  // ---- Juice hangover: brain-bleed risk under G
  if (m.juiceHangover > 0) {
    m.juiceHangover -= 1;
    if (m.juiceHangover <= 0) { m.juiceHangover = 0; removeCondition(m, 'juice-hangover'); }
    if (G >= G_THRESHOLDS.HIGH && random() < 0.003) {
      b.head = clamp(b.head - 3);
      m.consciousness = clamp(m.consciousness - 5, 10, 100);
    }
  }

  // ---- Internal bleeding: slow torso loss until treated
  if (hasCondition(m, 'internal-bleeding')) {
    b.torso = clamp(b.torso - 0.5);
    if (b.torso <= 0) { kill(m); ev.push('died'); return ev; }
  }

  if (b.head <= 0 && !hasCondition(m, 'brain-damage')) { b.head = 0; addCondition(m, 'brain-damage'); ev.push('brain-damage'); }

  // ---- Consciousness
  const cap = hasCondition(m, 'brain-damage') ? 50 : 100;
  if (b.head < 20) m.consciousness -= 2;
  if (b.torso < 15) m.consciousness -= 3;
  if (G >= G_THRESHOLDS.DANGEROUS) m.consciousness -= 1.5;
  if (G < G_THRESHOLDS.DANGEROUS && b.head >= 20 && b.torso >= 15 && !hasCondition(m, 'critical')) m.consciousness += 0.5;
  m.consciousness = clamp(m.consciousness, 10, cap);

  // ---- Sustained cardiac stress wears the heart out (only at dangerous loads)
  if (hasCondition(m, 'cardiac-stress')) {
    if (G >= G_THRESHOLDS.DANGEROUS) {
      h.stressMinutes += 1;
      if (h.stressMinutes > 10) h.health = clamp(h.health - (0.1 + (h.stressMinutes - 10) * 0.02));
    } else {
      h.stressMinutes = Math.max(0, h.stressMinutes - 1);
    }
  } else {
    h.stressMinutes = 0;
  }

  // ---- Vitals: stress, raw G-load and juice all drive the heart
  // (juice is a stimulant cocktail: the couch spares the body, not the pulse)
  const gAbove1 = Math.max(0, gForceRaw - 1);
  const juice = m.juiced ? (m.juiceDose === 'high' ? 2 : 1) : 0;
  h.bpm = Math.round(Math.min(215, 72 + (h.stress / 100) * 120 + gAbove1 * 5 + juice * 30));
  h.bpSystolic = Math.round(Math.min(240, 120 + (h.stress / 100) * 60 + gAbove1 * 12 + juice * 22));
  h.bpDiastolic = Math.round(Math.min(150, 80 + (h.stress / 100) * 30 + gAbove1 * 6 + juice * 12));

  refreshDerivedConditions(m);
  return ev;
}

export function refreshDerivedConditions(m) {
  if (m.dead) return;
  const b = m.body;
  if (b.head < 70 || b.torso < 70 || b.leftArm < 70 || b.rightArm < 70 || b.leftLeg < 70 || b.rightLeg < 70) addCondition(m, 'injured');
  else removeCondition(m, 'injured');
  if (m.consciousness <= 10) addCondition(m, 'unconscious');
  else removeCondition(m, 'unconscious');
}

export function kill(m) {
  m.dead = true;
  m.consciousness = 0;
  m.heart.bpm = 0;
  m.heart.stress = 0;
  m.juiced = false;
  m.conditions = ['dead'];
  m.task = null;
  m.path = [];
  m.activity = 'dead';
}

// ---- NEEDS: food & water (per game-minute) ----

export function needsTick(m, hasFood, hasWater) {
  if (m.dead) return;
  m.hunger = hasFood ? 0 : m.hunger + 1;
  m.thirst = hasWater ? 0 : m.thirst + 1;
  if (m.thirst > 1440) {                     // > 1 day without water
    addCondition(m, 'dehydrated');
    m.consciousness = clamp(m.consciousness - 0.05, 10, 100);
    m.body.head = clamp(m.body.head - 0.02);
    m.morale = clamp(m.morale - 0.05);
    if (m.thirst > 4320) m.heart.health = clamp(m.heart.health - 0.1);
  } else removeCondition(m, 'dehydrated');
  if (m.hunger > 4320) {                     // > 3 days without food
    addCondition(m, 'starving');
    m.morale = clamp(m.morale - 0.03);
    m.body.torso = clamp(m.body.torso - 0.01);
  } else removeCondition(m, 'starving');
}

// ---- MEDICINE ----

/** First aid / autodoc stabilization: halts the death spiral. */
export function stabilize(m) {
  if (m.dead || !hasCondition(m, 'critical')) return false;
  removeCondition(m, 'critical');
  m.deathTimer = -1;
  m.heart.health = Math.max(m.heart.health, 15);
  m.heart.stress = Math.min(m.heart.stress, 50);
  return true;
}

/**
 * One minute in the autodoc. `supplied` = med supplies available (full rate);
 * otherwise treatment runs at 30%. Returns true when fully healed.
 */
export function medbayTick(m, supplied) {
  if (m.dead) return false;
  const k = supplied ? 1 : 0.3;
  stabilize(m);
  removeCondition(m, 'internal-bleeding');
  const b = m.body, h = m.heart;
  b.head = clamp(b.head + 0.3 * k); b.torso = clamp(b.torso + 0.25 * k);
  b.leftArm = clamp(b.leftArm + 0.4 * k); b.rightArm = clamp(b.rightArm + 0.4 * k);
  b.leftLeg = clamp(b.leftLeg + 0.35 * k); b.rightLeg = clamp(b.rightLeg + 0.35 * k);
  h.health = clamp(h.health + 0.2 * k);
  h.stress = clamp(h.stress - 1);
  const cap = hasCondition(m, 'brain-damage') ? 50 : 100;
  m.consciousness = clamp(m.consciousness + 0.8, 10, cap);
  const healed = b.head >= 99.5 && b.torso >= 99.5 && b.leftArm >= 99.5 && b.rightArm >= 99.5 &&
    b.leftLeg >= 99.5 && b.rightLeg >= 99.5 && h.health >= 99.5;
  if (healed) removeCondition(m, 'fracture');
  refreshDerivedConditions(m);
  return healed;
}

// ---- IMPACT TRAUMA (inertial events) ----

const IMPACT = { BUMP: 1, BRUISE: 3, HARD: 5, BREAKING: 8, CRUSHING: 12, FATAL: 18 };

/** Apply collision trauma at `speed` m/s. Returns { severity, message } or null. */
export function applyImpact(m, speed) {
  if (speed < IMPACT.BUMP) return null;
  if (m.dead) return { severity: 'corpse', message: `${m.name}'s body slammed into a bulkhead` };
  let sev, torso, headF, limbF, ko, stress;
  if (speed < IMPACT.BRUISE) { sev = 'bruise'; torso = 3 + (speed - 1) * 2.5; headF = 0.3; limbF = 0.5; ko = 0; stress = 0; }
  else if (speed < IMPACT.HARD) { sev = 'hard-impact'; torso = 10 + (speed - 3) * 5; headF = 0.6; limbF = 0.6; ko = 15; stress = 0; }
  else if (speed < IMPACT.BREAKING) { sev = 'bone-breaking'; torso = 20 + (speed - 5) * 6.7; headF = 0.7; limbF = 0.65; ko = 30; stress = 10; }
  else if (speed < IMPACT.CRUSHING) { sev = 'crushing'; torso = 40 + (speed - 8) * 6.25; headF = 0.7; limbF = 0.6; ko = 60; stress = 25; }
  else if (speed < IMPACT.FATAL) { sev = 'lethal'; torso = 60 + (speed - 12) * 5; headF = 0.85; limbF = 0.55; ko = 90; stress = 50; }
  else { kill(m); return { severity: 'fatal', message: `${m.name} killed on impact` }; }

  const r = () => 0.8 + random() * 0.4;
  const b = m.body;
  b.torso = clamp(b.torso - torso * r());
  b.head = clamp(b.head - torso * headF * r());
  for (const k of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']) b[k] = clamp(b[k] - torso * limbF * r());
  m.consciousness = clamp(m.consciousness - ko, 10, 100);
  m.heart.stress = clamp(m.heart.stress + stress);
  if ((sev === 'hard-impact' && random() < 0.3) || sev === 'bone-breaking' || sev === 'crushing' || sev === 'lethal') addCondition(m, 'fracture');
  if (sev === 'crushing' || sev === 'lethal') addCondition(m, 'internal-bleeding');
  if (sev === 'lethal' && b.head < 20) addCondition(m, 'brain-damage');
  if (b.head <= 0 || b.torso <= 0) { kill(m); return { severity: 'fatal', message: `${m.name} killed on impact` }; }
  refreshDerivedConditions(m);
  const label = { bruise: 'bruised', 'hard-impact': 'injured', 'bone-breaking': 'bones broken', crushing: 'critically injured', lethal: 'near-fatal injuries' }[sev];
  return { severity: sev, message: `${m.name} slammed into a bulkhead — ${label}` };
}
