// ============================================================
// LONGHAUL — Jobs Queue System
// Priority queue of tasks crew can pick up. Each job is assigned
// to at most one crew member. Jobs are matched by skill type.
// ============================================================

import { getAtmoStatus, findNearestSuitLocker } from './life-support.js';

// ---- JOB PRIORITIES ----
export const JobPriority = {
  CRITICAL: 0,   // life-threatening: rescue, fire, hull breach
  HIGH: 1,       // important: repair, medical
  NORMAL: 2,     // standard: maintenance, operate station
  LOW: 3,        // optional: clean, organize
};

// ---- JOB TYPES ----
export const JobType = {
  // Medical
  RESCUE: 'rescue',
  RECOVER: 'recover',
  FIRST_AID: 'first-aid',

  // Operations
  MAN_STATION: 'man-station',     // sit at a terminal
  SECURE_FOR_BURN: 'secure-burn', // go to crash couch before heavy burn

  // Engineering
  REPAIR: 'repair',
  MAINTAIN: 'maintain',
  REPAIR_LS: 'repair-ls',        // Repair life support (quick patch or full)

  // Survival
  EQUIP_EVA: 'equip-eva',         // Don EVA suit from locker (dangerous atmosphere)

  // General
  PATROL: 'patrol',
};

// Skill required per job type (null = any)
const JOB_SKILL = {
  [JobType.RESCUE]: 'medical',
  [JobType.RECOVER]: null,
  [JobType.FIRST_AID]: 'medical',
  [JobType.MAN_STATION]: null,
  [JobType.SECURE_FOR_BURN]: null,
  [JobType.REPAIR]: 'engineering',
  [JobType.MAINTAIN]: 'engineering',
  [JobType.REPAIR_LS]: 'engineering',
  [JobType.EQUIP_EVA]: null,       // any crew can don a suit
  [JobType.PATROL]: 'security',
};

// Minimum skill level to pick a job (0 = no minimum)
const JOB_MIN_SKILL = {
  [JobType.RESCUE]: 20,
  [JobType.FIRST_AID]: 20,
  [JobType.REPAIR]: 15,
  [JobType.MAINTAIN]: 10,
  [JobType.REPAIR_LS]: 15,
};

let nextJobId = 1;

// ---- JOB QUEUE ----
const jobQueue = [];

// ---- PUBLIC API ----

// Create a new job and add it to the queue.
// Returns the job object.
export function createJob({
  type,
  priority = JobPriority.NORMAL,
  target = null,       // { deckIdx, x, y } — where the job takes place
  targetCrewId = null, // for rescue/first-aid: which crew member
  data = {},           // arbitrary extra data
} = {}) {
  const job = {
    id: nextJobId++,
    type,
    priority,
    target,
    targetCrewId,
    data,
    status: 'pending',      // pending | assigned | completed | cancelled
    assigneeId: null,       // crew member id
    createdAt: Date.now(),
  };

  jobQueue.push(job);
  // Keep sorted by priority (lower = more urgent)
  jobQueue.sort((a, b) => a.priority - b.priority);

  return job;
}

// Get all jobs in the queue (for UI/debug)
export function getJobQueue() {
  return jobQueue.slice();
}

// Get pending jobs
export function getPendingJobs() {
  return jobQueue.filter(j => j.status === 'pending');
}

// Get jobs assigned to a specific crew member
export function getCrewJobs(crewId) {
  return jobQueue.filter(j => j.assigneeId === crewId && j.status === 'assigned');
}

// Try to assign the highest-priority pending job to a crew member.
// Returns the job if assigned, null if nothing suitable.
export function pickJob(member) {
  if (member.dead || member.consciousness <= 10) return null;

  for (const job of jobQueue) {
    if (job.status !== 'pending') continue;

    // Check skill requirement
    const skillKey = JOB_SKILL[job.type];
    const minSkill = JOB_MIN_SKILL[job.type] || 0;

    if (skillKey && member.skills[skillKey] < minSkill) continue;

    // Don't self-assign rescue jobs
    if (job.targetCrewId === member.id) continue;

    // Assign
    job.status = 'assigned';
    job.assigneeId = member.id;
    return job;
  }

  return null;
}

// Complete a job and remove from queue
export function completeJob(jobId) {
  const idx = jobQueue.findIndex(j => j.id === jobId);
  if (idx === -1) return null;
  const job = jobQueue[idx];
  job.status = 'completed';
  jobQueue.splice(idx, 1);
  return job;
}

// Cancel a job (unassign and set back to pending, or remove)
export function cancelJob(jobId, remove = false) {
  const idx = jobQueue.findIndex(j => j.id === jobId);
  if (idx === -1) return null;
  const job = jobQueue[idx];
  if (remove) {
    job.status = 'cancelled';
    jobQueue.splice(idx, 1);
  } else {
    job.status = 'pending';
    job.assigneeId = null;
  }
  return job;
}

// Unassign all jobs from a crew member (e.g. they became unconscious)
export function unassignCrewJobs(crewId) {
  jobQueue.forEach(j => {
    if (j.assigneeId === crewId && j.status === 'assigned') {
      j.status = 'pending';
      j.assigneeId = null;
    }
  });
}

// Find a job by id
export function getJob(jobId) {
  return jobQueue.find(j => j.id === jobId) || null;
}

// Check if a job of given type already exists for a target
export function hasJobForTarget(type, targetCrewId) {
  return jobQueue.some(j =>
    j.type === type &&
    j.targetCrewId === targetCrewId &&
    (j.status === 'pending' || j.status === 'assigned')
  );
}

// Check if a job of given type already exists for a deck
export function hasJobForDeck(type, deckIdx) {
  return jobQueue.some(j =>
    j.type === type &&
    j.target && j.target.deckIdx === deckIdx &&
    (j.status === 'pending' || j.status === 'assigned')
  );
}

// Clear all jobs (for game reset)
export function clearJobs() {
  jobQueue.length = 0;
  nextJobId = 1;
}

// ---- AUTO-JOB GENERATION ----
// Called each game-minute to generate jobs based on ship state.

export function generateAutoJobs(ship, physics, devMode, lsEquipment, gameState) {
  const logs = [];

  // Build job index Set for O(1) lookups instead of scanning jobQueue each time
  const jobIndex = new Set();
  for (let i = 0; i < jobQueue.length; i++) {
    const j = jobQueue[i];
    if (j.status === 'pending' || j.status === 'assigned') {
      if (j.targetCrewId != null) jobIndex.add(j.type + ':' + j.targetCrewId);
      if (j.target && j.target.deckIdx != null) jobIndex.add(j.type + ':deck:' + j.target.deckIdx);
    }
  }

  // Build crewById Map for O(1) crew lookups
  const crewById = new Map();
  for (let i = 0; i < ship.crew.length; i++) {
    crewById.set(ship.crew[i].id, ship.crew[i]);
  }

  ship.crew.forEach(member => {
    if (member.dead) return;

    // Rescue job for unconscious crew
    if (member.consciousness <= 10 && !jobIndex.has(JobType.RESCUE + ':' + member.id)) {
      const job = createJob({
        type: JobType.RESCUE,
        priority: JobPriority.CRITICAL,
        targetCrewId: member.id,
        target: { deckIdx: member.deck, x: member.x, y: member.y },
      });
      if (devMode) logs.push(`[JOBS] Created RESCUE job #${job.id} for ${member.name}`);
    }

    // First aid for critical crew (non-unconscious)
    if (member.conditions.includes('critical') && member.consciousness > 10 &&
        !jobIndex.has(JobType.FIRST_AID + ':' + member.id)) {
      const job = createJob({
        type: JobType.FIRST_AID,
        priority: JobPriority.CRITICAL,
        targetCrewId: member.id,
        target: { deckIdx: member.deck, x: member.x, y: member.y },
      });
      if (devMode) logs.push(`[JOBS] Created FIRST_AID job #${job.id} for ${member.name}`);
    }
  });

  // Secure-for-burn: when thrust > 1.5G, crew should move to crash couches
  const gForce = physics.gForce || 0;
  const highG = gForce >= 1.5;

  if (highG) {
    ship.crew.forEach(member => {
      if (member.dead || member.consciousness <= 10) return;
      // Don't create if already has a secure-burn job
      if (jobIndex.has(JobType.SECURE_FOR_BURN + ':' + member.id)) return;
      const job = createJob({
        type: JobType.SECURE_FOR_BURN,
        priority: JobPriority.HIGH,
        targetCrewId: member.id,
        data: {},
      });
      // Self-assign immediately
      job.status = 'assigned';
      job.assigneeId = member.id;
      if (devMode) logs.push(`[JOBS] ${member.name} securing for burn (${gForce.toFixed(1)}G) — job #${job.id}`);
    });
  } else {
    // Cancel secure-burn jobs when G drops back below threshold
    jobQueue.forEach(j => {
      if (j.type === JobType.SECURE_FOR_BURN && (j.status === 'pending' || j.status === 'assigned')) {
        j.status = 'cancelled';
        if (devMode) logs.push(`[JOBS] Cancelled secure-burn job #${j.id} (G normalised)`);
      }
    });
    // Remove cancelled ones
    for (let i = jobQueue.length - 1; i >= 0; i--) {
      if (jobQueue[i].type === JobType.SECURE_FOR_BURN && jobQueue[i].status === 'cancelled') {
        jobQueue.splice(i, 1);
      }
    }
  }

  // Life support repair jobs
  if (lsEquipment) {
    Object.entries(lsEquipment).forEach(([deckIdxStr, eq]) => {
      const deckIdx = parseInt(deckIdxStr);
      if (eq.enabled !== false && (eq.status === 'failed' || eq.status === 'degraded') &&
          !jobIndex.has(JobType.REPAIR_LS + ':deck:' + deckIdx)) {
        const deckName = ship.decks[deckIdx]?.name || `Deck ${deckIdx}`;
        const job = createJob({
          type: JobType.REPAIR_LS,
          priority: eq.status === 'failed' ? JobPriority.CRITICAL : JobPriority.HIGH,
          target: { deckIdx, x: eq.x, y: eq.y },
          data: { deckName },
        });
        if (devMode) logs.push(`[JOBS] Created REPAIR_LS job #${job.id} for ${deckName} (${eq.status})`);
      }
    });
  }

  // EVA suit equip jobs — when atmosphere is dangerous, crew should don suits
  if (gameState) {
    ship.crew.forEach(member => {
      if (member.dead || member.consciousness <= 10) return;
      if (member.evaSuit && member.evaSuit.wearing) return; // already suited
      if (jobIndex.has(JobType.EQUIP_EVA + ':' + member.id)) return; // already has job

      const deck = ship.decks[member.deck];
      if (!deck || !deck.atmosphere) return;
      const status = getAtmoStatus(deck.atmosphere);
      if (status !== 'warning' && status !== 'critical' && status !== 'breached' &&
          status !== 'depressurized' && status !== 'vacuum') return;

      // Check if there's a suit available on their deck
      const locker = findNearestSuitLocker(gameState, member.deck, member.x, member.y);
      if (!locker) return;

      const job = createJob({
        type: JobType.EQUIP_EVA,
        priority: JobPriority.CRITICAL,
        targetCrewId: member.id,
        target: { deckIdx: locker.deckIdx, x: locker.x, y: locker.y },
        data: { lockerIdx: gameState.suitLockers.indexOf(locker) },
      });
      // Self-assign immediately
      job.status = 'assigned';
      job.assigneeId = member.id;
      if (devMode) logs.push(`[JOBS] ${member.name} needs EVA suit — job #${job.id}`);
    });

    // Cancel EVA suit jobs when atmosphere is safe again
    jobQueue.forEach(j => {
      if (j.type !== JobType.EQUIP_EVA) return;
      if (j.status !== 'pending' && j.status !== 'assigned') return;
      const member = crewById.get(j.targetCrewId);
      if (!member) return;
      const deck = ship.decks[member.deck];
      if (!deck || !deck.atmosphere) return;
      const status = getAtmoStatus(deck.atmosphere);
      if (status === 'nominal') {
        j.status = 'cancelled';
        if (devMode) logs.push(`[JOBS] Cancelled EVA suit job #${j.id} — atmosphere safe`);
      }
    });
    // Clean up cancelled EVA jobs
    for (let i = jobQueue.length - 1; i >= 0; i--) {
      if (jobQueue[i].type === JobType.EQUIP_EVA && jobQueue[i].status === 'cancelled') {
        jobQueue.splice(i, 1);
      }
    }
  }

  // Auto-assign pending jobs to best available crew member
  // For each pending job (priority-sorted), find the most skilled idle crew
  const assignedThisRound = new Set();
  for (const job of jobQueue) {
    if (job.status !== 'pending') continue;

    const skillKey = JOB_SKILL[job.type];
    const minSkill = JOB_MIN_SKILL[job.type] || 0;

    // Find eligible idle crew, sorted by relevant skill (best first)
    const candidates = ship.crew
      .filter(m => {
        if (m.dead || m.consciousness <= 10) return false;
        if (assignedThisRound.has(m.id)) return false;
        if (getCrewJobs(m.id).length > 0) return false;
        if (job.targetCrewId === m.id) return false; // don't self-assign rescue
        if (skillKey && m.skills[skillKey] < minSkill) return false;
        return true;
      })
      .sort((a, b) => {
        // Sort by relevant skill descending; if no skill needed, any crew is fine
        const skillA = skillKey ? (a.skills[skillKey] || 0) : 0;
        const skillB = skillKey ? (b.skills[skillKey] || 0) : 0;
        return skillB - skillA;
      });

    if (candidates.length > 0) {
      const best = candidates[0];
      job.status = 'assigned';
      job.assigneeId = best.id;
      assignedThisRound.add(best.id);
      if (devMode) {
        const skillVal = skillKey ? ` (${skillKey}: ${best.skills[skillKey] || 0})` : '';
        logs.push(`[JOBS] ${best.name}${skillVal} assigned to ${job.type} job #${job.id}`);
      }
    }
  }

  // Unassign jobs from incapacitated crew
  ship.crew.forEach(member => {
    if (member.dead || member.consciousness <= 10) {
      const jobs = getCrewJobs(member.id);
      if (jobs.length > 0) {
        unassignCrewJobs(member.id);
        if (devMode) logs.push(`[JOBS] Unassigned ${jobs.length} job(s) from incapacitated ${member.name}`);
      }
    }
  });

  return logs;
}
