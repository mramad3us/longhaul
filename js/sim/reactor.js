// ============================================================
// LONGHAUL — Fusion reactor & ship power
// Engineering procedures (shutdown, startup, containment patch,
// emergency scram) need an engineer physically at the reactor;
// progress only accrues while they are there working.
// ============================================================

import { addJob, closeJob, findJob, JobType, JOB_PRIORITY } from './jobs.js';
import { engineerAtReactor } from './crew-ai.js';
import { powerRegenFactor } from './systems.js';
import { isConscious } from './crew.js';

export const ReactorState = {
  ONLINE: 'online',
  SHUTTING_DOWN: 'shutting-down',          // engineer procedure (12h)
  SHUTDOWN_COUNTDOWN: 'shutdown-countdown',// 1h, cancellable
  OFFLINE: 'offline',                      // batteries draining
  STARTING_UP: 'starting-up',              // engineer procedure (5h)
  CONTAINMENT_FAILURE: 'containment-failure',
  EMERGENCY_SHUTOFF: 'emergency-shutoff',  // 1h countdown to fuel dump
};

const SHUTDOWN_WORK = 720;
const SHUTDOWN_COUNTDOWN = 60;
const STARTUP_WORK = 300;
const PATCH_WORK = 60;
export const STARTUP_MIN_FUEL = 2;
export const MIN_ENGINEERING = 15;
const EMERGENCY_COUNTDOWN = 60;
const EMERGENCY_FUEL_RESERVE = 10;
const REGEN_PER_MIN = 10 / 60;
const DRAIN_PER_MIN = 1 / 60;
const CONTAINMENT_MINUTES = 90;

export function createReactor() {
  return { status: ReactorState.ONLINE, job: null, work: null, progress: 0, countdown: 0, breach: false, blackout: false };
}

export const isReactorOnline = (state) => {
  const s = state.reactor.status;
  return s === ReactorState.ONLINE || s === ReactorState.SHUTTING_DOWN || s === ReactorState.SHUTDOWN_COUNTDOWN ||
    s === ReactorState.EMERGENCY_SHUTOFF || s === ReactorState.CONTAINMENT_FAILURE;
};

export const isPowered = (state) => isReactorOnline(state) || state.resources.power.current > 0;

function startWork(state, work, engineerId = null) {
  const r = state.reactor;
  if (r.job) { const j = findJob(state, x => x.id === r.job); if (j) closeJob(state, j); }
  const job = addJob(state, JobType.REACTOR, work === 'scram' ? JOB_PRIORITY.CRITICAL : JOB_PRIORITY.HIGH, { work, engineer: engineerId });
  r.job = job.id;
  r.work = work;
  r.progress = 0;
  return job;
}

function finishWork(state) {
  const r = state.reactor;
  const j = r.job && findJob(state, x => x.id === r.job);
  if (j) closeJob(state, j);
  r.job = null; r.work = null; r.progress = 0;
}

export function reactorTick(state, emit = () => {}) {
  const r = state.reactor;
  const power = state.resources.power;
  const fuel = state.resources.fuel;
  const working = r.job != null && engineerAtReactor(state, r.job);

  // A throttled reactor (cooling trouble) makes less surplus power
  if (isReactorOnline(state)) power.current = Math.min(power.max, power.current + REGEN_PER_MIN * powerRegenFactor(state));
  else power.current = Math.max(0, power.current - DRAIN_PER_MIN);

  // A procedure stalls if nobody qualified is left to do it
  if (r.job) {
    const job = findJob(state, x => x.id === r.job);
    const qualified = state.ship.crew.some(m => isConscious(m) && m.skills.engineering >= MIN_ENGINEERING &&
      (job?.data.engineer == null || job.data.engineer === m.id));
    if (!job || !qualified) {
      const work = r.work;
      finishWork(state);
      if (r.status === ReactorState.SHUTTING_DOWN) r.status = ReactorState.ONLINE;
      if (r.status === ReactorState.STARTING_UP) r.status = ReactorState.OFFLINE;
      emit('reactor-procedure-aborted', { work, reason: 'no qualified engineer' });
    }
  }

  switch (r.status) {
    case ReactorState.SHUTTING_DOWN:
      if (working && ++r.progress >= SHUTDOWN_WORK) {
        finishWork(state);
        r.status = ReactorState.SHUTDOWN_COUNTDOWN;
        r.countdown = SHUTDOWN_COUNTDOWN;
        emit('reactor-countdown', {});
      }
      break;
    case ReactorState.SHUTDOWN_COUNTDOWN:
      if (--r.countdown <= 0) { r.status = ReactorState.OFFLINE; emit('reactor-offline', {}); }
      break;
    case ReactorState.STARTING_UP:
      if (fuel.current < STARTUP_MIN_FUEL) {
        finishWork(state); r.status = ReactorState.OFFLINE;
        emit('reactor-procedure-aborted', { work: 'startup', reason: 'insufficient fuel' });
      } else if (working && ++r.progress >= STARTUP_WORK) {
        finishWork(state);
        r.status = ReactorState.ONLINE;
        emit('reactor-online', {});
      }
      break;
    case ReactorState.OFFLINE:
      if (r.work === 'patch' && working && ++r.progress >= PATCH_WORK) {
        finishWork(state);
        r.breach = false;
        emit('reactor-patched', {});
      }
      break;
    case ReactorState.EMERGENCY_SHUTOFF:
      if (--r.countdown <= 0) {
        fuel.current = Math.min(fuel.current, EMERGENCY_FUEL_RESERVE);
        r.status = ReactorState.OFFLINE;
        emit('reactor-fuel-dumped', { remaining: fuel.current });
      }
      break;
    case ReactorState.CONTAINMENT_FAILURE:
      if (r.work === 'scram' && working) {
        finishWork(state);
        r.status = ReactorState.OFFLINE;
        r.countdown = 0;
        emit('reactor-scrammed', {});
      } else if (--r.countdown <= 0 && !r.supercritical) {
        r.supercritical = true;           // game.js turns this into the ship's destruction
        emit('reactor-supercritical', {});
      }
      break;
  }

  const blackout = !isReactorOnline(state) && power.current <= 0;
  if (blackout !== r.blackout) {
    r.blackout = blackout;
    emit(blackout ? 'blackout' : 'blackout-end', {});
  }
}

// ---- ORDERS ----

const fail = (message) => ({ success: false, message });

export function orderShutdown(state, engineerId = null) {
  const r = state.reactor;
  if (r.status === ReactorState.CONTAINMENT_FAILURE) {
    startWork(state, 'scram', engineerId);
    return { success: true, message: 'Engineer to the reactor — emergency scram' };
  }
  if (r.status !== ReactorState.ONLINE) return fail('Reactor is not running normally');
  r.status = ReactorState.SHUTTING_DOWN;
  r.breach = false;
  startWork(state, 'shutdown', engineerId);
  return { success: true, message: 'Reactor shutdown procedure ordered (12h of work at the reactor)' };
}

export function cancelShutdown(state) {
  const r = state.reactor;
  if (r.status === ReactorState.SHUTTING_DOWN) { finishWork(state); r.status = ReactorState.ONLINE; return { success: true, message: 'Shutdown procedure cancelled' }; }
  if (r.status !== ReactorState.SHUTDOWN_COUNTDOWN) return fail('No shutdown to cancel');
  r.status = ReactorState.ONLINE;
  r.countdown = 0;
  return { success: true, message: 'Shutdown cancelled — reactor stays online' };
}

export function orderStartup(state, engineerId = null) {
  const r = state.reactor;
  if (r.status !== ReactorState.OFFLINE) return fail('Reactor must be offline to start');
  if (r.breach) return fail('Containment breach — patch it first');
  if (state.resources.fuel.current < STARTUP_MIN_FUEL) return fail(`Need at least ${STARTUP_MIN_FUEL} kg of fuel`);
  r.status = ReactorState.STARTING_UP;
  startWork(state, 'startup', engineerId);
  return { success: true, message: 'Reactor startup ordered (5h of work at the reactor)' };
}

export function orderPatch(state, engineerId = null) {
  const r = state.reactor;
  if (r.status !== ReactorState.OFFLINE || !r.breach) return fail('Nothing to patch');
  startWork(state, 'patch', engineerId);
  return { success: true, message: 'Containment patch ordered (1h of work at the reactor)' };
}

export function emergencyShutoff(state) {
  const r = state.reactor;
  if (!isReactorOnline(state)) return fail('Reactor already offline');
  if (r.status === ReactorState.EMERGENCY_SHUTOFF) return fail('Emergency shutoff already running');
  if (r.job) finishWork(state);
  r.status = ReactorState.EMERGENCY_SHUTOFF;
  r.countdown = EMERGENCY_COUNTDOWN;
  return { success: true, message: `EMERGENCY SHUTOFF — fuel dump in ${EMERGENCY_COUNTDOWN} min` };
}

export function cancelEmergencyShutoff(state) {
  const r = state.reactor;
  if (r.status !== ReactorState.EMERGENCY_SHUTOFF) return fail('No emergency shutoff running');
  r.status = r.breach ? ReactorState.CONTAINMENT_FAILURE : ReactorState.ONLINE;
  if (r.breach) r.countdown = CONTAINMENT_MINUTES;
  return { success: true, message: 'Emergency shutoff cancelled' };
}

export function immediateShutoff(state) {
  const r = state.reactor;
  if (!isReactorOnline(state)) return fail('Reactor already offline');
  if (r.job) finishWork(state);
  r.status = ReactorState.OFFLINE;
  state.resources.fuel.current = 0;
  return { success: true, message: 'IMMEDIATE SHUTOFF — all reaction mass dumped' };
}

export function triggerContainmentFailure(state) {
  const r = state.reactor;
  if (!isReactorOnline(state)) return false;
  if (r.job) finishWork(state);
  r.status = ReactorState.CONTAINMENT_FAILURE;
  r.countdown = CONTAINMENT_MINUTES;
  r.breach = true;
  return true;
}

export function reactorStatusText(state) {
  const r = state.reactor;
  const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.floor(m % 60)).padStart(2, '0')}m`;
  const working = r.job != null && engineerAtReactor(state, r.job);
  const waiting = r.job != null && !working ? ' — engineer en route' : '';
  switch (r.status) {
    case ReactorState.ONLINE: return 'ONLINE — nominal';
    case ReactorState.SHUTTING_DOWN: return `SHUTTING DOWN — ${hm(SHUTDOWN_WORK - r.progress)} of work left${waiting}`;
    case ReactorState.SHUTDOWN_COUNTDOWN: return `SHUTDOWN IN ${r.countdown} min — cancel available`;
    case ReactorState.OFFLINE:
      if (r.breach) return r.work === 'patch' ? `OFFLINE — patching containment (${hm(PATCH_WORK - r.progress)})${waiting}` : 'OFFLINE — CONTAINMENT BREACH, patch required';
      return 'OFFLINE — emergency power';
    case ReactorState.STARTING_UP: return `STARTING UP — ${hm(STARTUP_WORK - r.progress)} of work left${waiting}`;
    case ReactorState.CONTAINMENT_FAILURE: return `⚠ CONTAINMENT FAILURE — ${r.countdown} min to supercritical${r.work === 'scram' ? waiting || ' — scramming' : ''}`;
    case ReactorState.EMERGENCY_SHUTOFF: return `EMERGENCY SHUTOFF — fuel dump in ${r.countdown} min`;
    default: return r.status;
  }
}
