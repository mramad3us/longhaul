// ============================================================
// LONGHAUL — Crew behaviour (per game-minute)
//
// Everyone runs one task at a time. Every minute each person checks
// whether something more important has come up; a task is only
// replaced by one of higher priority (lower level):
//
//   0 being carried          5 own injuries → autodoc
//   1 secure for maneuvers   6 exhaustion / hunger that can't wait
//   2 bad air → EVA suit     7 routine jobs (maintenance, machine shop)
//   3 critical jobs          8 the roster: stand watch / sleep
//   4 urgent jobs            9 off watch: meals, the head, recreation
//                           10 idle
//
// Critical jobs (rescues, a dead flight computer, failing life support)
// wake sleepers and pull people off watch; urgent ones are taken by
// anyone awake; routine work belongs to whoever has the engineering or
// machine-shop watch. Movement follows real paths through the ladder
// shaft; the renderer interpolates between minutes using $px/$py.
// ============================================================

import { fightFire, FIRE } from './fire.js';
import { randInt, pick } from '../core/rng.js';
import { shipGeometry, findPath, nearestNode, deckNodes, isSecureSeat, seatKind, airlockFor, walkDistance } from './ship-layout.js';
import { TileType } from './tiles.js';
import { isConscious, isAble, needsMedical, mobility, stabilize, medbayTick, hasCondition } from './crew.js';
import { JobType, JOB_PRIORITY, JOB_SKILL, addJob, closeJob } from './jobs.js';
import { efficiency, pressingNeed, practice, URGENT, MEAL_BREAK, RATION_PER_MEAL } from './needs.js';
import { STATIONS, scheduleBlock, minutesLeftInBlock } from './duty.js';
import { completeSeal } from './life-support.js';
import {
  SYSTEMS, systemPerf, flightComputerState, workMinutes, completeRepair, completeMaintenance,
  completeFabrication, autodocRate, repairMode,
} from './systems.js';

export const WALK_TILES_PER_MIN = 0.8;
const RUN = 2.5;                    // emergencies: sprinting to a downed crewmate, a locker in bad air, a breach or a fire
const CRAWL = 0.15;                 // minimum speed dragging yourself to a seat under G
const MEDBAY_SUPPLY_PER_MIN = 1 / 240;
const MEAL_MINUTES = 20;
const WASH_MINUTES = 12;
const SHOWER_WATER = 12;            // liters through the head per wash
const WAIT_LIMIT = 30;              // give up queueing for the head after this long

// ---- SEATS & FIXTURES ----

const fixtureById = (geo, id) => geo.fixtureById.get(id) || null;

/** Secured = strapped into a couch or station seat, or lying in the autodoc. */
export const isSecured = (m) => isSecureSeat(m.seat);

/** Is this seat occupied — or claimed by someone walking to it — by anyone but `me`? */
function taken(state, id, me = null) {
  for (const o of state.ship.crew) {
    if (o === me) continue;
    if (o.seat === id || (!o.dead && o.task?.seat === id)) return true;
  }
  return false;
}

/** Where to stand to use a fixture (never on the fixture itself, e.g. the autodoc bed). */
function standNode(geo, f) {
  if (f.$stand !== undefined) return f.$stand;
  let node = f.access;
  if (node != null && geo.nodes[node].sx === f.sx && geo.nodes[node].sy === f.sy) {
    node = null;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const n = geo.index.get(geo.key(f.deck, f.x + dx, f.y + dy));
      if (n !== undefined && geo.nodes[n].tile === TileType.FLOOR) { node = n; break; }
    }
  }
  f.$stand = node;
  return node;
}

function nearestFixture(state, m, kind, free = false, prefer = null) {
  const geo = shipGeometry(state.ship);
  const myDeck = geo.deckOfRow(m.pos.sy);
  let best = null, bestD = Infinity;
  for (const f of geo.fixtures[kind] || []) {
    if (free && taken(state, f.id, m)) continue;
    if (prefer && !prefer(f)) continue;
    const d = Math.abs(f.sx - m.pos.sx) + Math.abs(f.sy - m.pos.sy) + (f.deck === myDeck ? 0 : 3);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

// ---- WHO FLIES ----

/** Whoever is sitting at the helm (conscious). */
export function helmsman(state) {
  return state.ship.crew.find(m => isConscious(m) && seatKind(m.seat) === 'helm') || null;
}

/** The ship's pilot: the Pilot, else the best conscious pilot aboard. */
export function activePilot(state) {
  const able = state.ship.crew.filter(m => isConscious(m) && !m.away);
  return able.find(m => m.role === 'Pilot') ||
    able.slice().sort((a, b) => b.skills.piloting - a.skills.piloting)[0] || null;
}

export function crewSecureStatus(state) {
  const able = state.ship.crew.filter(m => isConscious(m) && !m.away);
  const helm = helmsman(state);
  const pilot = helm || activePilot(state);
  // With a working flight computer every couch has helm repeaters; with
  // a dead one somebody has to be at the real controls.
  const fcOK = flightComputerState(state) !== 'failed';
  const pilotReady = !!helm || (fcOK && !!pilot && isSecured(pilot) && !pilot.seat.startsWith('medbay'));
  return {
    total: able.length,
    secured: able.filter(isSecured).length,
    pilot,
    pilotReady,
    unsecured: able.filter(m => !isSecured(m)),
    helpless: state.ship.crew.filter(m => !m.dead && !isConscious(m) && !isSecured(m)),
  };
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
  // final hop onto a non-walkable fixture (couch, bunk) if requested
  const end = path.length ? path[path.length - 1] : { sx: m.pos.sx, sy: m.pos.sy };
  if (Math.abs(end.sx - sx) > 0.01 || Math.abs(end.sy - sy) > 0.01) path.push({ sx, sy });
  m.path = path;
}

function goToNode(state, m, node) {
  const n = shipGeometry(state.ship).nodes[node];
  setDestination(state, m, n.sx, n.sy);
}

/** Walk to a seat's access tile, then step onto the seat. */
function goToSeat(state, m, f) {
  if (f.access == null) { setDestination(state, m, f.sx, f.sy); return; }
  goToNode(state, m, f.access);
  const last = m.path.length ? m.path[m.path.length - 1] : m.pos;
  if (last.sx !== f.sx || last.sy !== f.sy) m.path.push({ sx: f.sx, sy: f.sy });
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
  if (f) {
    const n = standNode(geo, f);
    if (n != null) { m.pos.sx = geo.nodes[n].sx; m.pos.sy = geo.nodes[n].sy; }
  }
}

function sit(m, f) {
  m.seat = f.id;
  m.pos.sx = f.sx; m.pos.sy = f.sy;
  m.path = [];
}

const deckOf = (state, m) => shipGeometry(state.ship).deckOfRow(m.pos.sy);

// ---- TASK PRIORITY ----

const JOB_LEVEL = { [JOB_PRIORITY.CRITICAL]: 3, [JOB_PRIORITY.HIGH]: 4, [JOB_PRIORITY.NORMAL]: 7 };

function taskLevel(t) {
  if (!t) return 99;
  switch (t.type) {
    case 'carried': return 0;
    case 'secure': return 1;
    case 'suit': return 2;
    case 'rescue': case 'helm': case 'board': return 3;
    case 'reactor': case 'work': return JOB_LEVEL[t.priority] ?? 4;
    case 'heal': return 5;
    case 'sleep': return t.exhausted ? 6 : 8;
    case 'eat': return t.urgent ? 6 : 9;
    case 'watch': return 8;
    case 'wash': case 'leisure': return 9;
    default: return 10;
  }
}

/** Drop the current task cleanly: reopen its job, set down anyone being carried. */
export function abandonTask(state, m) {
  if (m.task?.jobId) {
    const j = state.jobs.list.find(x => x.id === m.task.jobId);
    if (j) { j.status = 'open'; j.assignee = null; }
  }
  if (m.task?.type === 'rescue' && m.task.phase === 'carry') dropPatient(state, m);
  if (m.seat && !(m.task?.type === 'heal' && m.seat.startsWith('medbay'))) leaveSeat(state, m);
  m.suit.keep = !!state.suitsOn;              // (under the SUITS order the suit stays on whatever the task)
  m.task = null;
  m.path = [];
}

/**
 * Someone has died (crew.js kill): what they held is let go. A job they had
 * goes back on the board, anyone they were carrying is set down where they
 * fell, and the body is lifted off its seat (an autodoc, the helm, a couch
 * is needed by the living).
 */
function layOut(state, dead) {
  for (const j of state.jobs.list) if (j.status === 'assigned' && j.assignee === dead.id) { j.status = 'open'; j.assignee = null; }
  for (const o of state.ship.crew) {
    if (o.task?.type === 'carried' && o.task.by === dead.id) { o.task = null; o.pos.sx = Math.round(dead.pos.sx); o.pos.sy = Math.round(dead.pos.sy); }
  }
  if (dead.seat) leaveSeat(state, dead);
}

// ---- JOBS ----

function generateJobs(state) {
  const crew = state.ship.crew;
  for (const p of crew) {
    if (p.dead) {
      const j = state.jobs.list.find(x => x.type === JobType.RESCUE && x.data.patient === p.id);
      if (j) closeJob(state, j);
      layOut(state, p);
      continue;
    }
    const helpless = !isConscious(p) || hasCondition(p, 'critical');
    const inCare = p.seat?.startsWith('medbay:') || p.task?.type === 'carried' || p.task?.type === 'heal';
    const has = state.jobs.list.find(j => j.type === JobType.RESCUE && j.data.patient === p.id);
    if (helpless && !inCare && !has) addJob(state, JobType.RESCUE, JOB_PRIORITY.CRITICAL, { patient: p.id });
    if (has && (!helpless || inCare) && has.status === 'open') closeJob(state, has);
  }

  // The flight computer is down and the ship has somewhere to be: someone
  // has to fly by hand. The job ends when the computer is back, when
  // somebody else already has the stick, or when the helm watch arrives
  // to relieve the hand-flier.
  const needHand = flightComputerState(state) === 'failed' && !!state.autopilot;
  const flier = helmsman(state);
  const helmJob = state.jobs.list.find(j => j.type === JobType.HELM);
  if (!needHand) {
    if (helmJob) closeJob(state, helmJob);
  } else if (!helmJob) {
    const j = addJob(state, JobType.HELM, JOB_PRIORITY.CRITICAL, {});
    // Whoever is already at the controls stays there until relieved
    if (flier) {
      j.status = 'assigned'; j.assignee = flier.id;
      flier.task = { type: 'helm', jobId: j.id, phase: 'on', seat: flier.seat };
    }
  } else {
    const holder = crew.find(m => m.task?.jobId === helmJob.id);
    const relief = crew.find(m => m.task?.type === 'watch' && m.task.station === 'helm' && m.task.standby && isConscious(m));
    if (flier && flier !== holder) closeJob(state, helmJob);
    else if (relief && holder && holder === flier) {
      // Change of watch at the helm: the stick is handed over in the same minute
      const f = fixtureById(shipGeometry(state.ship), holder.seat);
      holder.task = null;
      leaveSeat(state, holder);
      sit(relief, f);
      relief.task = { type: 'helm', jobId: helmJob.id, phase: 'on', seat: f.id };
      helmJob.assignee = relief.id;
    }
  }
}

function jobSkill(job) {
  return JOB_SKILL[job.type] || [null, 0];
}

/** Could this person take this job now, given their watch and state? */
function eligible(state, m, job, env) {
  const block = env.blocks.get(m.id);
  const [skill, min] = jobSkill(job);
  if (skill && (m.skills[skill] || 0) < min) return false;
  if (!isAble(m) || m.away) return false;               // (ashore, or across with a boarding party: nobody waits on them)
  if (job.type === JobType.RESCUE && job.data.patient === m.id) return false;
  if (job.data.engineer != null && job.data.engineer !== m.id) return false;
  if ((job.type === JobType.SEAL || job.type === JobType.FIRE) && !m.suit.wearing && !lockerWithSuit(state, m)) return false;
  if (job.type !== JobType.SEAL && job.type !== JobType.FIRE && job.type !== JobType.RESCUE) {
    const f = jobFixture(state, m, job);
    if (f && !reachable(state, m, f.deck)) return false;
  }
  if (job.priority === JOB_PRIORITY.CRITICAL) return true;
  if (m.task?.type === 'sleep' && !m.task.exhausted) return false;
  if (m.task?.type === 'helm') return false;
  if (job.priority === JOB_PRIORITY.HIGH) return true;
  // Routine work: the engineering and machine-shop watches — or, when
  // nobody holds those watches right now, an off-watch volunteer who is
  // rested and fed
  if (block === 'duty') return m.duty.station === 'engineering' || m.duty.station === 'workshop';
  if (block === 'free') {
    return env.routineCover < min && !pressingNeed(m) && m.needs.rest > 40 && state.clock.minute - job.created > 60;
  }
  return false;
}

function score(state, m, job) {
  if (job.type === JobType.RESCUE) {
    const p = state.ship.crew.find(c => c.id === job.data.patient);
    if (!p) return -Infinity;                              // (gone: paid off, or the job outlived them)
    return -(Math.abs(m.pos.sx - p.pos.sx) + Math.abs(m.pos.sy - p.pos.sy));
  }
  const [skill] = jobSkill(job);
  const f = jobFixture(state, m, job);
  const dist = f ? Math.abs(f.sx - m.pos.sx) + Math.abs(f.sy - m.pos.sy) : 0;
  return (skill ? m.skills[skill] : 0) - dist * (job.type === JobType.HELM ? 1.5 : 0.5);
}

/** The best job this person should switch to now (or null). `myLevel` overrides their current task's priority. */
function pickJobFor(state, m, env, myLevel = taskLevel(m.task)) {
  for (const job of state.jobs.list) {
    if (job.status !== 'open') continue;
    if (JOB_LEVEL[job.priority] >= myLevel) break;          // the board is sorted by priority
    if (!eligible(state, m, job, env)) continue;
    // Defer to a better candidate who is free to take it
    const mine = score(state, m, job);
    const better = state.ship.crew.some(o => o !== m && JOB_LEVEL[job.priority] < taskLevel(o.task) &&
      eligible(state, o, job, env) && score(state, o, job) > mine + 0.5);
    if (better) continue;
    return job;
  }
  return null;
}

/** Where a job's work is done. */
function jobFixture(state, m, job) {
  if (job.type === JobType.REPAIR || job.type === JobType.MAINTAIN) return nearestFixture(state, m, SYSTEMS[job.data.system].fixture);
  if (job.type === JobType.FABRICATE) return nearestFixture(state, m, 'workbench');
  if (job.type === JobType.REACTOR) return nearestFixture(state, m, 'reactor');
  if (job.type === JobType.HELM) return nearestFixture(state, m, 'helm');
  if (job.type === JobType.SEAL) return breachSpot(state, job.data.deck);
  if (job.type === JobType.FIRE) return fireSpot(state, job.data.deck);
  return null;
}

/** Where to fight a fire: the open floor in the middle of the deck. */
function fireSpot(state, deck) {
  const geo = shipGeometry(state.ship);
  const nodes = deckNodes(geo, deck).map(i => geo.nodes[i]);
  if (!nodes.length) return null;
  const cx = geo.cols / 2;
  const n = nodes.sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx) || a.y - b.y)[Math.floor(nodes.length / 3)];
  return { sx: n.sx, sy: n.sy, deck, access: geo.index.get(geo.key(n.deck, n.x, n.y)) };
}

/** Where to work on a hull breach: the open floor nearest the deck's outer hull. */
function breachSpot(state, deck) {
  const geo = shipGeometry(state.ship);
  const nodes = deckNodes(geo, deck).map(i => geo.nodes[i]);
  const edge = (n) => Math.min(n.x, geo.cols - 1 - n.x);
  const n = nodes.sort((a, b) => edge(a) - edge(b) || a.y - b.y)[0];
  return n ? { sx: n.sx, sy: n.sy, deck, access: geo.index.get(geo.key(n.deck, n.x, n.y)) } : null;
}

function startJob(state, m, job) {
  const geo = shipGeometry(state.ship);
  abandonTask(state, m);
  job.status = 'assigned';
  job.assignee = m.id;
  if (job.type === JobType.RESCUE) {
    const p = state.ship.crew.find(c => c.id === job.data.patient);
    m.task = { type: 'rescue', jobId: job.id, patient: p.id, phase: 'goto', timer: 0 };
    setDestination(state, m, Math.round(p.pos.sx), Math.round(p.pos.sy));
    return;
  }
  const f = jobFixture(state, m, job);
  if (!f) { job.status = 'open'; job.assignee = null; return; }
  if (job.type === JobType.HELM) {
    m.task = { type: 'helm', jobId: job.id, phase: 'goto', seat: f.id };
    goToSeat(state, m, f);
  } else if ((job.type === JobType.SEAL || job.type === JobType.FIRE) && !m.suit.wearing) {
    // Into vacuum, or smoke: suit up first, then go
    const locker = lockerWithSuit(state, m);
    m.task = { type: 'suit', locker: locker.id, phase: 'goto', timer: 0, thenJob: job.id, priority: job.priority, jobId: job.id, urgent: true };
    goToNode(state, m, locker.access);
  } else if (job.type === JobType.REACTOR) {
    m.task = { type: 'reactor', jobId: job.id, priority: job.priority, phase: 'goto' };
    goToNode(state, m, standNode(geo, f));
  } else {
    m.task = { type: 'work', jobId: job.id, kind: job.type, system: job.data.system ?? null, deck: job.data.deck ?? null, priority: job.priority, phase: 'goto', progress: 0, need: 0 };
    if (job.type === JobType.SEAL || job.type === JobType.FIRE) { m.suit.keep = true; m.task.urgent = true; }
    goToNode(state, m, f.access ?? standNode(geo, f));
  }
}

// ---- SECURING FOR MANEUVERS ----

/** Already where they should be while the ship maneuvers? */
function holdsUnderG(m) {
  const t = m.task;
  if (t?.type === 'secure' || t?.type === 'helm') return true;
  if (t?.type === 'watch' && STATIONS[t.station]?.seat && !t.standby) return true;
  return false;
}

/**
 * At battle stations the best shot takes fire control, the best engineer
 * the engineering station, the next best eye ops. Returns a seat kind or null.
 */
function battleSeat(state, m) {
  if (!state.combatStations) return null;
  const pilot = activePilot(state);
  const able = state.ship.crew.filter(o => isAble(o) && !o.away && o !== pilot);
  const best = (skill, not = []) => able.filter(o => !not.includes(o)).sort((a, b) => b.skills[skill] - a.skills[skill])[0];
  const gunner = best('security');
  if (gunner === m) return 'weapons';
  const eng = best('engineering', [gunner]);
  if (eng === m) return 'engStation';
  return best('security', [gunner, eng]) === m ? 'ops' : null;
}

function assignSecure(state, m, plan = null) {
  const pilot = activePilot(state) === m;
  let seat = null;
  const ok = (f) => reachable(state, m, f.deck);
  if (pilot) seat = nearestFixture(state, m, 'helm', true, ok);
  const station = !pilot && battleSeat(state, m);
  if (station) seat = nearestFixture(state, m, station, true, ok);
  const planned = plan?.get(m.id);
  if (!seat && planned && !taken(state, planned.id, m) && ok(planned)) seat = planned;
  seat ||= nearestFixture(state, m, 'couch', true, ok);
  // No couch free: every station seat is an acceleration couch too (a full
  // crew fills the couches, and nobody may be standing at ops or fire control)
  for (const kind of ['ops', 'weapons', 'engStation', 'helm']) seat ||= nearestFixture(state, m, kind, true, ok);
  if (!seat) return false;
  abandonTask(state, m);
  m.task = { type: 'secure', seat: seat.id };
  goToSeat(state, m, seat);
  return true;
}

/**
 * Who takes which couch, for everyone still on their feet, by the real
 * walk: the assignment whose longest walk is shortest (the ship is secure
 * when the last one sits). Nearest-couch-first would send whoever moves
 * last the length of the ship. The plan only decides a first pick: someone
 * already walking keeps going (changing course every minute, nobody sits).
 * A dozen people and couches at most, so a search over the walk lengths
 * with a matching at each is cheap.
 */
function planCouches(state) {
  const geo = shipGeometry(state.ship);
  // The pilot takes the helm, if it is free for them (someone else may hold it)
  let pilot = activePilot(state);
  if (pilot && !nearestFixture(state, pilot, 'helm', true)) pilot = null;
  // (asleep in a rack counts: a rack is a restraint, not a couch)
  const crew = state.ship.crew.filter(m => isAble(m) && !m.away && m !== pilot && !isSecured(m) && m.task?.type !== 'secure' && !battleSeat(state, m) && m.task?.type !== 'helm');
  if (!crew.length) return null;
  const mine = new Set(crew.map(m => m.id));
  const claimed = new Set();
  for (const o of state.ship.crew) {
    if (mine.has(o.id)) continue;
    if (o.seat) claimed.add(o.seat);
    else if (!o.dead && o.task?.seat) claimed.add(o.task.seat);
  }
  const free = (geo.fixtures.couch || []).filter(f => !claimed.has(f.id) && f.access != null);
  if (!free.length) return null;
  const dist = crew.map(m => { const from = nearestNode(geo, m.pos.sx, m.pos.sy); return free.map(f => walkDistance(geo, from, f.access)); });
  const lengths = [...new Set(dist.flat().filter(isFinite))].sort((a, b) => a - b);
  const want = Math.min(crew.length, free.length);
  const match = (limit) => {
    const owner = new Array(free.length).fill(-1);
    const tryCrew = (i, seen) => {
      for (let j = 0; j < free.length; j++) {
        if (dist[i][j] > limit || seen[j]) continue;
        seen[j] = true;
        if (owner[j] < 0 || tryCrew(owner[j], seen)) { owner[j] = i; return true; }
      }
      return false;
    };
    let n = 0;
    for (let i = 0; i < crew.length; i++) if (tryCrew(i, [])) n++;
    return n >= want ? owner : null;
  };
  // the shortest longest-walk that still seats as many as can be seated
  let lo = 0, hi = lengths.length - 1, best = hi >= 0 ? match(lengths[hi]) : null;
  if (!best) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = match(lengths[mid]);
    if (m) { best = m; hi = mid; } else lo = mid + 1;
  }
  const plan = new Map();
  best.forEach((i, j) => { if (i >= 0) plan.set(crew[i].id, free[j]); });
  return plan;
}

// ---- BAD AIR ----

function deckAirIsBad(state, deck) {
  const atmo = state.ship.decks[deck]?.atmosphere;
  if (!atmo) return false;
  // (a fire is bad air too: smoke, and it burns whoever is in it unsuited)
  return atmo.breached || atmo.vented || !!atmo.fire || atmo.pressure < 63 || atmo.o2Pct < 16 || atmo.co2Pct > 3;
}

/** Can they get to this deck without walking through bad air unsuited? */
function reachable(state, m, deck) {
  if (m.suit.wearing) return true;
  const here = deckOf(state, m);
  const lo = Math.min(here, deck), hi = Math.max(here, deck);
  for (let d = lo; d <= hi; d++) if (d !== here && deckAirIsBad(state, d)) return false;
  return true;
}

function lockerWithSuit(state, m) {
  const geo = shipGeometry(state.ship);
  const deck = geo.deckOfRow(m.pos.sy);
  // (a suit someone else is already on the way to is theirs: two boarders on one deck don't race for one locker)
  const claimed = new Set();
  for (const x of state.ship.crew) if (x !== m && x.task?.locker && (x.task.type === 'suit' || (x.task.type === 'board' && x.task.phase === 'suit'))) claimed.add(x.task.locker);
  let best = null, bestD = Infinity;
  for (const f of geo.fixtures.locker || []) {
    if (!state.lifeSupport.lockers[f.id]?.hasSuit || claimed.has(f.id)) continue;
    const d = Math.abs(f.sx - m.pos.sx) + Math.abs(f.sy - m.pos.sy) + (f.deck === deck ? 0 : 6);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

// ---- ROUTINE: WATCH, SLEEP, MEALS, HEAD, RECREATION ----

function startWatch(state, m) {
  const st = STATIONS[m.duty.station];
  if (!st) return false;
  const geo = shipGeometry(state.ship);
  const f = nearestFixture(state, m, st.fixture);
  if (!f || !reachable(state, m, f.deck)) return false;
  abandonTask(state, m);
  if (st.seat) {
    m.task = { type: 'watch', station: m.duty.station, phase: 'goto', seat: f.id };
    goToSeat(state, m, f);
  } else {
    m.task = { type: 'watch', station: m.duty.station, phase: 'goto', fixture: f.id };
    goToNode(state, m, standNode(geo, f));
  }
  return true;
}

function startSleep(state, m, exhausted = false) {
  const ok = (f) => reachable(state, m, f.deck);
  const bed = nearestFixture(state, m, 'bunk', true, ok) || nearestFixture(state, m, 'couch', true, ok);
  abandonTask(state, m);
  m.task = { type: 'sleep', phase: 'goto', exhausted, seat: bed?.id || null };
  if (bed) goToSeat(state, m, bed);
  return true;
}

function startEat(state, m, urgent = false) {
  const geo = shipGeometry(state.ship);
  const galley = nearestFixture(state, m, 'galley');
  if (!galley || !reachable(state, m, galley.deck)) return false;
  abandonTask(state, m);
  m.task = { type: 'eat', phase: 'galley', urgent, timer: 0 };
  goToNode(state, m, standNode(geo, galley));
  return true;
}

function startWash(state, m) {
  const geo = shipGeometry(state.ship);
  const head = nearestFixture(state, m, 'head');
  if (!head || !reachable(state, m, head.deck)) return false;
  abandonTask(state, m);
  m.task = { type: 'wash', phase: 'goto', head: head.id, timer: 0, waited: 0 };
  goToNode(state, m, standNode(geo, head));
  return true;
}

function startLeisure(state, m) {
  const geo = shipGeometry(state.ship);
  const ok = (f) => reachable(state, m, f.deck);
  const rec = nearestFixture(state, m, 'rec', true, ok);
  // The rig if it's free and they're not already sociable; otherwise the mess table
  const table = nearestFixture(state, m, 'table', false, ok);
  const useRec = rec && (m.id + Math.floor(state.clock.minute / 97)) % 2 === 0;
  abandonTask(state, m);
  if (useRec) {
    m.task = { type: 'leisure', where: 'rec', phase: 'goto', seat: rec.id, timer: randInt(35, 55) };
    goToSeat(state, m, rec);
  } else if (table) {
    m.task = { type: 'leisure', where: 'table', phase: 'goto', fixture: table.id, timer: randInt(30, 50) };
    goToNode(state, m, standNode(geo, table));
  } else return false;
  return true;
}

function startPatrol(state, m) {
  const geo = shipGeometry(state.ship);
  const nodes = deckNodes(geo, reachable(state, m, m.homeDeck) ? m.homeDeck : deckOf(state, m));
  const n = geo.nodes[pick(nodes)];
  if (!n) return;
  m.task = { type: 'patrol' };
  setDestination(state, m, n.sx, n.sy);
}

/**
 * Join a boarding party: a suit from the nearest locker nobody else is
 * going to, if the crossing is through open space (or the other side may
 * fight), then to the lock. The task ends when the party goes, with them
 * or without them.
 */
function startBoard(state, m, bd) {
  abandonTask(state, m);
  const lock = airlockFor(state.ship, bd.via === 'dock' ? state.dock?.port : null);
  const suitUp = !m.suit.wearing && (bd.via === 'eva' || bd.defenders > 0 || state.suitsOn);
  const locker = suitUp ? lockerWithSuit(state, m) : null;
  m.task = { type: 'board', phase: locker ? 'suit' : 'goto', locker: locker?.id ?? null, lock: lock?.id ?? null, timer: 0 };
  if (locker) goToNode(state, m, locker.access);
  else if (lock) goToNode(state, m, lock.access ?? standNode(shipGeometry(state.ship), lock));
}

function startHeal(state, m) {
  const bed = (shipGeometry(state.ship).fixtures.medbay || [])[0];
  if (!bed) return false;
  abandonTask(state, m);
  m.task = { type: 'heal', phase: 'goto' };
  setDestination(state, m, bed.sx, bed.sy);
  return true;
}

// ---- MAIN TICK ----

/**
 * One game-minute of crew behaviour.
 * ctx: { gForce, policy: 'secure'|'free', emit, hooks: { useWater(liters) } }
 */
export function crewTick(state, ctx) {
  const crew = state.ship.crew;
  const geo = shipGeometry(state.ship);
  const g = ctx.gForce;
  const emit = ctx.emit || (() => {});
  const secure = ctx.policy === 'secure';
  const blocks = new Map(crew.map(m => [m.id, scheduleBlock(state, m)]));
  // Best engineering skill on a routine-work watch right now (off-watch
  // volunteers only step in when nobody covers routine work)
  let routineCover = -1;
  for (const o of crew) {
    if (isConscious(o) && (o.duty.station === 'engineering' || o.duty.station === 'workshop') && blocks.get(o.id) === 'duty') routineCover = Math.max(routineCover, o.skills.engineering);
  }

  for (const m of crew) { m.$px = m.pos.sx; m.$py = m.pos.sy; }

  generateJobs(state);
  const plan = secure && crew.some(m => isAble(m) && !m.away && !isSecured(m) && m.task?.type !== 'secure') ? planCouches(state) : null;

  for (const m of crew) {
    if (m.away) { m.activity = m.away.captured ? 'captured' : 'away'; continue; }   // aboard another hull (boarding.js)
    if (m.dead) { if (m.task?.type !== 'carried') m.path = []; continue; }

    // ---- Incapacitated: drop what you were doing (couch/bed keep holding you)
    if (!isConscious(m)) {
      if (m.task && m.task.type !== 'carried' && m.task.type !== 'heal') abandonTask(state, m);
      m.path = [];
      if (m.task?.type === 'heal' && !m.seat) {
        // waiting beside the autodoc: the autodoc arm takes the next patient in
        const bed = geo.fixtures.medbay?.[0];
        if (bed && !taken(state, bed.id, m)) sit(m, bed);
      }
      if (m.task?.type === 'heal' && m.seat) healStep(state, m, ctx);
      m.activity = m.seat ? (m.seat.startsWith('medbay') ? 'healing' : 'secured') : 'down';
      continue;
    }
    decide(state, m, { secure, blocks, routineCover, g, plan });
    stepTask(state, m, ctx, g, emit, blocks.get(m.id));
  }

  state.$watch = watchState(state);
}

function decide(state, m, env) {
  const { secure, blocks } = env;
  const block = blocks.get(m.id);
  const res = state.resources;
  const lvl = () => taskLevel(m.task);

  // A seat with no task behind it (job closed under them) is vacated
  if (m.seat && !m.task) leaveSeat(state, m);

  // ---- Bad air comes first, even mid-maneuver (crawling to the locker under G if need be)
  // (a boarder suits up in the boarding's own order: taken off it here, the muster would take them back, and round)
  if (!m.suit.wearing && m.task?.type !== 'suit' && m.task?.type !== 'board' && m.task?.type !== 'carried' && !(m.task?.type === 'rescue' && m.task.phase === 'carry') &&
      !(m.task?.type === 'heal' && m.seat) && !(isSecured(m) && (m.couchAir ?? 0) > 30 && secure) && deckAirIsBad(state, deckOf(state, m))) {
    const locker = lockerWithSuit(state, m);
    if (locker) {
      abandonTask(state, m);
      m.task = { type: 'suit', locker: locker.id, phase: 'goto', timer: 0, urgent: true };
      goToNode(state, m, locker.access);
      return;
    }
  }

  // ---- The SUITS order: everyone into a suit while it stands (moving about
  // under 1.5G, a crash couch left for it if need be), and kept on (orderSuits)
  // (not off the stick of a hand-flown ship, nor out of a boarding party, which suits up on its own)
  if (state.suitsOn && !m.suit.wearing && !m.away && isAble(m) && env.g <= 1.5 && !['suit', 'carried', 'heal', 'rescue', 'board', 'helm'].includes(m.task?.type)) {
    const locker = lockerWithSuit(state, m);
    if (locker) {
      abandonTask(state, m);
      m.task = { type: 'suit', locker: locker.id, phase: 'goto', timer: 0, keep: true };
      goToNode(state, m, locker.access);
      return;
    }
  }

  // ---- A boarding party musters at the lock (boarding.js), maneuvers or not
  const bd = state.boarding;
  if (bd?.phase === 'muster' && bd.party.includes(m.id) && isAble(m) && !m.away) {
    // (someone already getting into a suit finishes first: pulled off it, they would start over)
    if (m.task?.type !== 'board' && m.task?.type !== 'suit') startBoard(state, m, bd);
    return;
  }

  // ---- 1. Secure for maneuvers
  if (secure) {
    // A dead flight computer mid-maneuver: the best available pilot takes the helm
    const helmJob = state.jobs.list.find(j => j.type === JobType.HELM && j.status === 'open');
    if (helmJob && m.task?.type !== 'helm' && bestPilotFor(state, helmJob, env) === m) { startJob(state, m, helmJob); return; }
    // Watch over while strapped in at a station: stay in the seat, off duty (and asleep, if it's time)
    if (m.task?.type === 'watch' && block !== 'duty' && m.seat && isSecured(m)) { m.task = { type: 'secure', seat: m.seat }; return; }
    // Battle stations called while already strapped in: move to your station while you still can
    if (m.task?.type === 'secure' && env.g <= 1.5 && isAble(m)) {
      const want = battleSeat(state, m);
      if (want && seatKind(m.task.seat) !== want && nearestFixture(state, m, want, true)) { assignSecure(state, m); return; }
    }
    if (holdsUnderG(m) || (m.task?.type === 'heal' && m.seat) || (m.task?.type === 'rescue' && m.task.phase === 'carry')) return;
    // Below 1.5G people can still move: rescues and damage control go on until the ship pulls hard
    if (env.g <= 1.5 && isAble(m)) {
      if (lvl() <= 3 && m.task?.type !== 'secure') return;            // already on a critical job
      const job = pickJobFor(state, m, env, JOB_LEVEL[JOB_PRIORITY.CRITICAL] + 1);
      if (job && job.type !== JobType.HELM) { startJob(state, m, job); return; }
    }
    if (m.task?.type === 'secure') return;
    assignSecure(state, m, env.plan);
    return;
  }
  if (m.task?.type === 'secure') { leaveSeat(state, m); m.task = null; m.pause = randInt(1, 4); }

  // ---- 3/4/7. Jobs from the board
  if (lvl() > 3) {
    const job = pickJobFor(state, m, env);
    if (job) startJob(state, m, job);
  }

  // ---- 5. Own injuries
  if (lvl() > 5 && needsMedical(m) && !hasCondition(m, 'critical')) startHeal(state, m);

  // ---- 6. Needs that can't wait
  if (lvl() > 6 && m.needs.rest < URGENT.rest) startSleep(state, m, true);
  if (lvl() > 6 && m.needs.food < URGENT.food && res.food.current >= RATION_PER_MEAL) startEat(state, m, true);

  // ---- 8/9. The roster
  if (lvl() < 8) return;
  const t = m.task;
  if (block === 'duty') {
    // A meal break mid-watch (the station stands empty for half an hour)
    if (t?.type === 'watch' && m.needs.food < MEAL_BREAK && res.food.current >= RATION_PER_MEAL) { startEat(state, m); return; }
    if (!(t?.type === 'watch' && t.station === m.duty.station)) {
      if (t?.type === 'eat' || t?.type === 'wash') return;       // finish the meal / shower, then report
      if (!startWatch(state, m) && (!t || t.type === 'sleep')) startPatrol(state, m);
    }
    return;
  }
  if (block === 'sleep') {
    if (t?.type !== 'sleep') {
      if (t?.type === 'eat' || t?.type === 'wash') return;
      startSleep(state, m);
    }
    return;
  }
  // Off watch
  if (t?.type === 'watch' || (t?.type === 'sleep' && !t.exhausted)) abandonTask(state, m);
  if (m.task && m.task.type !== 'patrol') return;
  const need = pressingNeed(m);
  // Supper before turning in, so nobody wakes up starving
  const supper = blocks.get(m.id) === 'free' && minutesLeftInBlock(state, m) < 120 && m.needs.food < 70;
  if ((need === 'food' || supper) && res.food.current >= RATION_PER_MEAL) { startEat(state, m); return; }
  if (need === 'hygiene' && startWash(state, m)) return;
  if (need === 'fun') { if (startLeisure(state, m)) return; }
  if (!m.task) {
    if (m.pause > 0) { m.pause--; return; }
    startPatrol(state, m);
  }
}

function bestPilotFor(state, job, env) {
  let best = null, bestScore = -Infinity;
  for (const o of state.ship.crew) {
    if (!isAble(o) || !eligible(state, o, job, env)) continue;
    const sc = score(state, o, job);
    if (sc > bestScore) { bestScore = sc; best = o; }
  }
  return best;
}

// ---- TASK EXECUTION ----

function speedOf(m, g) {
  return WALK_TILES_PER_MIN * mobility(m, g);
}

function stepTask(state, m, ctx, g, emit, block) {
  const t = m.task;
  // (bad air, a breach, a fire: they run)
  const speed = speedOf(m, g) * (t?.urgent ? RUN : 1);
  const G = shipGeometry(state.ship);

  if (!t) { m.activity = m.seat ? 'secured' : 'idle'; return; }

  switch (t.type) {
    case 'board': {
      // (a muster that went without them, or was called off, or never was: back to the ship's work)
      const bd = state.boarding;
      if (bd?.phase !== 'muster' || !bd.party.includes(m.id)) { m.task = null; m.path = []; break; }
      m.activity = t.phase === 'ready' ? 'at the lock' : t.phase === 'suit' ? 'suiting up' : 'to the lock';
      if (t.phase === 'ready' || t.phase === 'nosuit') break;
      if (!walk(m, speed)) break;
      if (t.phase === 'suit') {
        if (++t.timer < 3) break;
        const locker = state.lifeSupport.lockers[t.locker];
        if (locker?.hasSuit && !m.suit.wearing) { locker.hasSuit = false; m.suit = { wearing: true, o2: 48, lockerId: t.locker, keep: true }; emit('crew-suited', { member: m }); }
        if (!m.suit.wearing) {
          // its suit gone before they got there: the next locker with one; none left, an EVA goes without them (boarding.js says so)
          const next = lockerWithSuit(state, m);
          if (next) { t.locker = next.id; t.timer = 0; goToNode(state, m, next.access); break; }
          if (bd.via === 'eva') { t.phase = 'nosuit'; break; }
        }
        t.phase = 'goto';
        const lock = t.lock ? G.fixtureById.get(t.lock) : null;
        if (lock) goToNode(state, m, lock.access ?? standNode(G, lock));
        break;
      }
      t.phase = 'ready';
      break;
    }
    case 'patrol': {
      m.activity = 'idle';
      if (walk(m, speed)) { m.task = null; m.pause = randInt(3, 12); }
      break;
    }
    case 'secure': {
      if (m.seat === t.seat) { m.activity = block === 'sleep' ? 'sleeping-couch' : 'secured'; break; }
      m.activity = 'securing';
      if (walk(m, Math.max(speed, CRAWL))) {
        const holder = state.ship.crew.find(c => c.id !== m.id && c.seat === t.seat);
        if (holder) { m.task = null; assignSecure(state, m); }
        else { sit(m, fixtureById(G, t.seat)); m.activity = 'secured'; }
      }
      break;
    }
    case 'suit': {
      m.activity = 'suiting';
      if (t.phase === 'goto') {
        if (walk(m, Math.max(speed, CRAWL))) t.phase = 'don';
      } else if (++t.timer >= 3) {
        const locker = state.lifeSupport.lockers[t.locker];
        if (locker?.hasSuit) {
          locker.hasSuit = false;
          m.suit = { wearing: true, o2: 48, lockerId: t.locker, keep: !!(t.keep || state.suitsOn) };
          emit('crew-suited', { member: m });
        }
        const next = t.thenJob != null && state.jobs.list.find(j => j.id === t.thenJob);
        m.task = null;
        if (next && m.suit.wearing) { next.status = 'open'; startJob(state, m, next); }
      }
      break;
    }
    case 'heal': {
      const bed = G.fixtures.medbay?.[0];
      if (m.seat) { m.activity = 'healing'; healStep(state, m, ctx); break; }
      m.activity = 'to-medbay';
      if (walk(m, speed) || !m.path.length) {
        const holder = state.ship.crew.find(c => c.id !== m.id && c.seat === bed.id);
        if (!holder) { sit(m, bed); m.activity = 'healing'; }
        else m.activity = 'waiting';      // queue beside the autodoc
      }
      break;
    }
    case 'rescue': stepRescue(state, m, t, speed, emit); break;
    case 'work': stepWork(state, m, t, speed, emit); break;
    case 'reactor': {
      const job = state.jobs.list.find(j => j.id === t.jobId);
      if (!job) { m.task = null; break; }
      if (t.phase === 'goto') {
        m.activity = 'to-reactor';
        if (walk(m, speed)) t.phase = 'work';
      } else {
        m.activity = 'reactor-work';
        practice(m, 'engineering');
      }
      break;
    }
    case 'helm': {
      const job = state.jobs.list.find(j => j.id === t.jobId);
      if (!job) { abandonTask(state, m); break; }
      if (m.seat === t.seat) {
        m.activity = 'flying';
        if (state.autopilot?.phase === 'active') practice(m, 'piloting', 2);
        break;
      }
      m.activity = 'to-helm';
      if (walk(m, Math.max(speed, CRAWL) * RUN)) {
        const holder = state.ship.crew.find(c => c.id !== m.id && c.seat === t.seat);
        if (holder) { /* someone already flying: wait beside them */ m.activity = 'waiting'; }
        else sit(m, fixtureById(G, t.seat));
      }
      break;
    }
    case 'watch': stepWatch(state, m, t, speed); break;
    case 'sleep': {
      if (t.phase === 'asleep') {
        m.activity = seatKind(m.seat) === 'bunk' ? 'sleeping' : 'sleeping-couch';
        const awake = t.exhausted ? m.needs.rest >= 60 : block !== 'sleep' && (m.needs.rest >= 50 || block === 'duty');
        if (awake) { abandonTask(state, m); m.pause = 1; }
        break;
      }
      m.activity = 'to-bed';
      if (walk(m, Math.max(speed, CRAWL))) {
        const f = t.seat && fixtureById(G, t.seat);
        const holder = f && state.ship.crew.find(c => c.id !== m.id && c.seat === f.id);
        if (f && !holder) sit(m, f);
        t.phase = 'asleep';
      }
      break;
    }
    case 'eat': stepEat(state, m, t, speed, emit); break;
    case 'wash': {
      const head = fixtureById(G, t.head);
      if (t.phase === 'goto') {
        m.activity = 'to-head';
        if (walk(m, speed)) t.phase = 'queue';
      } else if (t.phase === 'queue') {
        const holder = state.ship.crew.find(c => c.id !== m.id && c.seat === head.id);
        if (holder) {
          m.activity = 'waiting';
          if (++t.waited > WAIT_LIMIT) { m.task = null; m.pause = randInt(20, 40); }
        } else { sit(m, head); t.phase = 'use'; t.timer = WASH_MINUTES; t.seat = head.id; }
      } else {
        m.activity = 'washing';
        if (--t.timer <= 0) {
          ctx.hooks?.useWater?.(SHOWER_WATER);
          m.needs.hygiene = 100;
          leaveSeat(state, m);
          m.task = null;
          m.pause = 1;
        }
      }
      break;
    }
    case 'leisure': {
      if (t.phase === 'goto') {
        m.activity = t.where === 'rec' ? 'to-rec' : 'to-mess';
        if (walk(m, speed)) {
          if (t.where === 'rec') {
            const f = fixtureById(G, t.seat);
            if (state.ship.crew.some(c => c.id !== m.id && c.seat === f.id)) { m.task = null; break; }
            sit(m, f);
          } else {
            m.pos.sx += ((m.id % 3) - 1) * 0.3;    // room around the table
          }
          t.phase = 'on';
        }
        break;
      }
      m.activity = t.where === 'rec' ? 'exercising' : 'socializing';
      const company = t.where === 'table' ? companyAtTables(state, m) : 0;
      m.needs.fun = Math.min(100, m.needs.fun + (t.where === 'rec' ? 1.5 : 0.6 + 0.3 * company));
      if (--t.timer <= 0 || m.needs.fun >= 98) { if (m.seat) leaveSeat(state, m); m.task = null; m.pause = randInt(2, 8); }
      break;
    }
    case 'carried':
      m.activity = 'carried';
      break;
    default:
      m.task = null;
  }
}

function companyAtTables(state, m) {
  const deck = deckOf(state, m);
  return state.ship.crew.filter(o => o !== m && !o.dead && deckOf(state, o) === deck &&
    ((o.task?.type === 'leisure' && o.task.where === 'table') || (o.task?.type === 'eat' && o.task.phase === 'eating'))).length;
}

function stepWatch(state, m, t, speed) {
  const G = shipGeometry(state.ship);
  if (t.phase === 'on') {
    m.activity = `watch-${t.station}`;
    practice(m, STATIONS[t.station].skill, 0.3);
    return;
  }
  m.activity = 'to-station';
  if (!walk(m, Math.max(speed, t.seat ? CRAWL : 0))) return;
  if (t.seat) {
    const holder = state.ship.crew.find(c => c.id !== m.id && c.seat === t.seat);
    if (holder) {
      // Station taken (someone flying by hand, or another watch): stand by
      const f = fixtureById(G, t.seat);
      const n = standNode(G, f);
      if (n != null) { m.pos.sx = G.nodes[n].sx; m.pos.sy = G.nodes[n].sy; }
      m.activity = 'standing-by';
      t.standby = true;
      return;
    }
    sit(m, fixtureById(G, t.seat));
    t.standby = false;
  }
  t.phase = 'on';
}

function mealService(state) {
  const perf = systemPerf(state, 'galley');
  if (perf === 0) return { prep: 2, fun: -5, mood: -3, kind: 'cold rations' };
  const cookId = state.$watch?.galley;
  if (cookId != null) {
    const cook = state.ship.crew.find(c => c.id === cookId);
    const bonus = cook?.role === 'Cook' ? 8 : 0;
    return { prep: perf >= 1 ? 3 : 8, fun: (perf >= 1 ? 18 : 8) + bonus, mood: perf >= 1 ? 1.5 + bonus / 8 : 0.5, kind: 'hot meal' };
  }
  return { prep: perf >= 1 ? 10 : 18, fun: perf >= 1 ? 6 : 0, mood: perf >= 1 ? 0 : -1, kind: 'self-serve' };
}

function stepEat(state, m, t, speed, emit) {
  const G = shipGeometry(state.ship);
  const res = state.resources;
  switch (t.phase) {
    case 'galley':
      m.activity = 'to-galley';
      if (walk(m, speed)) {
        if (res.food.current < RATION_PER_MEAL) {
          emit('crew-no-food', { member: m });
          m.task = null; m.pause = 60;
          return;
        }
        t.service = mealService(state);
        t.timer = t.service.prep;
        t.phase = 'prep';
      }
      return;
    case 'prep':
      m.activity = t.service.kind === 'cold rations' ? 'cold-rations' : 'cooking';
      if (--t.timer <= 0) {
        const table = nearestFixture(state, m, 'table');
        t.phase = 'table';
        if (table) goToNode(state, m, standNode(G, table));
      }
      return;
    case 'table':
      m.activity = 'to-mess';
      if (walk(m, speed)) {
        m.pos.sx += ((m.id % 3) - 1) * 0.3;
        t.phase = 'eating'; t.timer = MEAL_MINUTES;
        res.food.current = Math.max(0, res.food.current - RATION_PER_MEAL);
      }
      return;
    case 'eating':
      m.activity = 'eating';
      m.needs.food = Math.min(100, m.needs.food + 100 / MEAL_MINUTES);
      m.needs.fun = Math.min(100, m.needs.fun + 0.15 * companyAtTables(state, m));
      if (--t.timer <= 0) {
        m.needs.food = 100;
        m.needs.fun = Math.max(0, Math.min(100, m.needs.fun + t.service.fun));
        m.moraleMod = (m.moraleMod || 0) + t.service.mood;     // good food lifts a ship; cold rations grind it down
        m.task = null; m.pause = randInt(1, 5);
      }
  }
}

function stepWork(state, m, t, speed, emit) {
  const job = state.jobs.list.find(j => j.id === t.jobId);
  if (!job) { m.task = null; return; }
  const label = t.kind === JobType.MAINTAIN ? 'maintaining' : t.kind === JobType.FABRICATE ? 'fabricating' : t.kind === JobType.SEAL ? 'sealing' : t.kind === JobType.FIRE ? 'firefighting' : 'repairing';
  if (t.phase === 'goto') {
    m.activity = `to-${label}`;
    if (walk(m, speed)) {
      t.phase = 'work';
      t.progress = 0;
      // (a fire has no set time: it is fought until it is out)
      t.need = t.kind === JobType.FIRE ? Infinity : t.kind === JobType.SEAL ? Math.round(40 * Math.max(0.6, 1.6 - m.skills.engineering / 100))
        : workMinutes(state, t.kind, t.system, m.skills.engineering, 1);
      t.mode = t.kind === JobType.REPAIR ? repairMode(state, t.system) : t.kind;
    }
    return;
  }
  m.activity = t.kind === JobType.REPAIR && t.mode === 'jury' ? 'jury-rigging' : label;
  if (t.kind === JobType.FIRE) {
    // an extinguisher on it each minute, until it is out (fire.js)
    if (fightFire(state, t.deck, FIRE.FIGHT * efficiency(m), emit)) { closeJob(state, job); m.suit.keep = !!state.suitsOn; m.task = null; m.pause = 2; }
    return;
  }
  t.progress += efficiency(m);
  practice(m, 'engineering');
  if (t.progress < t.need) return;

  let result;
  if (t.kind === JobType.REPAIR) result = completeRepair(state, t.system, m.skills.engineering);
  else if (t.kind === JobType.MAINTAIN) result = completeMaintenance(state, t.system);
  else if (t.kind === JobType.SEAL) { result = completeSeal(state, t.deck); m.suit.keep = !!state.suitsOn; }
  else result = completeFabrication(state);
  emit('crew-work-done', { member: m, kind: t.kind, system: t.system, result });
  if (result.success) closeJob(state, job);
  else { job.status = 'open'; job.assignee = null; }
  m.task = null;
  m.pause = 2;
}

function stepRescue(state, m, t, speed, emit) {
  const G = shipGeometry(state.ship);
  const p = state.ship.crew.find(c => c.id === t.patient);
  const job = state.jobs.list.find(j => j.id === t.jobId);
  if (!p || p.dead || !job) { if (t.phase === 'carry') dropPatient(state, m); m.task = null; return; }
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
      if (p.seat) p.seat = null;
      p.task = { type: 'carried', by: m.id };
      p.path = [];
      const bed = G.fixtures.medbay?.[0];
      t.phase = 'carry';
      setDestination(state, m, bed.sx, bed.sy);
    }
  } else if (t.phase === 'carry') {
    m.activity = 'carrying';
    const done = walk(m, speed * 0.5);
    p.pos.sx = m.pos.sx; p.pos.sy = m.pos.sy;
    if (done) {
      const bed = G.fixtures.medbay[0];
      const holder = state.ship.crew.find(c => c.id !== p.id && c.seat === bed.id);
      if (!holder) sit(p, bed);
      p.task = { type: 'heal', phase: p.seat ? 'bed' : 'waiting' };
      closeJob(state, job);
      m.task = null;
      // step off the bed
      const n = standNode(G, bed);
      if (n != null) { m.pos.sx = G.nodes[n].sx; m.pos.sy = G.nodes[n].sy; }
      m.pause = 1;
      emit('crew-delivered', { member: p, medic: m });
    }
  }
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
  const medic = state.$watch?.medbay != null ? 1.5 : 1;
  const healed = medbayTick(m, supplied, autodocRate(state) * medic);
  if (healed && isConscious(m)) {
    leaveSeat(state, m);
    m.task = null;
    m.pause = 2;
    ctx.emit?.('crew-healed', { member: m });
  }
}

/** Who is actually manning each station this minute (station → crew id). */
function watchState(state) {
  const w = { helm: null, ops: null, weapons: null, engineering: null, workshop: null, medbay: null, galley: null };
  for (const m of state.ship.crew) {
    if (!isConscious(m)) continue;
    if (seatKind(m.seat) === 'helm') w.helm = m.id;
    if (seatKind(m.seat) === 'weapons') w.weapons = m.id;
    if (seatKind(m.seat) === 'ops' && m.task?.type === 'secure') w.ops ??= m.id;
    if (m.task?.type === 'watch' && m.task.phase === 'on') w[m.task.station] ??= m.id;
  }
  return w;
}

/** True when the assigned engineer is physically working at the reactor. */
export function engineerAtReactor(state, jobId) {
  return state.ship.crew.some(m => m.task?.type === 'reactor' && m.task.jobId === jobId && m.task.phase === 'work' && isConscious(m));
}

// ---- PLAYER ORDERS ----

/** Send this member to the autodoc. */
export function orderHeal(state, m) {
  if (!isConscious(m)) return false;
  if (m.task?.type === 'heal') return true;
  return startHeal(state, m);
}

/** Cancel current task (leaves couch/bed). */
export function orderStandDown(state, m) {
  abandonTask(state, m);
  leaveSeat(state, m);
  m.pause = 3;
}

/** Place crew for the start of a game: on watch, in their bunks, or about the ship. */
export function placeCrew(state) {
  const G = shipGeometry(state.ship);
  const occ = new Map();
  for (const m of state.ship.crew) {
    const block = scheduleBlock(state, m);
    m.needs.rest = block === 'sleep' ? 45 : block === 'duty' ? 85 : 60;
    const nodes = deckNodes(G, m.homeDeck);
    const n = G.nodes[nodes[(m.id * 3) % nodes.length]];
    m.pos = { sx: n.sx, sy: n.sy };
    m.pause = randInt(1, 6);
    if (block === 'sleep') {
      const bunk = (G.fixtures.bunk || []).find(f => !occ.has(f.id));
      if (bunk) { occ.set(bunk.id, m.id); sit(m, bunk); m.task = { type: 'sleep', phase: 'asleep', exhausted: false, seat: bunk.id }; }
    } else if (block === 'duty' && STATIONS[m.duty.station]) {
      const st = STATIONS[m.duty.station];
      const f = (G.fixtures[st.fixture] || []).find(x => !occ.has(x.id));
      if (f) {
        occ.set(f.id, m.id);
        if (st.seat) { sit(m, f); m.task = { type: 'watch', station: m.duty.station, phase: 'on', seat: f.id }; }
        else {
          const s = standNode(G, f);
          if (s != null) { m.pos = { sx: G.nodes[s].sx, sy: G.nodes[s].sy }; m.task = { type: 'watch', station: m.duty.station, phase: 'on', fixture: f.id }; }
        }
      }
    }
    m.$px = m.pos.sx; m.$py = m.pos.sy;
  }
}
