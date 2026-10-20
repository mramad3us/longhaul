// ============================================================
// LONGHAUL — Crew needs
// Four needs (0 = desperate, 100 = fully met) decay with time awake
// and are met at the ship's facilities: rest in a bunk, food from the
// galley, hygiene in the head, recreation at the exercise rig or the
// mess table. Needs set morale, and morale and fatigue set how well
// people work. Everything here runs per game-minute.
// ============================================================

import { overallHealth, isConscious, addCondition, removeCondition } from './crew.js';

export const NEEDS = ['rest', 'food', 'hygiene', 'fun'];
export const NEED_LABEL = { rest: 'Rest', food: 'Food', hygiene: 'Hygiene', fun: 'Recreation' };

// Seek a facility when a need falls below this (off watch)
export const SEEK = { rest: 0, food: 40, hygiene: 45, fun: 55 };
export const URGENT = { rest: 8, food: 15 };
export const MEAL_BREAK = 35;   // on watch, people step away for a meal below this

const RATE = {
  rest: -100 / (24 * 60),       // sixteen hours awake leaves you around 30
  food: -100 / (10 * 60),
  hygiene: -100 / (36 * 60),
  fun: -100 / (24 * 60),
};
const SLEEP_BUNK = 100 / (7.5 * 60);
const SLEEP_COUCH = 100 / (12 * 60);
const COUCH_FEED = 1;            // need points per minute through the couch feed line
export const RATION_PER_MEAL = 0.5;
const MORALE_DRIFT = 0.004;      // per minute toward the needs-based target (~4 h time constant)
const MOD_FADE = 1 - 1 / (2 * 1440);   // event modifiers fade with a ~2-day time constant

export function createNeeds(rest = 80) {
  return { rest, food: 70, hygiene: 80, fun: 75 };
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/**
 * One minute of needs. ctx: { asleep: 'bunk'|'couch'|null, secured, onDuty, gForce, res, water }
 * Returns rations eaten through a couch feed line this minute.
 */
export function needsTick(m, ctx) {
  if (m.dead) return 0;
  const n = m.needs;
  const g = ctx.gForce;
  const hard = g > 1.5 ? 1.5 : 1;              // hard G is exhausting
  if (ctx.asleep) {
    n.rest = clamp(n.rest + (ctx.asleep === 'bunk' ? SLEEP_BUNK : SLEEP_COUCH));
    n.food = clamp(n.food + RATE.food * 0.4);
    n.hygiene = clamp(n.hygiene + RATE.hygiene * 0.5);
  } else if (isConscious(m)) {
    n.rest = clamp(n.rest + RATE.rest * hard * (ctx.onDuty ? 1.15 : 1));
    n.food = clamp(n.food + RATE.food);
    n.hygiene = clamp(n.hygiene + RATE.hygiene * hard);
    n.fun = clamp(n.fun + RATE.fun * (ctx.secured && g > 1.5 ? 1.6 : 1));   // days in a couch wear on everyone
  }

  // Strapped in for a long burn: the couch feed line keeps people going
  let eaten = 0;
  if (ctx.secured && n.food < 35 && ctx.res.food.current > 0) {
    const add = Math.min(COUCH_FEED, 100 - n.food);
    eaten = add / 100 * RATION_PER_MEAL;
    ctx.res.food.current = Math.max(0, ctx.res.food.current - eaten);
    n.food += add;
  }

  // Starvation & dehydration set in after days, not minutes
  m.hunger = n.food <= 0 ? m.hunger + 1 : 0;
  m.thirst = ctx.water ? 0 : m.thirst + 1;
  if (m.thirst > 1440) {
    addCondition(m, 'dehydrated');
    m.consciousness = clamp(m.consciousness - 0.05, 10, 100);
    m.body.head = clamp(m.body.head - 0.02);
    if (m.thirst > 4320) m.heart.health = clamp(m.heart.health - 0.1);
  } else removeCondition(m, 'dehydrated');
  if (m.hunger > 4320) {
    addCondition(m, 'starving');
    m.body.torso = clamp(m.body.torso - 0.01);
  } else removeCondition(m, 'starving');

  // Morale follows how well the ship looks after you; bad news fades over days
  if (m.moraleMod) m.moraleMod = Math.abs(m.moraleMod) < 0.5 ? 0 : m.moraleMod * MOD_FADE;
  m.morale = clamp(m.morale + (moraleTarget(m) - m.morale) * MORALE_DRIFT);
  return eaten;
}

export function moraleTarget(m) {
  const n = m.needs;
  const mean = (n.rest + n.food + n.hygiene + n.fun) / 4;
  let t = 22 + mean * 0.75;
  for (const k of NEEDS) if (n[k] < 15) t -= 5;
  if (m.conditions.includes('injured')) t -= 8;
  if (m.juiceHangover > 0) t -= m.juiceCrash ? 15 : 5;
  return clamp(t + (m.moraleMod || 0));
}

/**
 * How well someone works right now (0.2–1): fatigue, morale, hunger,
 * hangover and injuries all count.
 */
export function efficiency(m) {
  if (!isConscious(m)) return 0;
  const n = m.needs;
  let e = 1;
  if (n.rest < 30) e *= 0.55 + 0.45 * n.rest / 30;
  if (m.morale < 40) e *= 0.75 + 0.25 * m.morale / 40;
  if (n.food < URGENT.food) e *= 0.85;
  if (m.juiceHangover > 0) e *= m.juiceCrash ? 0.6 : 0.85;
  const h = overallHealth(m);
  if (h < 70) e *= 0.5 + 0.5 * h / 70;
  return clamp(e, 0.2, 1);
}

/** The need most in want of attention off watch, or null when all are fine. */
export function pressingNeed(m) {
  const n = m.needs;
  let best = null, worst = Infinity;
  for (const k of ['food', 'hygiene', 'fun']) {
    if (n[k] < SEEK[k] && n[k] / SEEK[k] < worst) { worst = n[k] / SEEK[k]; best = k; }
  }
  return best;
}

/** Practice makes better: slow skill growth from real work. */
export function practice(m, skill, minutes = 1) {
  if (!skill || m.skills[skill] == null) return;
  m.skills[skill] = Math.min(100, m.skills[skill] + 0.0006 * minutes * (1 - m.skills[skill] / 110));
}
