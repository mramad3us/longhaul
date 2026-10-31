// ============================================================
// LONGHAUL — Hospitals: what an autodoc can't do
//
// An autodoc heals what it can and holds the rest (crew.js). Severe burns
// want grafts and deep trauma a surgeon; brain damage wants a neural
// theatre. Those take a hospital, and a stay in it.
//
// Every port has one: a CLINIC for burns, trauma and anything an autodoc
// could do, a full HOSPITAL (the big ports) for the brain as well. A
// command ship's sick bay is a clinic at a forward base. A world's ground
// has its own (ground.js), down by shuttle.
//
// A patient goes ashore for days (m.away, as on leave: off our decks, the
// ship can't leave without them), up to a fortnight and more for a deep
// burn. The bill is paid on admission, and the berth is held for the stay,
// its lease bought ahead past what a lease is normally let for. Discharged
// early, they come back as they went, and the rest of the bill with them.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { STATIONS } from './stations.js';
import { dockedPort } from './contracts.js';
import { overallHealth, hasCondition, hospitalCure, stabilize, SEVERE_BURN } from './crew.js';
import { abandonTask } from './crew-ai.js';
import { holdBerthFor, berthCostFor } from './leases.js';
import { supplyPriceFactor } from './service.js';
import { note } from './careers.js';

const BASE_MCR = 150;             // the door
const HARM_MCR = 6;               // a point of the body's or the heart's shortfall
const BURN_MCR = 15;              // a point of burn
const TRAUMA_MCR = 900;
export const NEURAL_MCR = 2500;   // brain damage mended (a big hospital)
const STAY_MIN = DAY_MIN;         // the least of a stay
const BURN_DAYS = 3;              // a severe burn's grafts…
const BURN_DAYS_PER_POINT = 0.2;  // …and this for each point past severe
const TRAUMA_DAYS = 5;
const NEURAL_DAYS = 14;
const WORTH_HARM = 10;            // less than this, the autodoc will do

/** What a port has for the hurt: 'full' (a hospital), 'clinic', or null. */
export const careAt = (port) => !port ? null : port.tags?.command ? 'clinic' : STATIONS[port.id]?.care ?? null;

/** How much harm there is to mend (points: the body's and the heart's shortfall). */
export const harmOf = (m) => Math.max(0, 100 - overallHealth(m)) + Math.max(0, 100 - m.heart.health) * 0.5;

/**
 * What a hospital of `level` would do for someone: { cost, minutes, what,
 * brain, refused (brain damage this one can't touch) }, or null if nothing
 * worth a stay.
 */
export function treatment(m, level) {
  if (m.dead || !level) return null;
  const burns = m.burns || 0, severe = burns >= SEVERE_BURN, trauma = hasCondition(m, 'deep-trauma');
  const braindamaged = hasCondition(m, 'brain-damage'), brain = braindamaged && level === 'full', harm = harmOf(m);
  const refused = braindamaged && !brain;
  if (!severe && !trauma && !brain && harm < WORTH_HARM && !burns) return refused ? { refused } : null;
  const what = [brain && 'neural surgery', severe ? 'burn grafts' : burns > 0 && 'burns', trauma && 'trauma surgery', !severe && !trauma && harm >= WORTH_HARM && 'injuries'].filter(Boolean);
  const days = Math.max(severe ? BURN_DAYS + (burns - SEVERE_BURN) * BURN_DAYS_PER_POINT : 0, trauma ? TRAUMA_DAYS : 0, brain ? NEURAL_DAYS : 0);
  return {
    what, brain, refused,
    minutes: Math.max(STAY_MIN, Math.round(days * DAY_MIN)),
    cost: BASE_MCR + harm * HARM_MCR + burns * BURN_MCR + (trauma ? TRAUMA_MCR : 0) + (brain ? NEURAL_MCR : 0),
  };
}

/** What it comes to here: the treatment with this port's prices, and what holding the berth adds. */
export function quote(state, m, port = dockedPort(state)) {
  const t = treatment(m, careAt(port));
  if (!t || t.cost == null) return t;
  const bill = Math.round(t.cost * supplyPriceFactor(state) / 10) * 10;
  return { ...t, cost: bill, berth: berthCostFor(state, t.minutes) };
}

/** Who aboard a hospital here could do something for. */
export const patientsHere = (state, port = dockedPort(state)) => state.ship.crew.filter(m => !m.away && quote(state, m, port)?.cost != null);

/** Check someone in. Returns { ok, text }. */
export function admit(state, id) {
  const port = dockedPort(state), m = state.ship.crew.find(x => x.id === id);
  if (!port || !m) return { ok: false, text: 'Not docked.' };
  if (m.away) return { ok: false, text: `${m.name} isn't aboard.` };
  const q = quote(state, m, port);
  if (q?.cost == null) return { ok: false, text: `Nothing they can do for ${m.name} here.` };
  const cost = q.cost + q.berth;
  if (state.resources.credits.current < cost) return { ok: false, text: `${m.name}'s care comes to ${cost.toLocaleString()} MCR.` };
  state.resources.credits.current -= q.cost;
  holdBerthFor(state, q.minutes);
  abandonTask(state, m);
  stabilize(m);
  m.stabilized = true;
  const until = state.clock.minute + q.minutes;
  m.away = { ashore: port.id, until, full: until, hospital: careAt(port), cost: q.cost, since: state.clock.minute };
  m.seat = null; m.path = []; m.activity = 'ashore';
  return { ok: true, text: `${m.name} admitted at ${port.name}: ${q.what.join(', ')}, ${Math.max(1, Math.round(q.minutes / DAY_MIN))} days, ${cost.toLocaleString()} MCR.` };
}

/** Fetch someone out early: as they went in, and the rest of the bill back. */
export function discharge(state, id) {
  const m = state.ship.crew.find(x => x.id === id), A = m?.away;
  if (!A?.hospital) return { ok: false, text: 'Not in hospital.' };
  const now = state.clock.minute, left = Math.max(0, (A.full - now) / Math.max(1, A.full - A.since));
  const back = Math.round((A.cost || 0) * left / 10) * 10;
  state.resources.credits.current += back;
  A.until = now;
  return { ok: true, text: `${m.name} discharged early, ${back.toLocaleString()} MCR back.` };
}

/** Back from a stay: mended if it ran its course (crew-services.js leaveTick). */
export function backFromHospital(m, level, minute, finished) {
  if (!finished) return false;
  const brain = level === 'full' && hasCondition(m, 'brain-damage');
  hospitalCure(m, level);
  note(m, minute, brain ? 'Brain damage mended in hospital' : 'Treated in hospital');
  return true;
}
