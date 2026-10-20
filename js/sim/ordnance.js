// ============================================================
// LONGHAUL — Ordnance in flight: torpedoes and railgun slugs
//
// Ordnance are world entities ('ordnance') with driven motion: every
// minute each one is integrated under solar gravity plus its own
// thrust, exactly like a ship. A torpedo is a small fusion missile
// with a fixed Δv budget; a slug is a ballistic lump of metal.
//
// TORPEDO GUIDANCE (once a minute, applied the next minute)
//   Track    — the seeker sees the target (its own small sensor), or
//              the launcher still does and is in datalink range. If
//              neither, the torpedo flies on its last known track,
//              dead-reckoned: a target that went cold and changed
//              course is aimed at where it would have been.
//   Boost    — accelerate down the line of sight to the profile's
//              closing speed (FAST 15–30 km/s by tech level, COLD COAST
//              40% of that), then
//              go dark; burn again whenever the target pulls away, so a
//              ship running from a torpedo spends its Δv for it.
//   Midcourse— predict the miss at closest approach (zero-effort
//              miss, with the target's own thrust for a short
//              horizon) and correct it impulsively when it grows past
//              a deadband. Every correction costs Δv: a target that
//              keeps maneuvering bleeds a torpedo dry.
//   Terminal — inside ten minutes, correct every minute.
//
// THE LAST SECONDS
//   Each minute we find the closest approach of every torpedo to its
//   target over that minute (1 s samples of the relative motion). If
//   it passes inside the capture basket — the distance its remaining
//   acceleration can still close in the final seconds, plus whatever
//   its spare thrust can answer of a target's last-minute dodge — the
//   endgame is resolved:
//   • Point defense: every PDC mount covering the target fires while
//     the torpedo crosses the envelope (range ÷ closing speed). Kill
//     hazard = mounts × kill rate × fire-control factor × exposure,
//     shared among torpedoes arriving within the same few seconds
//     (salvos saturate). Rounds are spent.
//   • Homing: a survivor hits unless the target out-jinks it:
//     P = 1 − (target evasive G ÷ torpedo G available)². A civilian
//     that doesn't jink is all but certain to be hit.
//   • A nuclear warhead fuzes at its closest approach even when the
//     homing fails — a near miss still hurts.
//
// SLUGS fly a fire-control solution computed at firing (the target's
// current thrust assumed constant). When a slug passes the target we
// take the actual miss from the motion, add the gun's angular error
// and the target's sub-minute jinking, and roll against its cross
// section. Anything that holds still gets hit; anything jinking at
// range does not.
//
// GUNS against hulls are resolved per minute without projectiles in
// flight: PDC strafing, and mining gear turned on a ship at a few km.
// ============================================================

import { AU_M, G0, MIN_S, DAY_MIN, RANGE } from '../core/constants.js';
import { random, gaussian } from '../core/rng.js';
import { getWorld, stepFree } from './world.js';
import { createEntity } from './entities.js';
import {
  TORPEDO_MOTOR, WARHEADS, PROFILES, TERMINAL_S, TORPEDO_LIFE_DAYS, PDC_RPS, PDC_MAX_EXPOSURE_S,
  PDC_MUZZLE, PDC_STRAFE_DUTY, PDC_BURST_DP, RAILGUN, RAIL_DP, jinkSigma, hitChance, profileVc,
} from './weapons.js';
import { PLAYER, kinematics, profile, snapshot, sees, signatureOf, isOutOfFight } from './combatants.js';
import { applyHit, detonate } from './damage.js';
import { canSee, SEEKER_QUALITY } from './sensors.js';

const PREDICT_S = 600;            // horizon over which a target's current thrust is extrapolated
const TERMINAL_MIN = 10;          // minutes-to-go when terminal guidance starts
const SALVO_WINDOW_S = 5;         // torpedoes arriving this close together share the point defense
const PASS_CHECK_M = 50_000;      // slugs: closest approach worth evaluating

// ---- LAUNCH ----

/**
 * Launch a torpedo. opts: { warhead: 'he'|'nuke', profile: 'fast'|'cold', aim }
 * The shooter must hold the target on its sensors.
 */
export function launchTorpedo(state, shooterId, targetId, opts = {}, emit = () => {}) {
  const world = getWorld(state);
  const s = kinematics(state, shooterId), t = kinematics(state, targetId);
  if (!s || !t) return null;
  const tl = shooterId === PLAYER ? (state.ship.tl || 2) : (s.e.tl || 2);
  const motor = TORPEDO_MOTOR[tl];
  const warhead = WARHEADS[opts.warhead] ? opts.warhead : 'he';
  const prof = PROFILES[opts.profile] ? opts.profile : 'fast';
  const now = state.clock.minute;
  const e = createEntity({
    id: world.newId('torp'), name: `${WARHEADS[warhead].short} torpedo`, type: 'ordnance',
    faction: shooterId === PLAYER ? 'player' : s.e.faction,
    pos: s.pos, vel: s.vel, driven: true, transponder: false, t: now, mass: 1,
  });
  e.tl = tl;
  e.ord = {
    kind: 'torpedo', warhead, profile: prof, aim: opts.aim || 'disable',
    owner: shooterId, target: targetId, launchedAt: now,
    maxG: motor.maxG, dv0: motor.dv, dv: motor.dv,
    phase: 'boost', track: trackOf(t, now), cmd: null,
  };
  world.add(e);
  e.$prev = snapshot(e.pos, e.vel);
  guide(state, e, now);
  emit('torpedo-launched', { id: e.id, owner: shooterId, target: targetId, warhead, profile: prof });
  return e;
}

/** Fire one railgun slug at a target along a predicted-intercept solution. */
export function fireRailgun(state, shooterId, targetId, aim = 'disable', emit = () => {}) {
  const world = getWorld(state);
  const s = kinematics(state, shooterId), t = kinematics(state, targetId);
  if (!s || !t) return null;
  const tl = Math.max(2, shooterId === PLAYER ? (state.ship.tl || 2) : (s.e.tl || 2));
  const gun = RAILGUN[tl];
  const sol = interceptSolution(s, t, gun.speed);
  if (!sol) return null;
  const now = state.clock.minute;
  const e = createEntity({
    id: world.newId('slug'), name: 'Railgun slug', type: 'ordnance',
    faction: shooterId === PLAYER ? 'player' : s.e.faction,
    pos: s.pos, vel: { vx: s.vel.vx + sol.ux * gun.speed, vy: s.vel.vy + sol.uy * gun.speed },
    driven: true, transponder: false, t: now, mass: 0.002,
  });
  e.tl = tl;
  e.ord = {
    kind: 'slug', warhead: 'slug', aim, owner: shooterId, target: targetId, launchedAt: now,
    rangeM: sol.rangeM, sigma: gun.sigma, flightS: sol.tof, expires: now + Math.ceil(sol.tof / MIN_S) + 3,
  };
  world.add(e);
  e.$prev = snapshot(e.pos, e.vel);
  emit('slug-fired', { id: e.id, owner: shooterId, target: targetId });
  return e;
}

/**
 * Direction and time of flight for a constant-velocity projectile to meet a
 * target assumed to keep its current thrust. Fixed-point iteration on τ.
 */
export function interceptSolution(s, t, speed) {
  const dx = (t.pos.x - s.pos.x) * AU_M, dy = (t.pos.y - s.pos.y) * AU_M;
  const wx = t.vel.vx - s.vel.vx, wy = t.vel.vy - s.vel.vy;
  let tau = Math.hypot(dx, dy) / speed;
  let px = dx, py = dy;
  for (let i = 0; i < 12; i++) {
    px = dx + wx * tau + 0.5 * t.ax * tau * tau;
    py = dy + wy * tau + 0.5 * t.ay * tau * tau;
    const next = Math.hypot(px, py) / speed;
    if (Math.abs(next - tau) < 1e-3) { tau = next; break; }
    tau = next;
  }
  const r = Math.hypot(px, py);
  if (!isFinite(r) || r <= 0) return null;
  return { ux: px / r, uy: py / r, tof: tau, rangeM: Math.hypot(dx, dy) };
}

const trackOf = (k, now) => ({ x: k.pos.x, y: k.pos.y, vx: k.vel.vx, vy: k.vel.vy, ax: k.ax, ay: k.ay, t: now });

// ---- PER MINUTE ----

/**
 * Move all ordnance one minute, resolve what reached its target, then
 * guide the survivors. Runs after every ship has moved this minute.
 */
export function moveOrdnance(state, emit = () => {}) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const list = [];
  for (const e of world.driven) if (e.type === 'ordnance') list.push(e);
  if (!list.length) return;

  for (const e of list) {
    e.$prev = snapshot(e.pos, e.vel);
    const o = e.ord;
    let g = 0, h = e.heading;
    if (o.kind === 'torpedo' && o.cmd && o.dv > 0) {
      let a = Math.hypot(o.cmd.ax, o.cmd.ay);
      a = Math.min(a, o.maxG * G0, o.dv / MIN_S);
      if (a > 1e-4) { g = a / G0; h = Math.atan2(o.cmd.ay, o.cmd.ax); o.dv -= a * MIN_S; }
    }
    e.thrust = g; e.heading = h;
    stepFree(e.pos, e.vel, MIN_S, g, h);
    e.t = now;
    world.hash.update(e);
  }

  // Encounters this minute, grouped by target for point defense
  const byTarget = new Map();
  for (const e of list) {
    const o = e.ord;
    const tk = kinematics(state, o.target);
    if (!tk || (tk.e && isOutOfFight(tk.e)) || (o.target === PLAYER && state.lost)) { retire(world, e, 'target-lost', emit); continue; }
    const ca = closestApproach(e, tk);
    if (o.kind === 'slug') {
      if (ca.d <= PASS_CHECK_M) { resolveSlug(state, e, tk, ca, emit); continue; }
      if (now >= o.expires) retire(world, e, 'missed', emit);
      continue;
    }
    // The seeker homes continuously: inside the minute the torpedo can still
    // answer a target's change of thrust with whatever acceleration it has spare.
    const base = captureRadius(o);
    const spare = Math.max(0, Math.min(o.maxG * G0, o.dv / Math.max(1, ca.tau)) - (e.thrust || 0) * G0);
    if (ca.d <= base + 0.5 * spare * ca.tau * ca.tau) {
      const need = ca.d > base ? 2 * (ca.d - base) / Math.max(1, ca.tau) : 0;
      if (need > o.dv) continue;
      o.dv -= need;
      let g = byTarget.get(o.target);
      if (!g) byTarget.set(o.target, g = []);
      g.push({ e, ca });
    }
  }
  for (const [targetId, group] of byTarget) resolveTorpedoes(state, targetId, group, emit);

  // Guidance for the next minute; expiry
  for (const e of list) {
    if (e.ord.kind !== 'torpedo' || !world.get(e.id)) continue;
    if (now - e.ord.launchedAt > TORPEDO_LIFE_DAYS * DAY_MIN) { retire(world, e, 'expired', emit); continue; }
    // Out of Δv and falling behind its target: it can never arrive
    if (e.ord.dv < 1 && !isFinite(timeToGo(state, e))) { retire(world, e, 'spent', emit); continue; }
    guide(state, e, now, emit);
  }
}

/** Distance a torpedo can still close in its last seconds (m). */
export function captureRadius(o) {
  const a = Math.min(o.maxG * G0, o.dv / TERMINAL_S);
  return 0.5 * a * TERMINAL_S * TERMINAL_S;
}

/**
 * Closest approach between ordnance `e` and target kinematics `tk` over the
 * last minute. Relative motion is modelled with constant relative
 * acceleration, corrected to land exactly on both end states, and checked
 * segment by segment at 1 s resolution.
 * Returns { d (m), tau (s into the minute), vRel (m/s), dir: {x, y} (unit, target − ordnance) }.
 */
export function closestApproach(e, tk) {
  const ep = e.$prev, tp = tk.prev || { x: tk.pos.x - tk.vel.vx * MIN_S / AU_M, y: tk.pos.y - tk.vel.vy * MIN_S / AU_M, vx: tk.vel.vx, vy: tk.vel.vy };
  const r0x = (tp.x - ep.x) * AU_M, r0y = (tp.y - ep.y) * AU_M;
  const r1x = (tk.pos.x - e.pos.x) * AU_M, r1y = (tk.pos.y - e.pos.y) * AU_M;
  const v0x = tp.vx - ep.vx, v0y = tp.vy - ep.vy;
  const v1x = tk.vel.vx - e.vel.vx, v1y = tk.vel.vy - e.vel.vy;
  const kx = (v1x - v0x) / MIN_S, ky = (v1y - v0y) / MIN_S;
  // residual between the constant-acceleration model and the true end state
  const ex = r1x - (r0x + v0x * MIN_S + 0.5 * kx * MIN_S * MIN_S);
  const ey = r1y - (r0y + v0y * MIN_S + 0.5 * ky * MIN_S * MIN_S);
  const at = (tau, out) => {
    const f = tau / MIN_S;
    out.x = r0x + v0x * tau + 0.5 * kx * tau * tau + ex * f;
    out.y = r0y + v0y * tau + 0.5 * ky * tau * tau + ey * f;
  };
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
  let best = Infinity, bestTau = 0, bx = r1x, by = r1y;
  at(0, a);
  for (let i = 1; i <= MIN_S; i++) {
    at(i, b);
    // nearest point of segment a→b to the origin
    const sx = b.x - a.x, sy = b.y - a.y;
    const L2 = sx * sx + sy * sy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, -(a.x * sx + a.y * sy) / L2)) : 0;
    const px = a.x + sx * u, py = a.y + sy * u;
    const d = Math.hypot(px, py);
    if (d < best) { best = d; bestTau = i - 1 + u; bx = px; by = py; }
    a.x = b.x; a.y = b.y;
  }
  const vx = v0x + kx * bestTau, vy = v0y + ky * bestTau;
  return { d: best, tau: bestTau, vRel: Math.hypot(vx, vy), dir: best > 0 ? { x: bx / best, y: by / best } : { x: 1, y: 0 }, rx: bx, ry: by };
}

function retire(world, e, why, emit) {
  world.remove(e);
  emit('ordnance-gone', { id: e.id, kind: e.ord.kind, owner: e.ord.owner, target: e.ord.target, why, x: e.pos.x, y: e.pos.y });
}

// ---- GUIDANCE ----

/** Can the torpedo (or its launcher, over the datalink) see the target? */
function trackable(state, e, tk) {
  const d = Math.hypot(tk.pos.x - e.pos.x, tk.pos.y - e.pos.y);
  if (canSee(d, signatureOf(state, e.ord.target), SEEKER_QUALITY)) return true;
  const owner = kinematics(state, e.ord.owner);
  if (!owner || (owner.e && isOutOfFight(owner.e))) return false;
  const link = Math.hypot(owner.pos.x - e.pos.x, owner.pos.y - e.pos.y) <= RANGE.RADIO;
  return link && sees(state, e.ord.owner, e.ord.target);
}

function guide(state, e, now, emit = () => {}) {
  const o = e.ord;
  const tk = kinematics(state, o.target);
  if (tk && trackable(state, e, tk)) {
    if (o.lost) { o.lost = false; emit('torpedo-reacquired', { id: e.id, target: o.target }); }
    o.track = trackOf(tk, now);
  } else if (!o.lost) {
    o.lost = true;
    emit('torpedo-track-lost', { id: e.id, target: o.target, owner: o.owner });
  }
  const tr = o.track;
  if (!tr || o.dv <= 0) { o.cmd = null; return; }

  // Where the target is now, as far as the torpedo knows
  const age = (now - tr.t) * MIN_S;
  const h0 = Math.min(age, PREDICT_S);
  const tvx = tr.vx + tr.ax * h0, tvy = tr.vy + tr.ay * h0;
  const rx = (tr.x - e.pos.x) * AU_M + tr.vx * age + tr.ax * (h0 * age - 0.5 * h0 * h0);
  const ry = (tr.y - e.pos.y) * AU_M + tr.vy * age + tr.ay * (h0 * age - 0.5 * h0 * h0);
  const vx = tvx - e.vel.vx, vy = tvy - e.vel.vy;
  const d = Math.hypot(rx, ry);
  const ux = rx / d, uy = ry / d;
  const vc = -(rx * vx + ry * vy) / d;
  const maxA = Math.min(o.maxG * G0, o.dv / MIN_S);

  // Dead reckoning has run out: we're at the predicted point and nothing is here
  if (o.lost && vc <= 0 && d < 1e6) { retire(getWorld(state), e, 'lost', emit); return; }

  const tgo = vc > 1 ? d / vc : Infinity;
  if (o.phase !== 'terminal' && tgo < TERMINAL_MIN * MIN_S) o.phase = 'terminal';

  // Predicted miss at closest approach (target thrust over a short horizon)
  let ax = 0, ay = 0;
  if (isFinite(tgo)) {
    const H = Math.min(tgo, Math.max(0, PREDICT_S - age));
    const zx = rx + vx * tgo + tr.ax * (H * tgo - 0.5 * H * H);
    const zy = ry + vy * tgo + tr.ay * (H * tgo - 0.5 * H * H);
    const along = zx * ux + zy * uy;
    const px = zx - along * ux, py = zy - along * uy;
    const miss = Math.hypot(px, py);
    const deadband = o.phase === 'terminal' ? 0 : Math.max(captureRadius(o) * 0.3, 2e-5 * d);
    if (miss > deadband) {
      const tb = Math.min(MIN_S, tgo);
      const k = (o.phase === 'terminal' ? 1 : tgo > 3600 ? 0.5 : 0.8) / (tb * tgo - 0.5 * tb * tb);
      ax = px * k; ay = py * k;
    }
  }
  const lat = Math.hypot(ax, ay);
  if (lat > maxA) { ax *= maxA / lat; ay *= maxA / lat; }

  // Build the profile's closing speed, and burn again whenever the target pulls away
  const want = profileVc(o.profile, e.tl || 2);
  if (vc < want * 0.95) {
    const room = Math.sqrt(Math.max(0, maxA * maxA - ax * ax - ay * ay));
    const along = Math.min(room, (want - vc) / MIN_S);
    ax += ux * along; ay += uy * along;
    if (o.phase !== 'terminal') o.phase = 'boost';
  } else if (o.phase === 'boost') {
    o.phase = 'coast';
  }
  o.cmd = Math.hypot(ax, ay) > 1e-4 ? { ax, ay } : null;
}

// ---- ENDGAME ----

/** Who shoots at torpedoes coming for `targetId`: the target and anyone covering it. */
function defendersOf(state, targetId) {
  const out = [];
  const tk = kinematics(state, targetId);
  const self = profile(state, targetId);
  if (self && self.pdc.mounts > 0 && (targetId !== PLAYER || state.combat.pdc !== 'hold')) out.push({ id: targetId, p: self, cover: 1 });
  // The player covers ships it is protecting (escorts, rescues)
  if (targetId !== PLAYER && state.combat.protect.includes(targetId) && state.combat.pdc !== 'hold') {
    const p = profile(state, PLAYER);
    const d = Math.hypot(state.flight.pos.x - tk.pos.x, state.flight.pos.y - tk.pos.y) * AU_M;
    if (p.pdc.mounts > 0 && d <= p.pdc.rangeM) out.push({ id: PLAYER, p, cover: 0.5 });
  }
  // NPC wingmen of the same side
  const e = tk.e;
  if (e?.agent?.wing) {
    for (const id of e.agent.wing) {
      const w = getWorld(state).get(id);
      if (!w || isOutOfFight(w)) continue;
      const p = profile(state, id);
      const d = Math.hypot(w.pos.x - tk.pos.x, w.pos.y - tk.pos.y) * AU_M;
      if (p.pdc.mounts > 0 && d <= p.pdc.rangeM) out.push({ id, p, cover: 0.5 });
    }
  }
  return out;
}

function spendRounds(state, id, rounds) {
  if (id === PLAYER) {
    const r = state.resources.pdcRounds;
    const used = Math.min(r.current, rounds);
    r.current -= used;
    return used;
  }
  const h = getWorld(state).get(id)?.combat;
  if (!h) return 0;
  const used = Math.min(h.rounds, rounds);
  h.rounds -= used;
  return used;
}

function resolveTorpedoes(state, targetId, group, emit) {
  const world = getWorld(state);
  const tp = profile(state, targetId);
  const defenders = defendersOf(state, targetId);
  group.sort((a, b) => a.ca.tau - b.ca.tau);
  // Salvos: torpedoes arriving within a few seconds of each other share the guns
  const salvos = [];
  for (const g of group) {
    const last = salvos[salvos.length - 1];
    if (last && g.ca.tau - last[0].ca.tau <= SALVO_WINDOW_S) last.push(g); else salvos.push([g]);
  }
  for (const salvo of salvos) {
    const n = salvo.length;
    const hazard = salvo.map(() => 0);
    for (const def of defenders) {
      const { mounts, lambda, rangeM, factor, ammo } = def.p.pdc;
      if (mounts <= 0 || ammo <= 0) continue;
      const exposure = salvo.map(g => Math.min(rangeM / Math.max(1, g.ca.vRel), PDC_MAX_EXPOSURE_S));
      const meanExposure = exposure.reduce((a, b) => a + b, 0) / n;
      const want = mounts * PDC_RPS * meanExposure;
      const got = spendRounds(state, def.id, want);
      const k = want > 0 ? got / want : 0;
      for (let i = 0; i < n; i++) hazard[i] += mounts * lambda * factor * def.cover * exposure[i] * k / n;
      emit('pdc-fired', { id: def.id, rounds: got, defending: targetId });
    }
    salvo.forEach((g, i) => {
      const e = g.e, o = e.ord;
      if (!world.get(e.id)) return;
      const tk = kinematics(state, targetId);
      if (!tk || (targetId === PLAYER && state.lost)) { retire(world, e, 'target-lost', emit); return; }   // an earlier hit in the salvo finished it
      const at ={ x: tk.pos.x - g.ca.rx / AU_M, y: tk.pos.y - g.ca.ry / AU_M };
      if (random() < 1 - Math.exp(-hazard[i])) {
        world.remove(e);
        emit('torpedo-intercepted', { id: e.id, owner: o.owner, target: targetId, x: at.x, y: at.y, warhead: o.warhead });
        return;
      }
      const aAvail = Math.min(o.maxG * G0, o.dv / TERMINAL_S);
      const aEvade = tp.evadeG * G0;
      const pGuide = aAvail <= aEvade ? 0.05 : Math.max(0.05, Math.min(0.97, 1 - (aEvade / aAvail) ** 2));
      const homed = random() < pGuide;
      if (o.warhead === 'nuke') {
        const W = WARHEADS.nuke;
        const miss = homed ? random() * 150 : 300 + random() * (W.fuzeM - 300);
        const ang = random() * Math.PI * 2;
        const pos = { x: tk.pos.x + Math.cos(ang) * miss / AU_M, y: tk.pos.y + Math.sin(ang) * miss / AU_M };
        world.remove(e);
        emit('torpedo-hit', { id: e.id, owner: o.owner, target: targetId, warhead: 'nuke', missM: miss, x: pos.x, y: pos.y });
        detonate(state, pos, { dp: W.dp, scaleM: W.scaleM }, e.id, emit, { kind: 'nuclear', by: o.owner });
      } else if (homed) {
        world.remove(e);
        emit('torpedo-hit', { id: e.id, owner: o.owner, target: targetId, warhead: 'he', x: tk.pos.x, y: tk.pos.y });
        applyHit(state, targetId, { dp: WARHEADS.he.dp, aim: o.aim, precision: 0.5, kind: 'he', from: o.owner, weapon: 'HE torpedo' }, emit);
      } else {
        emit('torpedo-missed', { id: e.id, owner: o.owner, target: targetId, x: at.x, y: at.y });
        // a fly-by: it keeps going and may come round again if it has the Δv
        if (o.dv < 2 * g.ca.vRel) retire(world, e, 'missed', emit);
      }
    });
  }
}

function resolveSlug(state, e, tk, ca, emit) {
  const world = getWorld(state);
  const o = e.ord;
  const tp = profile(state, o.target);
  const flight = Math.max(1, (state.clock.minute - o.launchedAt) * MIN_S - (MIN_S - ca.tau));
  const sigma = Math.hypot(o.sigma * o.rangeM, jinkSigma(tp.evadeG, flight));
  const mx = ca.rx + gaussian() * sigma, my = ca.ry + gaussian() * sigma;
  world.remove(e);
  if (Math.hypot(mx, my) <= tp.radiusM) {
    emit('slug-hit', { id: e.id, owner: o.owner, target: o.target, x: tk.pos.x, y: tk.pos.y });
    applyHit(state, o.target, { dp: RAIL_DP, aim: o.aim, precision: 0.8, kind: 'slug', from: o.owner, weapon: 'railgun' }, emit);
  } else {
    emit('slug-missed', { id: e.id, owner: o.owner, target: o.target, missM: Math.hypot(mx, my) });
  }
}

// ---- GUNFIRE ----

/**
 * One minute of PDC fire at a hull inside strafing range. A burst lands
 * if the target's cross section covers the stream's dispersion (angular
 * error plus the target's jinking over the rounds' time of flight).
 * Returns the damage dealt (0 if out of range or out of rounds).
 */
export function strafe(state, shooterId, targetId, aim = 'disable', emit = () => {}) {
  const sp = profile(state, shooterId), tp = profile(state, targetId);
  const a = kinematics(state, shooterId), b = kinematics(state, targetId);
  if (!sp || !tp || !a || !b || sp.pdc.mounts <= 0 || sp.pdc.ammo <= 0) return 0;
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) * AU_M;
  if (d > sp.pdc.strafeM) return 0;
  const tof = d / PDC_MUZZLE;
  const sigma = Math.hypot(sp.pdc.sigmaRad * d, jinkSigma(tp.evadeG, tof));
  const want = sp.pdc.mounts * PDC_RPS * MIN_S * PDC_STRAFE_DUTY;
  const got = spendRounds(state, shooterId, want);
  const bursts = sp.pdc.mounts * sp.pdc.factor * hitChance(tp.radiusM, sigma) * (got / want);
  const dp = PDC_BURST_DP * bursts;
  emit('pdc-strafe', { from: shooterId, target: targetId, rounds: got, dp });
  if (dp >= 0.5) applyHit(state, targetId, { dp, aim, precision: 0.7, kind: 'pdc', from: shooterId, weapon: 'PDC' }, emit);
  return dp;
}

/**
 * Mining gear turned on a hull (one minute of it): rock and charges thrown by
 * eye. The miss is the gear's dispersion plus the target's jinking over the
 * projectile's flight; there is nothing to run out of. Returns DP delivered.
 */
export function fireGear(state, shooterId, targetId, aim = 'disable', emit = () => {}) {
  const sp = profile(state, shooterId), tp = profile(state, targetId);
  const a = kinematics(state, shooterId), b = kinematics(state, targetId);
  const g = sp?.gear;
  if (!g || g.mounts <= 0 || !tp || !a || !b) return 0;
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) * AU_M;
  if (d > g.rangeM) return 0;
  const sigma = Math.hypot(g.sigmaRad * d, jinkSigma(tp.evadeG, d / g.speed));
  const dp = g.dp * g.mounts * g.factor * hitChance(tp.radiusM, sigma);
  emit('gear-fired', { from: shooterId, target: targetId, gear: g.id, dp });
  if (dp >= 0.5) applyHit(state, targetId, { dp, aim, precision: 0.3, kind: 'gear', from: shooterId, weapon: g.name }, emit);
  return dp;
}

// ---- QUERIES ----

/** Ordnance in flight aimed at `targetId` (optionally only what `observer` can see). */
export function inboundTo(state, targetId) {
  const out = [];
  for (const e of getWorld(state).driven) if (e.type === 'ordnance' && e.ord.target === targetId) out.push(e);
  return out;
}

/** Ordnance launched by `ownerId`. */
export function launchedBy(state, ownerId) {
  const out = [];
  for (const e of getWorld(state).driven) if (e.type === 'ordnance' && e.ord.owner === ownerId) out.push(e);
  return out;
}

/** Estimated seconds until an ordnance entity reaches its target (Infinity if opening). */
export function timeToGo(state, e) {
  const tk = kinematics(state, e.ord.target);
  if (!tk) return Infinity;
  const rx = (tk.pos.x - e.pos.x) * AU_M, ry = (tk.pos.y - e.pos.y) * AU_M;
  const d = Math.hypot(rx, ry);
  const vc = -(rx * (tk.vel.vx - e.vel.vx) + ry * (tk.vel.vy - e.vel.vy)) / d;
  return vc > 1 ? d / vc : Infinity;
}
