// ============================================================
// LONGHAUL — Station defenses
//
// Every station has guns (stations.js: defense): PDC emplacements that
// shoot down torpedoes coming for it and the ships berthed or holding
// close by (ordnance.js), and rake hulls that come too close; torpedo
// silos; railguns at the naval yards. The weapons are the station's
// DISARM section, its docks the DISABLE section (damage.js).
//
// A station fires on:
//   whoever has fired on it (it remembers),
//   us, if its power has us HOSTILE and we are within reach, or we fly
//     the flag of a power it is at war with (service.js) and it knows us,
//   a trespasser in the keep-out zone of a naval yard, after the final
//     warning (traffic-control.js),
//   pirates within reach of its guns.
// Its alert stands down after a quiet half-day. A station under attack
// calls its power's ships nearby to the fight.
//
// Only stations near us, or on alert, are looked at in a minute: the
// rest of the system's stations cost nothing.
// ============================================================

import { AU_M } from '../core/constants.js';
import { getWorld } from './world.js';
import { STATIONS } from './stations.js';
import { PLAYER, ensureHull, profile, kinematics, isOutOfFight, sees } from './combatants.js';
import { launchTorpedo, fireRailgun, strafe, launchedBy } from './ordnance.js';
import { TORPEDO_RELOAD_MIN, RAIL_RELOAD_MIN, RAIL_RANGE_M } from './weapons.js';
import { makeHostile } from './agents.js';
import { wantedBy } from './law.js';
import { enemyOf, ourName } from './service.js';

const LOOK_AU = 0.01;                  // stations this near us are watched every minute
const REACH_AU = 0.003;                // torpedo reach of a station's silos (≈450,000 km)
const STAND_DOWN_MIN = 12 * 60;
const HELP_AU = 0.02;


export function stationsTick(state, emit = () => {}) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const alerts = (state.stationAlerts ||= []);
  const list = new Set(alerts);
  const f = state.flight.pos;
  for (const e of world.stations) if (Math.abs(e.pos.x - f.x) < LOOK_AU && Math.abs(e.pos.y - f.y) < LOOK_AU) list.add(e.id);
  for (const id of list) {
    const st = world.get(id);
    if (!st || st.type !== 'station') { drop(alerts, id); continue; }
    stationMinute(state, st, now, emit);
    if (st.combat?.alert !== 'normal' && st.combat?.status !== 'wreck') { if (!alerts.includes(id)) alerts.push(id); }
    else drop(alerts, id);
  }
}

const drop = (list, id) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); };

function stationMinute(state, st, now, emit) {
  const spec = STATIONS[st.id];
  const world = getWorld(state);
  const dAU = Math.hypot(st.pos.x - state.flight.pos.x, st.pos.y - state.flight.pos.y);
  // (a captain under an enemy flag is fired on once the station knows who it is: transponder, or close)
  const enemyFlag = enemyOf(state, st.faction) && dAU < REACH_AU && (state.comms.transponder || dAU < REACH_AU / 3);
  const playerThreat = !state.lost && (wantedBy(state, st.faction) >= 3 && dAU < REACH_AU || enemyFlag
    || (spec?.military && state.tc?.station === st.id && state.tc.warned?.trespass != null && state.tc.zone === 'keepout'));
  // Nothing to look at: don't even make a combat state
  if (!st.combat && !playerThreat && !piratesNear(state, st).length) return;
  const h = ensureHull(st);
  if (h.status === 'wreck' || h.status === 'blackout') return;
  if (playerThreat && !h.hostile.includes(PLAYER)) {
    h.hostile.push(PLAYER);
    h.alert = 'hostile';
    emit('station-alert', { id: st.id, name: st.name, level: 'hostile', text: `${st.name}: weapons free on ${ourName(state)}.` });
  }
  for (const p of piratesNear(state, st)) if (!h.hostile.includes(p.id)) { h.hostile.push(p.id); h.alert = 'hostile'; }
  h.hostile = h.hostile.filter(id => id === PLAYER ? !state.lost : !isOutOfFight(world.get(id)));
  if (!h.hostile.length) {
    if (h.alert !== 'normal' && now - (h.lastShot ?? h.alertAt ?? now) > STAND_DOWN_MIN) { h.alert = 'normal'; emit('station-alert', { id: st.id, name: st.name, level: 'normal' }); }
    return;
  }
  h.alertAt ??= now;
  if (h.hostile.includes(PLAYER) && !h.called) { h.called = true; callForHelp(state, st); }
  for (const tid of h.hostile) fireOn(state, st, h, tid, now, emit);
}

/** Pirate hulls within a station's gun reach that it can see. */
function piratesNear(state, st) {
  const out = [];
  for (const e of getWorld(state).driven) {
    if (e.type !== 'ship' || e.faction !== 'pirate' || isOutOfFight(e)) continue;
    if (Math.hypot(e.pos.x - st.pos.x, e.pos.y - st.pos.y) < REACH_AU && sees(state, st.id, e.id)) out.push(e);
  }
  return out;
}

/** The station's power's police and warships close by join the fight. */
function callForHelp(state, st) {
  for (const o of getWorld(state).driven) {
    if (o.type !== 'ship' || !o.agent || o.faction !== st.faction || isOutOfFight(o)) continue;
    if (!['patrol', 'picket', 'navy'].includes(o.agent.role)) continue;
    if (Math.hypot(o.pos.x - st.pos.x, o.pos.y - st.pos.y) < HELP_AU) makeHostile(state, o, PLAYER);
  }
}

function fireOn(state, st, h, tid, now, emit) {
  const tk = kinematics(state, tid);
  if (!tk || !sees(state, st.id, tid)) return;
  const p = profile(state, st.id), tp = profile(state, tid);
  if (!p || !tp) return;
  const dAU = Math.hypot(tk.pos.x - st.pos.x, tk.pos.y - st.pos.y), dM = dAU * AU_M;
  const aim = tp.cls?.category === 'irregular' || tp.faction === 'pirate' ? 'kill' : 'disable';
  let fired = false;
  if (p.tubes > 0 && p.torps > 0 && dAU <= REACH_AU) {
    const inFlight = launchedBy(state, st.id).filter(o => o.ord.kind === 'torpedo' && o.ord.target === tid).length;
    const salvo = Math.max(1, Math.min(p.tubes, Math.ceil(tp.pdc.mounts * tp.pdc.lambda * tp.pdc.factor * 2) + 1));
    for (let i = 0; i < h.tubes.length && inFlight + (fired ? 1 : 0) < salvo; i++) {
      if (h.tubes[i] > now) continue;
      const warhead = h.magazine.he > 0 ? 'he' : h.magazine.nuke > 0 && tp.cls?.category === 'military' ? 'nuke' : null;
      if (!warhead) break;
      if (!launchTorpedo(state, st.id, tid, { warhead, profile: 'fast', aim }, emit)) break;
      h.magazine[warhead]--;
      h.tubes[i] = now + TORPEDO_RELOAD_MIN;
      fired = true;
    }
  }
  if (p.railMounts > 0 && dM <= RAIL_RANGE_M) {
    for (let i = 0; i < h.rail.length; i++) {
      if (h.rail[i] > now) continue;
      if (fireRailgun(state, st.id, tid, aim, emit)) { h.rail[i] = now + RAIL_RELOAD_MIN; fired = true; }
    }
  }
  if (dM <= p.pdc.strafeM && strafe(state, st.id, tid, aim, emit) > 0) fired = true;
  if (fired) {
    h.lastShot = now;
    if (tid === PLAYER && !h.announced) { h.announced = true; emit('under-attack', { id: st.id, name: st.name }); }
  }
}

