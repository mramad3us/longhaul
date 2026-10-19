// ============================================================
// LONGHAUL — Combat: our fire control, and the fight each minute
//
// Fire control works on one target at a time: a contact on our
// sensors. From the weapons board the captain can
//   • launch torpedoes (HE or nuclear; FAST or COLD COAST profile),
//     one per free tube — the autoloader needs a few minutes per tube;
//   • set the point-defense mode: AUTO (shoot down torpedoes), HOLD
//     (weapons tight), or ENGAGE (also rake the target with PDC fire
//     whenever it is inside gun range);
//   • choose where the guns aim (DISABLE / DISARM / KILL);
//   • order evasive jinking (battle stations only): random hard
//     thrust changes that throw off torpedo terminal homing, railgun
//     and PDC aim — at the cost of reaction mass and G on the crew.
// A gunner at the weapons console makes the PDCs far more effective.
//
// Shooting at a lawful ship is a crime, and it makes enemies of its
// friends nearby. Shooting back never is.
//
// Per minute, in order (see game.js):
//   moveAgents → (our station-keeping) → moveOrdnance → … → combatTick
// so every ship has moved before any torpedo is checked against it,
// and decisions made now are flown next minute.
// ============================================================

import { AU_M, MIN_S } from '../core/constants.js';
import { getWorld } from './world.js';
import { PLAYER, profile, kinematics, isOutOfFight } from './combatants.js';
import { launchTorpedo, moveOrdnance, strafe, inboundTo, timeToGo } from './ordnance.js';
import { moveAgents, agentsTick, wake, makeHostile, hostilesOfPlayer } from './agents.js';
import { recordAttack, lawfulTarget } from './law.js';
import { isTracked } from './sensors.js';
import { systemPerf } from './systems.js';
import { isReactorOnline } from './reactor.js';
import { WARHEADS, PROFILES, TORPEDO_RELOAD_MIN, EVADE_G } from './weapons.js';
import { AIM } from './damage.js';
import { CLASSES, PLAYER_CLASS } from './ship-classes.js';

export const PDC_MODES = {
  auto: { label: 'AUTO', desc: 'Point defense shoots down incoming torpedoes.' },
  hold: { label: 'HOLD', desc: 'Weapons tight — the PDCs stay silent, even against torpedoes.' },
  engage: { label: 'ENGAGE', desc: 'Point defense, and rake the target with PDC fire whenever it comes inside gun range.' },
};

export function createCombat(classId = PLAYER_CLASS) {
  return {
    target: null,              // fire-control target (entity id)
    pdc: 'auto',
    aim: 'disable',
    evasive: false,
    tubes: new Array(CLASSES[classId].tubes).fill(0),   // minute each tube is loaded again
    protect: [],               // ships our PDCs cover (escort charges, ships we came to rescue)
    warned: [],                // inbound ordnance already announced
  };
}

/** The magazine aboard: torpedoes by warhead, and how many fit. */
export function createMagazine(classId = PLAYER_CLASS) {
  const c = CLASSES[classId];
  return { capacity: c.magazineCap || 0, he: c.magazine?.he || 0, nuke: c.magazine?.nuke || 0 };
}

// ---- ORDERS ----

/** Put a contact under fire control (null clears). */
export function setFireTarget(state, id) {
  if (id == null) { state.combat.target = null; return { ok: true, text: 'Fire control cleared' }; }
  const e = getWorld(state).get(id);
  if (!e || e.type !== 'ship') return { ok: false, text: 'Fire control needs a ship to target' };
  if (!isTracked(state, id)) return { ok: false, text: 'No sensor track on that contact' };
  state.combat.target = id;
  return { ok: true, text: `Fire control: target ${e.transponder ? e.name : 'contact ' + e.signature}` };
}

export function setPdcMode(state, mode) {
  if (PDC_MODES[mode]) state.combat.pdc = mode;
}

export function setAim(state, aim) {
  if (AIM[aim]) state.combat.aim = aim;
}

/** Evasive jinking: only with the crew strapped in and a drive to jink with. */
export function setEvasive(state, on) {
  if (on && !state.combatStations) return { ok: false, text: 'Battle stations first — nobody jinks with the crew on their feet' };
  state.combat.evasive = !!on;
  return { ok: true, text: on ? 'Helm: evasive maneuvers' : 'Helm: evasive maneuvers secured' };
}

/** G of random jinking this minute (0 when not evading or no drive). */
export function jinkG(state) {
  const C = state.combat;
  if (!C.evasive || !state.combatStations) return 0;
  if (!isReactorOnline(state) || state.resources.fuel.current <= 0) return 0;
  return Math.min(EVADE_G, state.flight.maxG);
}

/** Tubes ready to fire right now. */
export function readyTubes(state) {
  const now = state.clock.minute;
  return systemPerf(state, 'launcher') > 0 ? state.combat.tubes.filter(t => t <= now).length : 0;
}

/**
 * Fire one torpedo at the fire-control target. opts: { warhead, profile }
 * Returns { ok, text, torpedo }.
 */
export function fireTorpedo(state, opts = {}, emit = () => {}) {
  const C = state.combat;
  const id = C.target;
  const e = id && getWorld(state).get(id);
  if (!e || isOutOfFight(e)) return { ok: false, text: 'No target under fire control' };
  if (!isTracked(state, id)) return { ok: false, text: 'Lost the sensor track — no firing solution' };
  const warhead = WARHEADS[opts.warhead] ? opts.warhead : 'he';
  if (state.magazine[warhead] <= 0) return { ok: false, text: `No ${WARHEADS[warhead].name.toLowerCase()}es in the magazine` };
  if (systemPerf(state, 'launcher') <= 0) return { ok: false, text: 'Launcher down — no tubes' };
  if (!isReactorOnline(state) && state.resources.power.current <= 0) return { ok: false, text: 'No power to the tubes' };
  const now = state.clock.minute;
  const tube = C.tubes.findIndex(t => t <= now);
  if (tube < 0) return { ok: false, text: 'All tubes reloading' };
  engage(state, e, emit);
  const t = launchTorpedo(state, PLAYER, id, { warhead, profile: PROFILES[opts.profile] ? opts.profile : 'fast', aim: C.aim }, emit);
  if (!t) return { ok: false, text: 'Launch failed — no firing solution' };
  state.magazine[warhead]--;
  C.tubes[tube] = now + TORPEDO_RELOAD_MIN * (systemPerf(state, 'launcher') < 1 ? 2 : 1);
  return { ok: true, text: `Tube ${tube + 1}: ${WARHEADS[warhead].name} away — ${PROFILES[t.ord.profile].label}`, torpedo: t };
}

/**
 * We are opening fire on `e`: it (and its friends, if it was lawful) fight
 * back, and the law takes note.
 */
function engage(state, e, emit) {
  if (!e.agent) wake(state, e, CLASSES[e.cls]?.category === 'civilian' ? 'civilian' : e.faction === 'pirate' ? 'pirate' : 'patrol');
  const lawful = lawfulTarget(e);
  makeHostile(state, e, PLAYER, { provoked: lawful });
  recordAttack(state, e, 'fired', emit);
}

// ---- PER MINUTE ----

/** Ordnance flies after every ship has moved (agents, then us). */
export function combatMove(state, emit = () => {}) {
  moveOrdnance(state, emit);
}

export { moveAgents };

export function combatTick(state, emit = () => {}) {
  const C = state.combat;
  agentsTick(state, emit);

  // The fire-control target can slip away, die, or strike
  if (C.target) {
    const t = getWorld(state).get(C.target);
    if (!t || t.combat?.status === 'wreck' || !isTracked(state, C.target)) {
      if (t?.combat?.status === 'wreck') emit('target-destroyed', { id: C.target, name: t.name });
      C.target = null;
    }
  }

  // PDCs on ENGAGE rake the target when it is inside gun range
  if (C.pdc === 'engage' && C.target && !state.lost) {
    const t = getWorld(state).get(C.target);
    const p = profile(state, PLAYER);
    const k = kinematics(state, C.target);
    if (t && k && p.pdc.mounts > 0 && t.combat?.status !== 'surrendered') {
      const d = Math.hypot(k.pos.x - state.flight.pos.x, k.pos.y - state.flight.pos.y) * AU_M;
      if (d <= p.pdc.strafeM) {
        engage(state, t, emit);
        strafe(state, PLAYER, C.target, C.aim, emit);
      }
    }
  }

  // Inbound ordnance we can see: announce each once
  const inbound = threats(state);
  for (const th of inbound) {
    if (C.warned.includes(th.id)) continue;
    C.warned.push(th.id);
    emit('ordnance-inbound', { id: th.id, kind: th.kind, warhead: th.warhead, etaS: th.etaS, owner: th.owner });
  }
  if (state.clock.minute % 60 === 0) {
    const world = getWorld(state);
    C.warned = C.warned.filter(id => world.get(id));
    C.protect = C.protect.filter(id => world.get(id));
  }

  state.$combatWarp = warpLimit(state, inbound);
}

/** Ordnance aimed at us that our sensors hold: [{ id, kind, warhead, etaS, owner }] by ETA. */
export function threats(state) {
  const out = [];
  for (const e of inboundTo(state, PLAYER)) {
    if (!isTracked(state, e.id)) continue;
    out.push({ id: e.id, kind: e.ord.kind, warhead: e.ord.warhead, etaS: timeToGo(state, e), owner: e.ord.owner });
  }
  return out.sort((a, b) => a.etaS - b.etaS);
}

/** Time warp allowed by the tactical situation (1–3). */
function warpLimit(state, inbound) {
  const eta = inbound.length ? inbound[0].etaS : Infinity;
  if (eta < 30 * MIN_S || state.comms.requests.length) return 1;
  const hostiles = hostilesOfPlayer(state);
  let nearest = Infinity;
  for (const h of hostiles) nearest = Math.min(nearest, Math.hypot(h.pos.x - state.flight.pos.x, h.pos.y - state.flight.pos.y));
  if (nearest < 0.0005) return 1;
  if (eta < 6 * 60 * MIN_S || nearest < 0.005) return 2;
  return 3;
}
