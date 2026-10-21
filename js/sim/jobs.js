// ============================================================
// LONGHAUL — Crew job board
// Work that needs a qualified pair of hands at a particular place:
// rescues, repairs, maintenance, reactor procedures, taking the helm.
// Subsystems post jobs; crew-ai assigns them to people.
// ============================================================

export const JobType = {
  RESCUE: 'rescue',          // { patient }
  REPAIR: 'repair',          // { system }
  MAINTAIN: 'maintain',      // { system }
  FABRICATE: 'fabricate',    // refurbish scrap into spare parts at the machine shop
  REACTOR: 'reactor',        // { work, engineer }
  HELM: 'helm',              // fly the ship by hand (flight computer down)
  SEAL: 'seal',              // { deck } patch a hull breach (suit required)
  FIRE: 'fire',              // { deck } fight a fire (suit and extinguisher: fire.js)
};

export const JOB_PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };

/** Skill and minimum level each job needs. */
export const JOB_SKILL = {
  [JobType.RESCUE]: ['medical', 20],
  [JobType.REPAIR]: ['engineering', 15],
  [JobType.MAINTAIN]: ['engineering', 15],
  [JobType.FABRICATE]: ['engineering', 25],
  [JobType.REACTOR]: ['engineering', 15],
  [JobType.HELM]: ['piloting', 15],
  [JobType.SEAL]: ['engineering', 10],
  [JobType.FIRE]: ['engineering', 0],
};

export function createJobs() {
  return { list: [], nextId: 1 };
}

export function addJob(state, type, priority, data) {
  const job = { id: state.jobs.nextId++, type, priority, data, status: 'open', assignee: null, created: state.clock.minute };
  state.jobs.list.push(job);
  state.jobs.list.sort((a, b) => a.priority - b.priority || a.id - b.id);
  return job;
}

export function findJob(state, pred) {
  return state.jobs.list.find(pred) || null;
}

/** Remove a job; whoever was working it drops the task. */
export function closeJob(state, job) {
  const i = state.jobs.list.indexOf(job);
  if (i >= 0) state.jobs.list.splice(i, 1);
  for (const m of state.ship.crew) if (m.task?.jobId === job.id) { m.task = null; m.path = []; }
}

/** Raise or lower an open job's priority (re-sorts the board). */
export function setJobPriority(state, job, priority) {
  if (job.priority === priority) return;
  job.priority = priority;
  state.jobs.list.sort((a, b) => a.priority - b.priority || a.id - b.id);
}
