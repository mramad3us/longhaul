// ============================================================
// LONGHAUL — Crew: identity, physiology, medicine
// Everything here runs per game-minute.
// ============================================================

import { random, randInt, pick } from '../core/rng.js';
import { createNeeds } from './needs.js';
import { defaultDuty } from './duty.js';
import { deckWith } from './ship-layout.js';

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

// The order a crew is signed on: the first eight fly the ship, then
// security and deck hands (boarding parties, a second watch on the guns).
export const ROLES = ['Captain', 'Pilot', 'Engineer', 'Medic', 'Gunner', 'Mechanic', 'Scientist', 'Cook', 'Security', 'Deckhand', 'Security', 'Deckhand'];
export const ROLE_SKILL = {
  Captain: 'piloting', Pilot: 'piloting', Engineer: 'engineering', Medic: 'medical',
  Gunner: 'security', Mechanic: 'engineering', Scientist: 'medical', Cook: 'medical',
  Security: 'security', Deckhand: 'engineering',
};
// Where each role spends its watch: the deck holding this fixture (ship-layout.js)
const ROLE_HOME = {
  Captain: 'helm', Pilot: 'helm', Engineer: 'engStation', Medic: 'medbay', Gunner: 'launcher', Mechanic: 'workbench',
  Scientist: 'ops', Cook: 'galley', Security: 'airlock', Deckhand: 'storage',
};

/** The deck a role calls home on this ship (by what is on it). */
export function homeDeckFor(ship, role) {
  const kind = ROLE_HOME[role] || 'helm';
  const di = deckWith(ship, kind);
  return di >= 0 ? di : Math.max(0, deckWith(ship, 'couch'));
}

const SURNAMES = ['Chen', 'Nakamura', 'Okafor', 'Petrov', 'Morales', 'Kim', 'Al-Rashid', 'Johansson',
  'Mbeki', 'Kowalski', 'Tanaka', 'Adeyemi', 'Novak', 'Vasquez', 'Singh', 'Dawes', 'Ashford', 'Mao',
  // (a game runs for decades, and hands come and go: enough names that the halls don't run dry)
  'Halvorsen', 'Kaplan', 'Navarro', 'Brennan', 'Delgado', 'Acheampong', 'Faris', 'Pham-Ly', 'Ibarra', 'Mertens', 'Okoye', 'Bauer',
  'Castillo', 'Dubois', 'Eriksen', 'Fujita', 'Grant', 'Haddad', 'Ivanova', 'Jaramillo', 'Kaur', 'Lindqvist', 'Maalouf', 'Nwosu',
  'Oyelaran', 'Park', 'Quispe', 'Rahman', 'Sato', 'Teller', 'Umarov', 'Varga', 'Weiss', 'Xu', 'Yilmaz', 'Zhou',
  'Achebe', 'Bianchi', 'Cortez', 'Dimitrov', 'Ekwueme', 'Ferreira', 'Gallagher', 'Hosseini', 'Ishikawa', 'Jensen', 'Kovac', 'Larsen',
  'Moreau', 'Nakashima', 'Ortega', 'Pham', 'Reyes', 'Szabo', 'Tran', 'Ueda', 'Volkov', 'Wójcik', 'Yamada', 'Zielinski',
  'Abara', 'Belanger', 'Cruz', 'Delacroix', 'Eze', 'Falk', 'Gupta', 'Hale', 'Iqbal', 'Juarez', 'Kemp', 'Lomax', 'Mensah', 'Nair', 'Osei',
  'Pereira', 'Rossi', 'Sandoval', 'Toure', 'Vance', 'Wanjiru', 'Yusuf', 'Zaragoza', 'Brandt', 'Oduya', 'Marrero', 'Lund', 'Tsai'];

export const CONDITION_LABELS = {
  dead: 'DEAD', critical: 'CRITICAL', 'brain-damage': 'BRAIN DAMAGE', crushed: 'CRUSHED',
  'cardiac-stress': 'CARDIAC STRESS', injured: 'INJURED', unconscious: 'UNCONSCIOUS',
  starving: 'STARVING', dehydrated: 'DEHYDRATED', hypoxic: 'HYPOXIC', hypercapnia: 'HYPERCAPNIA',
  decompression: 'DECOMPRESSION', 'juice-hangover': 'JUICE HANGOVER', fracture: 'FRACTURE',
  'internal-bleeding': 'INTERNAL BLEEDING', burned: 'BURNED', 'severe-burns': 'SEVERE BURNS', 'deep-trauma': 'DEEP TRAUMA',
};

/**
 * Sign on a crew of `count` in ROLES order. `ship` (its decks) sets where
 * each of them spends the watch.
 */
export function createCrew(count, ship = null) {
  const names = [...SURNAMES];
  const crew = [];
  for (let i = 0; i < Math.min(count, ROLES.length); i++) {
    crew.push(createMember(i, ROLES[i], names, ship));
  }
  return crew;
}

/** One person: a role, a name not already taken, skills that lean to the role. */
export function createMember(id, role, names = [...SURNAMES], ship = null) {
  const name = names.length ? names.splice(randInt(0, names.length - 1), 1)[0] : pick(SURNAMES);
  const base = () => 20 + randInt(0, 39);
  const skills = { piloting: base(), security: base(), engineering: base(), medical: base() };
  skills[ROLE_SKILL[role]] = Math.min(100, skills[ROLE_SKILL[role]] + 25 + randInt(0, 14));
  return {
    id,
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
    juiceDose: null,    // 'standard' | 'high' while the drug is in the blood
    juiceMin: 0,        // minutes on the high dose this burn
    juiceIdleMin: 0,    // minutes since the couch last dosed (the drug lingers)
    juicePeakG: 0,      // hardest G felt on this dose
    juiceHangover: 0,
    juiceCrash: false,  // the hangover is a high-dose crash (much worse)
    suit: { wearing: false, o2: 0, lockerId: null },
    hunger: 0,          // minutes spent with nothing in the stomach
    thirst: 0,          // minutes without water aboard
    needs: createNeeds(),
    duty: defaultDuty(role),
    moraleMod: 0,       // lingering events (a crewmate's death, a good run ashore)
    // interior state (crew-ai)
    homeDeck: ship ? homeDeckFor(ship, role) : 0,
    pos: { sx: 3 + (id % 3), sy: 0 },
    path: [],
    activity: 'idle',
    task: null,
    seat: null,
    gState: GState.FLOATING,
    pause: 0,
  };
}

export const SURNAME_POOL = SURNAMES;

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
  const lasting = lastingWound(m);
  if (lasting ? !m.stabilized : (m.burns || 0) > 0) return true;
  return overallHealth(m) < (lasting ? 60 : 85) || m.heart.health < 70 || hasCondition(m, 'critical') ||
    hasCondition(m, 'internal-bleeding') || hasCondition(m, 'fracture') || !isConscious(m);
}

// ---- WHAT A SHIP CAN'T MEND ----
// The autodoc heals what it can: cuts and breaks, a bleed, a burn on the
// skin. Severe burns (m.burns past SEVERE_BURN: grafts) and deep trauma
// (what a crushing blow leaves: a surgeon) it can only hold. Left alone
// they get worse, day on day, until the heart gives out; an autodoc
// stabilizes them (m.stabilized) and brings the body back as far as
// WOUND_CAP, and there it stays until a hospital (hospital.js, ground.js).
// Brain damage is the same, without the worsening.

export const SEVERE_BURN = 35;           // burns (0–100) past this want grafts
const WOUND_CAP = 70;                    // how far back the autodoc can bring a body with such a wound
const FESTER_PER_MIN = 0.03;             // heart health a minute, an unheld wound: about two days to the end
const BURN_HEAL_PER_MIN = 0.25;          // an autodoc on a burn, at its full rate
const BURN_MEND_PER_MIN = 0.01;          // a light burn, left to itself

/** A wound only a hospital can finish: severe burns, deep trauma. */
export const lastingWound = (m) => (m.burns || 0) >= SEVERE_BURN || hasCondition(m, 'deep-trauma');
/** Someone the ship can do no more for. */
export const needsHospital = (m) => !m.dead && (lastingWound(m) || hasCondition(m, 'brain-damage'));
/** How far back a body can come aboard (%). */
export const woundCap = (m) => lastingWound(m) ? WOUND_CAP : 100;

/** Burned, by `amount` (points). */
export function addBurn(m, amount) {
  m.burns = Math.min(100, (m.burns || 0) + amount);
  if (m.burns >= SEVERE_BURN) { removeCondition(m, 'burned'); addCondition(m, 'severe-burns'); m.stabilized = false; }
  else addCondition(m, 'burned');
}

/** Made whole in a hospital (`level` 'full': the brain too). */
export function hospitalCure(m, level) {
  for (const k of Object.keys(m.body)) m.body[k] = 100;
  m.heart.health = 100; m.heart.stress = 0;
  for (const c of ['fracture', 'internal-bleeding', 'cardiac-stress', 'juice-hangover', 'burned', 'severe-burns', 'deep-trauma', 'critical']) removeCondition(m, c);
  m.juiceHangover = 0; m.juiceCrash = false; m.burns = 0; m.stabilized = false; m.deathTimer = -1;
  if (level === 'full') removeCondition(m, 'brain-damage');
  m.consciousness = Math.max(m.consciousness, hasCondition(m, 'brain-damage') ? 50 : 90);
  refreshDerivedConditions(m);
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
//
// Juice is cheap to give and expensive to have taken. A dose stays in the
// blood for a while, so a flip or a lull between combat burns does not mean
// a fresh dose: the couch doses once per burn (standard: 1 med unit, high
// dose: 2, plus a booster each day). The bill comes afterwards. The hangover
// lasts up to three days after a standard dose. After a high dose it is a
// crash: a hammered heart, a long hangover that grows with every hour spent
// on the high dose, and while it lasts people work badly, feel wretched, and
// risk brain bleeds under any real G.

/** Above this the couch gives a high dose: more protection, more supplies, real risk. */
export const HIGH_DOSE_G = 6;
/** On the high dose, the chance of a stroke each minute, per G past HIGH_DOSE_G (NPC crews pay it too: agents.js). */
export const STROKE_RISK = 0.0006;
const HIGH_DOSE_BOOSTER_MIN = 24 * 60;  // a high dose needs a booster once a day
const JUICE_LINGER_MIN = 60;            // the drug covers a flip or a lull this long
const HANGOVER_MAX_MIN = 10 * 1440;
const CRASH_MIN_PER_HIGH_MIN = 1.5;     // each hour on the high dose adds 1.5 h of crash

/**
 * Effective G after couch and juice protection. Consumes med supplies when a
 * dose is given (standard: 1; high dose: 2 in all, + 1 per daily booster).
 */
export function protectedG(m, gForce, secured, resources) {
  const med = resources.medSupplies;
  const dosing = secured && gForce > G_THRESHOLDS.HIGH && (m.juiced || med.current > 0);
  if (!dosing) {
    if (m.juiced) m.juiceIdleMin = (m.juiceIdleMin || 0) + 1;
    if (!secured) return gForce;
    return m.juiced && gForce > G_THRESHOLDS.HIGH ? gForce / (m.juiceDose === 'high' ? 4.5 : 3) : gForce * 0.7;
  }
  const high = gForce > HIGH_DOSE_G || m.juiceDose === 'high';     // once on the high dose, it stays in you
  if (!m.juiced) {
    med.current = Math.max(0, med.current - (high ? 2 : 1));
    m.juiceMin = 0;
    m.juicePeakG = 0;
  } else if (high && m.juiceDose !== 'high') {
    med.current = Math.max(0, med.current - 1);                    // topped up from standard
  } else if (high && m.juiceMin > 0 && m.juiceMin % HIGH_DOSE_BOOSTER_MIN === 0) {
    if (med.current > 0) med.current = Math.max(0, med.current - 1);
  }
  if (high) m.juiceMin = (m.juiceMin || 0) + 1;
  m.juiced = true;
  m.juiceDose = high ? 'high' : 'standard';
  m.juiceIdleMin = 0;
  m.juicePeakG = Math.max(m.juicePeakG || 0, gForce);
  return gForce / (high ? 4.5 : 3);   // 6G feels like 2G; 10G like 2.2G
}

/** True once the last dose has worn off: time to pay for it. */
export const juiceLapsed = (m) => m.juiced && (m.juiceIdleMin || 0) >= JUICE_LINGER_MIN;

/**
 * When a juiced burn ends, the body pays for it. A standard dose leaves up to
 * three days of hangover. A high dose crashes the heart and leaves a hangover
 * twice as long plus 1.5 h for every hour spent on it.
 */
export function endJuice(m) {
  if (!m.juiced || m.dead) { m.juiced = false; m.juiceDose = null; return 0; }
  const high = m.juiceDose === 'high';
  let minutes = 4320 * Math.min(Math.max(m.juicePeakG || 0, 1.5) / 5, high ? 2 : 1);
  if (high) {
    minutes += (m.juiceMin || 0) * CRASH_MIN_PER_HIGH_MIN;
    m.juiceCrash = true;
    m.heart.stress = clamp(m.heart.stress + 40);
    m.heart.health = clamp(m.heart.health - 15);
    m.moraleMod = (m.moraleMod || 0) - 10;
  }
  minutes = Math.round(Math.min(HANGOVER_MAX_MIN, minutes));
  m.juiced = false;
  m.juiceDose = null;
  m.juiceMin = 0;
  m.juiceIdleMin = 0;
  m.juicePeakG = 0;
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

  // (a wound nobody is holding gets worse: an autodoc stops it)
  const festering = lastingWound(m) && !m.stabilized;
  if (festering) h.health = clamp(h.health - FESTER_PER_MIN);

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
      const cap = woundCap(m), mend = (v, n) => Math.max(v, Math.min(cap, v + n));
      b.torso = mend(b.torso, 0.01);
      b.leftArm = mend(b.leftArm, 0.02); b.rightArm = mend(b.rightArm, 0.02);
      b.leftLeg = mend(b.leftLeg, 0.02); b.rightLeg = mend(b.rightLeg, 0.02);
      if (!hasCondition(m, 'brain-damage')) b.head = mend(b.head, 0.01);
      if ((m.burns || 0) > 0 && m.burns < SEVERE_BURN) { m.burns = Math.max(0, m.burns - BURN_MEND_PER_MIN); if (!m.burns) removeCondition(m, 'burned'); }
    }
  }

  // (a crashed heart barely mends until the hangover clears: about a day for the crash itself)
  if (!festering && !hasCondition(m, 'cardiac-stress') && !hasCondition(m, 'critical') && h.health < 100) {
    h.health = clamp(h.health + (m.juiceCrash && m.juiceHangover > 0 ? 0.01 : 0.15));
  }

  // ---- High-dose juice: the drugs keep you conscious, not intact — stroke risk
  if (m.juiceDose === 'high' && random() < STROKE_RISK * Math.max(0, gForceRaw - HIGH_DOSE_G)) {
    b.head = clamp(b.head - (8 + random() * 10));
    m.consciousness = clamp(m.consciousness - 20, 10, 100);
    ev.push('stroke');
  }

  // ---- Juice hangover: brain-bleed risk under G (twice as likely in a crash)
  if (m.juiceHangover > 0) {
    m.juiceHangover -= 1;
    if (m.juiceHangover <= 0) { m.juiceHangover = 0; m.juiceCrash = false; removeCondition(m, 'juice-hangover'); }
    if (G >= G_THRESHOLDS.HIGH && random() < (m.juiceCrash ? 0.006 : 0.003)) {
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

/** A death aboard weighs on everyone for days. */
export function mourn(crew, dead) {
  for (const m of crew) if (m !== dead && !m.dead) m.moraleMod = (m.moraleMod || 0) - 25;
}

/** Is someone physically on our ship? Not across on another hull or ashore (m.away), and not lost off it (m.lost: nothing of them came home). */
export const isAboard = (m) => !m.away && !m.lost;

export function kill(m) {
  m.dead = true;
  m.consciousness = 0;
  m.heart.bpm = 0;
  m.heart.stress = 0;
  m.juiced = false;
  m.juiceDose = null;
  m.conditions = ['dead'];
  m.task = null;
  m.path = [];
  m.activity = 'dead';
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
 * otherwise treatment runs at 30%. `rate` scales treatment (autodoc
 * condition, a medic in attendance). Returns true when fully healed.
 */
export function medbayTick(m, supplied, rate = 1) {
  if (m.dead) return false;
  const k = (supplied ? 1 : 0.3) * rate;
  stabilize(m);
  removeCondition(m, 'internal-bleeding');
  const b = m.body, h = m.heart, lasting = lastingWound(m), top = woundCap(m);
  const heal = (v, n) => Math.max(v, Math.min(top, v + n * k));
  b.head = heal(b.head, 0.3); b.torso = heal(b.torso, 0.25);
  b.leftArm = heal(b.leftArm, 0.4); b.rightArm = heal(b.rightArm, 0.4);
  b.leftLeg = heal(b.leftLeg, 0.35); b.rightLeg = heal(b.rightLeg, 0.35);
  h.health = clamp(h.health + 0.2 * k);
  // (a burn down as far as it goes: all the way, or to where only grafts will take it)
  const floor = (m.burns || 0) >= SEVERE_BURN ? SEVERE_BURN : 0;
  if (m.burns > floor) m.burns = Math.max(floor, m.burns - BURN_HEAL_PER_MIN * k);
  if (m.burns === 0) removeCondition(m, 'burned');
  h.stress = clamp(h.stress - 1);
  const cap = hasCondition(m, 'brain-damage') ? 50 : 100;
  m.consciousness = clamp(m.consciousness + 0.8, 10, cap);
  const done = top - 0.5;
  const healed = b.head >= done && b.torso >= done && b.leftArm >= done && b.rightArm >= done &&
    b.leftLeg >= done && b.rightLeg >= done && h.health >= 99.5 && (m.burns || 0) <= floor;
  if (healed) { removeCondition(m, 'fracture'); if (lasting) m.stabilized = true; }
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
  if (sev === 'crushing' || sev === 'lethal') { addCondition(m, 'internal-bleeding'); addCondition(m, 'deep-trauma'); m.stabilized = false; }
  if (sev === 'lethal' && b.head < 20) addCondition(m, 'brain-damage');
  if (b.head <= 0 || b.torso <= 0) { kill(m); return { severity: 'fatal', message: `${m.name} killed on impact` }; }
  refreshDerivedConditions(m);
  const label = { bruise: 'bruised', 'hard-impact': 'injured', 'bone-breaking': 'bones broken', crushing: 'critically injured', lethal: 'near-fatal injuries' }[sev];
  return { severity: sev, message: `${m.name} slammed into a bulkhead — ${label}` };
}
