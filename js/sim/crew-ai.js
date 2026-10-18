// ============================================================
// LONGHAUL — Crew behaviour (per game-minute)
//
// Each crew member runs one task at a time. Tasks are chosen by
// priority every minute:
//   1. ship policy 'secure' (burns, flips, combat) → crash couch
//   2. bad air on their deck → don an EVA suit
//   3. assigned job (rescue, repair, reactor work)
//   4. own injuries → walk to the autodoc
//   5. otherwise stand watch / patrol their home deck
// Movement follows real paths through the ladder shaft. Positions are
// continuous ship coordinates; the renderer interpolates between
// minutes using $px/$py.
// ============================================================

import { random, randInt, pick } from '../core/rng.js';
import { shipGeometry, findPath, nearestNode, deckNodes } from './ship-layout.js';
import { isConscious, isAble, needsMedical, mobility, stabilize, medbayTick, hasCondition } from './crew.js';

export const WALK_TILES_PER_MIN = 0.8;
const RUN = 2.5;                    // emergencies: sprinting to a downed crewmate
const CRAWL = 0.15;                 // minimum speed dragging yourself to a couch under G
const MEDBAY_SUPPLY_PER_MIN = 1 / 240;

// ---- JOBS ----

export const JobType = {
  RESCUE: 'rescue',
  REPAIR_LS: 'repair-ls',
  REACTOR: 'reactor',
};
export const JOB_PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };
const JOB_SKILL = { [JobType.RESCUE]: ['medical', 20], [JobType.REPAIR_LS]: ['engineering', 15], [JobType.REACTOR]: ['engineering', 15] };

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

export function closeJob(state, job) {
  const i = state.jobs.list.indexOf(job);
  if (i >= 0) state.jobs.list.splice(i, 1);
  for (const m of state.ship.crew) if (m.task?.jobId === job.id) m.task = null;
}

// ---- SEATS ----

function occupancy(state) {
  const occ = new Map();
  for (const m of state.ship.crew) if (m.seat) occ.set(m.seat, m.id);
  return occ;
}

function fixtureById(geo, id) {
  for (const list of Object.values(geo.fixtures)) for (const f of list) if (f.id === id) return f;
  return null;
}

/** Secured = strapped into a couch or lying in the autodoc. */
export const isSecured = (m) => !!m.seat;

export function crewSecureStatus(state) {
  const able = state.ship.crew.filter(isConscious);
  const pilot = activePilot(state);
  return {
    total: able.length,
    secured: able.filter(isSecured).length,
    pilot,
    pilotReady: !!pilot && !!pilot.seat?.startsWith('couch:'),   // every couch has helm controls
    unsecured: able.filter(m => !isSecured(m)),
    helpless: state.ship.crew.filter(m => !m.dead && !isConscious(m) && !isSecured(m)),
  };
}

/** Who flies: the Pilot, else the best conscious pilot. */
export function activePilot(state) {
  const able = state.ship.crew.filter(isConscious);
  return able.find(m => m.role === 'Pilot') ||
    able.slice().sort((a, b) => b.skills.piloting - a.skills.piloting)[0] || null;
}

// ---- MOVEMENT ----

function setDestination(state, m, sx, sy) {
  const geo = shipGeometry(state.ship);
  const from = nearestNode(geo, m.pos.sx, m.pos.sy);
  const to = nearestNode(geo, sx, sy);
  const path = findPath(geo, from, to) || [];
  // first hop: snap onto the graph from wherever we are (after a slide, etc.)
  const start = geo.nodes[from];
  if (start && (Math.abs(start.sx - m.pos.sx) > 0.01 || Math.abs(start.sy - m.pos.sy) > 0.01)) path.unshift({ sx: start.sx, sy: start.sy });
  // final hop onto a non-walkable fixture (couch) if requested
  const end = path.length ? path[path.length - 1] : { sx: m.pos.sx, sy: m.pos.sy };
  if (Math.abs(end.sx - sx) > 0.01 || Math.abs(end.sy - sy) > 0.01) path.push({ sx, sy });
  m.path = path;
}

/** Walk along the path; returns true when the path is complete. */
function walk(m, tiles) {
  let budget = tiles;
  while (budget > 1e-6 && m.path.length) {
    const wp = m.path[0];
    const dx = wp.sx - m.pos.sx, dy = wp.sy - m.pos.sy;
    const d = Math.hypot(dx, dy);
    if (d <= budget) {
      m.pos.sx = wp.sx; m.pos.sy = wp.sy;
      m.path.shift();
      budget -= d;
    } else {
      m.pos.sx += dx / d * budget;
      m.pos.sy += dy / d * budget;
      budget = 0;
    }
  }
  return m.path.length === 0;
}

function leaveSeat(state, m) {
  if (!m.seat) return;
  const geo = shipGeometry(state.ship);
  const f = fixtureById(geo, m.seat);
  m.seat = null;
  if (f && f.access != null && f.kind !== 'medbay') {
    const n = geo.nodes[f.access];
    m.pos.sx = n.sx; m.pos.sy = n.sy;
  }
}

function deckOf(state, m) {
  return shipGeometry(state.ship).deckOfRow(m.pos.sy);
}

// ---- TASK CHOICE ----

function nearestFreeFixture(state, m, kind, occ, prefer = null) {
  const geo = shipGeometry(state.ship);
  const list = geo.fixtures[kind] || [];
  let best = null, bestD = Infinity;
  const myDeck = geo.deckOfRow(m.pos.sy);
  for (const f of list) {
    if (occ.has(f.id) && occ.get(f.id) !== m.id) continue;
    if (prefer && !prefer(f)) continue;
    const d = Math.abs(f.sx - m.pos.sx) + Math.abs(f.sy - m.pos.sy) + (f.deck === myDeck ? 0 : 3);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

function assignSecure(state, m, occ) {
  if (m.task?.type === 'secure') return true;
  const isPilot = activePilot(state) === m;
  let couch = isPilot ? nearestFreeFixture(state, m, 'couch', occ, f => f.deck === 0) : null;
  couch ||= nearestFreeFixture(state, m, 'couch', occ);
  if (!couch) return false;
  leaveSeat(state, m);
  m.task = { type: 'secure', seat: couch.id };
  occ.set(couch.id, m.id);   // reserve
  setDestination(state, m, couch.sx, couch.sy);
  return true;
}

function deckAirIsBad(state, deck) {
  const atmo = state.ship.decks[deck]?.atmosphere;
  if (!atmo) return false;
  return atmo.breached || atmo.vented || atmo.pressure < 63 || atmo.o2Pct < 16 || atmo.co2Pct > 3;
}

function lockerWithSuit(state, m) {
  const geo = shipGeometry(state.ship);
  const deck = geo.deckOfRow(m.pos.sy);
  const lockers = (geo.fixtures.locker || []).filter(f => state.lifeSupport.lockers[f.id]?.hasSuit);
  let best = null, bestD = Infinity;
  for (const f of lockers) {
    const d = Math.abs(f.sx - m.pos.sx) + Math.abs(f.sy - m.pos.sy) + (f.deck === deck ? 0 : 6);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

function pickJobFor(state, m) {
  for (const job of state.jobs.list) {
    if (job.status !== 'open') continue;
    const [skill, min] = JOB_SKILL[job.type] || [null, 0];
    if (skill && (m.skills[skill] || 0) < min) continue;
    if (job.type === JobType.RESCUE && job.data.patient === m.id) continue;
    if (job.data.engineer != null && job.data.engineer !== m.id) continue;
    // Defer to a better idle candidate: for rescues the closest qualified
    // responder (seconds matter), otherwise the most skilled.
    const idle = (o) => o !== m && isAble(o) && !o.task?.jobId && !isSecured(o) &&
      (!skill || (o.skills[skill] || 0) >= min) && job.data.engineer == null &&
      !(job.type === JobType.RESCUE && job.data.patient === o.id);
    let better;
    if (job.type === JobType.RESCUE) {
      const p = state.ship.crew.find(c => c.id === job.data.patient);
      const dist = (o) => Math.abs(o.pos.sx - p.pos.sx) + Math.abs(o.pos.sy - p.pos.sy);
      better = state.ship.crew.some(o => idle(o) && dist(o) < dist(m) - 0.5);
    } else {
      better = state.ship.crew.some(o => idle(o) && skill && (o.skills[skill] || 0) > (m.skills[skill] || 0));
    }
    if (better) continue;
    return job;
  }
  return null;
}

function startJob(state, m, job) {
  const geo = shipGeometry(state.ship);
  job.status = 'assigned';
  job.assignee = m.id;
  leaveSeat(state, m);
  if (job.type === JobType.RESCUE) {
    const p = state.ship.crew.find(c => c.id === job.data.patient);
    m.task = { type: 'rescue', jobId: job.id, patient: p.id, phase: 'goto', timer: 0 };
    setDestination(state, m, Math.round(p.pos.sx), Math.round(p.pos.sy));
  } else if (job.type === JobType.REPAIR_LS) {
    const f = (geo.fixtures.lifeSupport || []).find(x => x.deck === job.data.deck);
    const n = geo.nodes[f.access];
    m.task = { type: 'repair', jobId: job.id, deck: job.data.deck, phase: 'goto', timer: 0, duration: Math.max(8, 25 - Math.floor(m.skills.engineering / 6)) };
    setDestination(state, m, n.sx, n.sy);
  } else if (job.type === JobType.REACTOR) {
    const f = geo.fixtures.reactor[0];
    const n = geo.nodes[f.access];
    m.task = { type: 'reactor', jobId: job.id, phase: 'goto' };
    setDestination(state, m, n.sx, n.sy);
  }
}

// ---- JOB GENERATION ----

function generateJobs(state) {
  const crew = state.ship.crew;
  for (const p of crew) {
    if (p.dead) continue;
    const helpless = !isConscious(p) || hasCondition(p, 'critical');
    const inCare = p.seat?.startsWith('medbay:') || p.task?.type === 'carried' || p.task?.type === 'heal';
    const has = state.jobs.list.find(j => j.type === JobType.RESCUE && j.data.patient === p.id);
    if (helpless && !inCare && !has) addJob(state, JobType.RESCUE, JOB_PRIORITY.CRITICAL, { patient: p.id });
    if (has && (!helpless || inCare) && has.status === 'open') closeJob(state, has);
  }
  for (const p of crew) {
    // a dead patient ends any rescue
    if (p.dead) {
      const j = state.jobs.list.find(x => x.type === JobType.RESCUE && x.data.patient === p.id);
      if (j) closeJob(state, j);
    }
  }
  const blackout = state.reactor?.blackout;
  for (const [deckStr, eq] of Object.entries(state.lifeSupport.equipment)) {
    const deck = +deckStr;
    const broken = eq.enabled && (eq.status === 'failed' || eq.status === 'degraded');
    const has = state.jobs.list.find(j => j.type === JobType.REPAIR_LS && j.data.deck === deck);
    if (broken && !has && !blackout) addJob(state, JobType.REPAIR_LS, eq.status === 'failed' ? JOB_PRIORITY.CRITICAL : JOB_PRIORITY.HIGH, { deck });
    if (!broken && has) closeJob(state, has);
  }
}

// ---- MAIN TICK ----

/**
 * One game-minute of crew behaviour.
 * @param ctx { gForce, policy: 'secure'|'free', hooks: { repairLS(deck, skill), onEvent(type, payload) } }
 */
export function crewTick(state, ctx) {
  const crew = state.ship.crew;
  const geo = shipGeometry(state.ship);
  const occ = occupancy(state);
  const g = ctx.gForce;
  const emit = ctx.emit || (() => {});

  for (const m of crew) { m.$px = m.pos.sx; m.$py = m.pos.sy; }

  generateJobs(state);

  for (const m of crew) {
    if (m.dead) { if (m.task?.type !== 'carried') { m.path = []; } continue; }

    // ---- Incapacitated: drop what you were doing (couch/bed keep holding you)
    if (!isConscious(m)) {
      if (m.task && m.task.type !== 'carried' && m.task.type !== 'heal') abandonTask(state, m);
      m.path = [];
      if (m.task?.type === 'heal' && !m.seat) {
        // waiting beside the autodoc: orderlies (the autodoc arm) take the next patient in
        const bed = geo.fixtures.medbay?.[0];
        if (bed && !occ.has(bed.id)) { m.seat = bed.id; occ.set(bed.id, m.id); m.pos.sx = bed.sx; m.pos.sy = bed.sy; }
      }
      if (m.task?.type === 'heal' && m.seat) healStep(state, m, ctx);
      m.activity = m.seat ? (m.seat.startsWith('medbay') ? 'healing' : 'secured') : 'down';
      continue;
    }

    const secure = ctx.policy === 'secure';

    // ---- Priority 1: secure for maneuvers
    if (secure && !m.seat?.startsWith('couch') && !(m.task?.type === 'heal' && m.seat) &&
        !(m.task?.type === 'rescue' && m.task.phase === 'carry')) {
      if (m.task && m.task.type !== 'secure') abandonTask(state, m);
      assignSecure(state, m, occ);
    }
    if (!secure && m.task?.type === 'secure') {
      leaveSeat(state, m);
      m.task = null;
      m.pause = randInt(1, 4);
    }

    // ---- Priority 2: bad air → suit up
    if (!m.task && !m.suit.wearing && deckAirIsBad(state, deckOf(state, m))) {
      const locker = lockerWithSuit(state, m);
      if (locker) {
        leaveSeat(state, m);
        m.task = { type: 'suit', locker: locker.id, phase: 'goto', timer: 0 };
        const n = geo.nodes[locker.access];
        setDestination(state, m, n.sx, n.sy);
      }
    }

    // ---- Priority 3: jobs (only when free to move; they preempt idle patrols)
    if ((!m.task || m.task.type === 'patrol') && !secure && isAble(m)) {
      const job = pickJobFor(state, m);
      if (job) startJob(state, m, job);
    }

    // ---- Priority 4: get patched up
    if (!m.task && !secure && needsMedical(m) && !hasCondition(m, 'critical')) {
      startHeal(state, m, occ);
    }

    // ---- Priority 5: watch / patrol
    if (!m.task && !secure && !m.seat) {
      if (m.pause > 0) { m.pause--; }
      else {
        const nodes = deckNodes(geo, m.homeDeck);
        const n = geo.nodes[pick(nodes)];
        if (n) {
          m.task = { type: 'patrol' };
          setDestination(state, m, n.sx, n.sy);
        }
      }
    }

    stepTask(state, m, ctx, occ, g, emit);
  }
}

function startHeal(state, m, occ) {
  const geo = shipGeometry(state.ship);
  const bed = (geo.fixtures.medbay || [])[0];
  if (!bed) return false;
  leaveSeat(state, m);
  m.task = { type: 'heal', phase: 'goto' };
  // walk next to the bed; take it when free
  setDestination(state, m, bed.sx, bed.sy);
  return true;
}

function dropPatient(state, carrier) {
  const p = state.ship.crew.find(c => c.id === carrier.task?.patient);
  if (p && p.task?.type === 'carried') {
    p.task = null;
    p.pos.sx = Math.round(carrier.pos.sx); p.pos.sy = Math.round(carrier.pos.sy);
  }
}

function healStep(state, m, ctx) {
  const res = state.resources.medSupplies;
  const supplied = res.current > 0;
  if (supplied) res.current = Math.max(0, res.current - MEDBAY_SUPPLY_PER_MIN);
  const healed = medbayTick(m, supplied);
  if (healed && isConscious(m)) {
    leaveSeat(state, m);
    const geo = shipGeometry(state.ship);
    const bed = geo.fixtures.medbay[0];
    const n = geo.nodes.find(x => x.deck === bed.deck && Math.abs(x.sx - bed.sx) + Math.abs(x.sy - bed.sy) === 1);
    if (n) { m.pos.sx = n.sx; m.pos.sy = n.sy; }
    m.task = null;
    m.pause = 2;
    ctx.emit?.('crew-healed', { member: m });
  }
}

function stepTask(state, m, ctx, occ, g, emit) {
  const t = m.task;
  const speed = WALK_TILES_PER_MIN * mobility(m, g);
  const geo = shipGeometry(state.ship);

  if (!t) { m.activity = m.seat ? 'secured' : 'idle'; return; }

  switch (t.type) {
    case 'patrol': {
      m.activity = 'patrol';
      if (walk(m, speed)) { m.task = null; m.pause = randInt(3, 12); }
      break;
    }
    case 'secure': {
      if (m.seat === t.seat) { m.activity = 'secured'; break; }
      m.activity = 'securing';
      const s = Math.max(speed, CRAWL);
      if (walk(m, s)) {
        // claim the couch (someone may have beaten us to it)
        if (occ.has(t.seat) && occ.get(t.seat) !== m.id && state.ship.crew.find(c => c.id === occ.get(t.seat))?.seat === t.seat) {
          m.task = null; assignSecure(state, m, occ);
        } else {
          m.seat = t.seat;
          occ.set(t.seat, m.id);
          m.activity = 'secured';
        }
      }
      break;
    }
    case 'suit': {
      m.activity = 'suiting';
      if (t.phase === 'goto') {
        if (walk(m, speed)) t.phase = 'don';
      } else if (++t.timer >= 3) {
        const locker = state.lifeSupport.lockers[t.locker];
        if (locker?.hasSuit) {
          locker.hasSuit = false;
          m.suit = { wearing: true, o2: 48, lockerId: t.locker };
          emit('crew-suited', { member: m });
        }
        m.task = null;
      }
      break;
    }
    case 'heal': {
      const bed = geo.fixtures.medbay?.[0];
      if (m.seat) { m.activity = 'healing'; healStep(state, m, ctx); break; }
      m.activity = 'to-medbay';
      if (walk(m, speed) || !m.path.length) {
        const holder = occ.get(bed.id);
        if (holder == null || holder === m.id) {
          m.seat = bed.id; occ.set(bed.id, m.id);
          m.pos.sx = bed.sx; m.pos.sy = bed.sy;
          m.activity = 'healing';
        } else {
          m.activity = 'waiting';      // queue beside the autodoc
        }
      }
      break;
    }
    case 'rescue': {
      const p = state.ship.crew.find(c => c.id === t.patient);
      const job = state.jobs.list.find(j => j.id === t.jobId);
      if (!p || p.dead || !job) { if (t.phase === 'carry') dropPatient(state, m); m.task = null; break; }
      if (t.phase === 'goto') {
        m.activity = 'rescuing';
        if (walk(m, speed * RUN)) {
          if (Math.hypot(p.pos.sx - m.pos.sx, p.pos.sy - m.pos.sy) > 1.2) {
            setDestination(state, m, Math.round(p.pos.sx), Math.round(p.pos.sy)); // patient moved
          } else {
            t.phase = 'stabilize';
            t.timer = Math.max(2, 8 - Math.floor(m.skills.medical / 20));
          }
        }
      } else if (t.phase === 'stabilize') {
        m.activity = 'first-aid';
        if (p.deathTimer >= 0) p.deathTimer = Math.max(p.deathTimer, 2);   // CPR holds the spiral
        if (--t.timer <= 0) {
          if (stabilize(p)) emit('crew-stabilized', { member: p, medic: m });
          if (p.seat?.startsWith('couch')) p.seat = null;
          p.task = { type: 'carried', by: m.id };
          p.path = [];
          const bed = geo.fixtures.medbay?.[0];
          t.phase = 'carry';
          setDestination(state, m, bed.sx, bed.sy);
        }
      } else if (t.phase === 'carry') {
        m.activity = 'carrying';
        const done = walk(m, speed * 0.5);
        p.pos.sx = m.pos.sx; p.pos.sy = m.pos.sy;
        if (done) {
          const bed = geo.fixtures.medbay[0];
          const holder = occ.get(bed.id);
          if (holder == null) {
            p.seat = bed.id; occ.set(bed.id, p.id);
            p.pos.sx = bed.sx; p.pos.sy = bed.sy;
          }
          p.task = { type: 'heal', phase: p.seat ? 'bed' : 'waiting' };
          closeJob(state, job);
          m.task = null;
          m.pause = 1;
          emit('crew-delivered', { member: p, medic: m });
        }
      }
      break;
    }
    case 'repair': {
      m.activity = 'repairing';
      if (t.phase === 'goto') {
        if (walk(m, speed)) t.phase = 'work';
      } else if (++t.timer >= t.duration) {
        const job = state.jobs.list.find(j => j.id === t.jobId);
        const result = ctx.hooks?.repairLS?.(t.deck, m.skills.engineering);
        emit('crew-repair', { member: m, deck: t.deck, result });
        if (job) {
          if (result?.success) closeJob(state, job);
          else { job.status = 'open'; job.assignee = null; }
        }
        m.task = null;
      }
      break;
    }
    case 'reactor': {
      const job = state.jobs.list.find(j => j.id === t.jobId);
      if (!job) { m.task = null; break; }
      if (t.phase === 'goto') {
        m.activity = 'to-reactor';
        if (walk(m, speed)) t.phase = 'work';
      } else {
        m.activity = 'reactor-work';
      }
      break;
    }
    case 'carried':
      m.activity = 'carried';
      break;
    default:
      m.task = null;
  }
}

/** True when the assigned engineer is physically working at the reactor. */
export function engineerAtReactor(state, jobId) {
  return state.ship.crew.some(m => m.task?.type === 'reactor' && m.task.jobId === jobId && m.task.phase === 'work' && isConscious(m));
}

/** Drop the current task cleanly: reopen its job, set down anyone being carried. */
export function abandonTask(state, m) {
  if (m.task?.jobId) {
    const j = state.jobs.list.find(x => x.id === m.task.jobId);
    if (j) { j.status = 'open'; j.assignee = null; }
  }
  if (m.task?.type === 'rescue' && m.task.phase === 'carry') dropPatient(state, m);
  m.task = null;
  m.path = [];
}

/** Player order: send this member to the autodoc. */
export function orderHeal(state, m) {
  if (!isConscious(m)) return false;
  if (m.task?.type === 'heal') return true;
  abandonTask(state, m);
  return startHeal(state, m, occupancy(state));
}

/** Player order: cancel current task (leaves couch/bed). */
export function orderStandDown(state, m) {
  abandonTask(state, m);
  leaveSeat(state, m);
  m.pause = 3;
}

/** Place crew at their home decks at game start. */
export function placeCrew(state) {
  const geo = shipGeometry(state.ship);
  for (const m of state.ship.crew) {
    const nodes = deckNodes(geo, m.homeDeck);
    const n = geo.nodes[nodes[(m.id * 3) % nodes.length]];
    m.pos = { sx: n.sx, sy: n.sy };
    m.$px = n.sx; m.$py = n.sy;
    m.pause = randInt(1, 6) + Math.floor(random() * 3);
  }
}

