// The exterior cameras' two instruments. A camera drone (sim/drones.js):
// out and on station, home again, left behind by a burn, waited for by a
// route, kept in a save. The telescope (sim/telescope.js): what it can
// hold, and what it makes of a hull by range, light and phase; time at 1×
// for our own torpedoes' arrival (combat.js).
import { assert } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_M } from '../js/core/constants.js';
import { createGame, advance, upgradeState } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { spawnAgent } from '../js/sim/agents.js';
import { sensorsTick, setSensorRange } from '../js/sim/sensors.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute, overrideSecure } from '../js/sim/autopilot.js';
import { launchTorpedo, launchedBy, timeToGo } from '../js/sim/ordnance.js';
import { PLAYER } from '../js/sim/combatants.js';
import { OWN_ARRIVAL_S } from '../js/sim/combat.js';
import { buyDrones } from '../js/sim/contracts.js';
import {
  deployDrone, recallDrone, deployRefusal, droneFeed, DRONE_LAUNCH_MIN, DRONE_RECOVER_MIN, DRONE_ENDURANCE_MIN,
} from '../js/sim/drones.js';
import { scopeOf, scopeLock, sightOf, flashMag, ownPlumeBlinds, ownPlume, bodySight, occulter, lockOn, sunOffAxis, SCOPES, FILTERS } from '../js/sim/telescope.js';
import { getBody, bodyPos } from '../js/sim/ephemeris.js';

function game(seed = 3, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 4, traffic: 0, forces: false, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** Every event of `type` from now on. */
function heard(type) {
  const got = [];
  bus.on(type, (p) => got.push(p));
  return got;
}

const KM = 1000 / AU_M;

/** A ship `km` from us along `dir` (rad), at our velocity, cold unless told otherwise. */
function shipAt(s, km, dir = 0, opts = {}) {
  const f = s.flight;
  return spawnAgent(s, { role: 'civilian', faction: 'independent', pos: { x: f.pos.x + Math.cos(dir) * km * KM, y: f.pos.y + Math.sin(dir) * km * KM }, vel: { ...f.vel }, ...opts });
}

/** Away from the rocks (a test of instruments, not of the ground): coasting free, a long way from Ceres. */
function freeSpace(s, auOut = 0.03) {
  const f = s.flight;
  f.hold = null;
  const r = Math.hypot(f.pos.x, f.pos.y);
  f.pos = { x: f.pos.x + f.pos.x / r * auOut, y: f.pos.y + f.pos.y / r * auOut };
}

export default [
  {
    name: 'a drone goes out only with the drive cold, is on station after its launch, and comes home to the rack',
    fn: () => {
      const s = game(1);
      const n0 = s.resources.drones.current;
      // hovering at Ceres' gate is a lit drive: no launch into our exhaust
      advance(s, 1);
      const hover = s.flight.thrustG;
      assert(hover > 0.01 && deployRefusal(s), `refused hovering at the gate on ${hover.toFixed(3)} G`);
      freeSpace(s);
      s.flight.thrustG = 0;
      const r = deployDrone(s, (t, p) => bus.emit(t, p));
      assert(r.ok, r.text);
      assert(s.resources.drones.current === n0 - 1 && s.drone?.phase === 'launch' && !droneFeed(s), 'out of the rack, launching, no picture yet');
      advance(s, DRONE_LAUNCH_MIN);
      assert(s.drone?.phase === 'station' && droneFeed(s), `on station after ${DRONE_LAUNCH_MIN} min`);
      assert(deployRefusal(s), 'one at a time');
      recallDrone(s, (t, p) => bus.emit(t, p));
      assert(droneFeed(s), 'its camera stays on while it comes home');
      advance(s, DRONE_RECOVER_MIN);
      console.log(`      rack ${n0} → ${s.resources.drones.current} · drone ${s.drone ? s.drone.phase : 'aboard'}`);
      assert(!s.drone && s.resources.drones.current === n0, 'aboard again, back in the rack');
    },
  },
  {
    name: 'a burn leaves the drone behind: EXECUTE NOW goes without it, and it is lost',
    fn: () => {
      const s = game(2);
      freeSpace(s);                     // (no way out of port on the RCS first: the drive lights at once)
      const lost = heard('drone-lost');
      const n0 = s.resources.drones.current;
      deployDrone(s);
      advance(s, DRONE_LAUNCH_MIN);
      const r = planRoutes(s, { kind: 'entity', id: 'pallas-station' })[0];
      engageRoute(s, r.plan);
      overrideSecure(s);
      let t = 0;
      while (!lost.length && t < 120) { advance(s, 1); t++; }
      console.log(`      lost after ${t} min at ${lost[0]?.g?.toFixed(2)} G · rack ${s.resources.drones.current}/${s.resources.drones.max}`);
      assert(lost.length === 1 && !s.drone, 'the burn left it behind');
      assert(s.resources.drones.current === n0 - 1, 'it does not come back to the rack');
      assert(deployRefusal(s), 'and none goes out under thrust');
    },
  },
  {
    name: 'a route waits for the drone as for the crew: called home, aboard before the drive lights',
    fn: () => {
      const s = game(3);
      freeSpace(s);
      const lost = heard('drone-lost'), recalled = heard('drone-recalled');
      const n0 = s.resources.drones.current;
      deployDrone(s);
      advance(s, DRONE_LAUNCH_MIN + 30);
      const r = planRoutes(s, { kind: 'entity', id: 'pallas-station' })[0];
      engageRoute(s, r.plan);
      let t = 0, aboardAt = null, litAt = null;
      while (t < 240 && litAt == null) {
        advance(s, 1); t++;
        if (aboardAt == null && !s.drone) aboardAt = t;
        if (s.flight.thrustG > 0.12) litAt = t;
      }
      console.log(`      recalled (${recalled[0]?.why}) · aboard at +${aboardAt} min · drive lit at +${litAt} min · rack ${s.resources.drones.current}/${n0}`);
      assert(recalled[0]?.why === 'burn', 'called home for the burn');
      assert(!lost.length && aboardAt != null && litAt != null && aboardAt <= litAt, 'aboard before the drive lit');
      assert(s.resources.drones.current === n0, 'back in the rack');
    },
  },
  {
    name: 'a drone runs out of cells and comes home by itself; a drone out survives a save',
    fn: () => {
      const s = game(4);
      freeSpace(s);
      const recalled = heard('drone-recalled');
      deployDrone(s);
      advance(s, 10);
      const back = deserialize(serialize(s)).state;
      assert(back.drone?.phase === 'station' && back.resources.drones.current === s.resources.drones.current, 'the drone out is in the save');
      advance(s, DRONE_ENDURANCE_MIN);
      assert(recalled.some(r => r.why === 'endurance') && !s.drone, 'home when its cells ran low');
      // A save from before drones: the rack is filled in on load
      const old = deserialize(serialize(s)).state;
      delete old.resources.drones; delete old.drone;
      upgradeState(old);
      assert(old.resources.drones.max > 0 && old.drone === null, 'an old save gets a full rack');
    },
  },
  {
    name: 'drones are bought in port, whole, to fill the rack',
    fn: () => {
      const s = game(5, { docked: true });
      s.resources.drones.current = 0;
      s.resources.credits.current = 1000;
      const r = buyDrones(s);
      console.log(`      ${r.text} · rack ${s.resources.drones.current}/${s.resources.drones.max} · ${s.resources.credits.current} MCR left`);
      assert(r.ok && Number.isInteger(s.resources.drones.current) && s.resources.drones.current === Math.min(s.resources.drones.max, 2), 'as many whole drones as credits allow');
    },
  },
  {
    name: 'telescope: a hull resolved close in, a point further out, nothing from its night side',
    fn: () => {
      const s = game(6);
      freeSpace(s);
      setSensorRange(s, 2);
      const out = Math.atan2(s.flight.pos.y, s.flight.pos.x);     // away from the Sun: the Sun behind us
      const near = shipAt(s, 1_000, out, { transponder: true });
      const mid = shipAt(s, 40_000, out + 0.3, { transponder: true });
      const far = shipAt(s, 300_000, out - 0.3, { transponder: true });
      const night = shipAt(s, 40_000, out + Math.PI, { transponder: true });    // sunward of us: its night side to us
      sensorsTick(s);
      const sc = scopeOf(s);
      const see = (e) => sightOf(s, e, e.pos, s.flight.pos, sc);
      const rows = { near, mid, far, night };
      for (const [k, e] of Object.entries(rows)) {
        const v = see(e);
        console.log(`      ${k.padEnd(5)} ${Math.round(v.distM / 1000).toLocaleString().padStart(8)} km · ${v.elements.toFixed(2).padStart(7)} el · mag ${v.hullMag.toFixed(1).padStart(5)} (limit ${v.magLimit.toFixed(1)}) · phase ${Math.round(v.phase * 57.3)}° · ${v.regime}`);
        assert(scopeLock(s, e.id, sc).ok, `${k}: within the lock`);
      }
      assert(see(near).regime === 'resolved', 'a thousand km off, a shape');
      assert(see(far).regime === 'point', 'three hundred thousand km off, a point of light');
      assert(see(night).regime === 'none' || see(night).hullMag > see(mid).hullMag + 3, 'its night side to us: far fainter than its day side, at the same range');
    },
  },
  {
    name: 'telescope: a lit drive is seen where the hull is not; the lock stops at its range, and at the board',
    fn: () => {
      const s = game(7);
      freeSpace(s);
      setSensorRange(s, 2);
      const lockKm = SCOPES[s.ship.tl || 2].lockKm;
      const burning = shipAt(s, lockKm * 0.8, 1, { transponder: true });
      burning.thrust = 1; burning.heading = 0;
      const beyond = shipAt(s, lockKm * 1.5, 2, { transponder: true });
      const unseen = shipAt(s, lockKm * 0.5, 3, { transponder: false });
      sensorsTick(s);
      const v = sightOf(s, burning);
      console.log(`      at ${Math.round(v.distM / 1e3).toLocaleString()} km: hull mag ${v.hullMag.toFixed(1)}, plume ${v.plumeMag.toFixed(1)} → ${v.regime} · beyond: ${scopeLock(s, beyond.id).why} · cold off the board: ${scopeLock(s, unseen.id).why}`);
      assert(v.regime === 'plume' && v.plumeMag < v.magLimit - 5, 'the drive is a bright star, the hull lost');
      assert(scopeLock(s, burning.id).ok, 'held inside the lock');
      assert(scopeLock(s, beyond.id).why === 'range', 'past the lock, nothing held (though the board has it)');
      assert(scopeLock(s, unseen.id).why === 'track', 'a cold hull off the board: nothing to point at');
      // Flashes: a nuclear one blinds at any range we can hold; a warhead's is a star
      console.log(`      flashes at ${lockKm.toLocaleString()} km: nuclear mag ${flashMag('nuclear', lockKm * 1e3).toFixed(1)} · HE ${flashMag('he', lockKm * 1e3).toFixed(1)} · intercept ${flashMag('intercept', lockKm * 1e3).toFixed(1)}`);
      assert(flashMag('nuclear', lockKm * 1e3) < -5 && flashMag('he', lockKm * 1e3) < scopeOf(s).magLimit, 'every flash in reach is seen');
      // Looking aft through our own lit drive: blind
      s.flight.thrustG = 1; s.flight.facing = 0;
      assert(ownPlumeBlinds(s, Math.PI) && !ownPlumeBlinds(s, 0), 'blind aft, not ahead');
    },
  },
  {
    name: 'telescope: worlds as they are from the Belt (size, brightness, phase); a world hides what is behind it',
    fn: () => {
      const s = game(9);
      const tm = s.clock.minute, from = s.flight.pos;
      const row = (n) => { const v = bodySight(getBody(n), tm, from); return `${n} ${(v.distM / 1.496e11).toFixed(2)} AU ${(v.angRad * 206265).toFixed(1)}″ mag ${v.mag.toFixed(1)} phase ${Math.round(v.phase * 57.3)}°`; };
      console.log('      ' + ['Sol', 'Jupiter', 'Saturn', 'Mars', 'Earth', 'Vesta'].map(row).join(' · '));
      const sun = bodySight(getBody('Sol'), tm, from), jup = bodySight(getBody('Jupiter'), tm, from);
      assert(sun.mag < -24 && sun.mag > -25.5 && sun.angRad * 206265 > 600 && sun.angRad * 206265 < 760, 'the Sun from the Belt: about −24.5, a third of its size from Earth');
      assert(jup.mag < -1.5 && jup.mag > -3 && jup.angRad * 206265 > 30 && jup.angRad * 206265 < 50, 'Jupiter: a bright planet, tens of arcseconds');
      assert(jup.lagS > 1000, 'its picture is half an hour old');
      assert(lockOn(s, { kind: 'body', id: 'Jupiter' }).ok, 'the sky is always held');
      // a point on the far side of Ceres, seen from this side: Ceres is in the way
      const ce = bodyPos(getBody('Ceres'), tm / 1440), KM = 1000 / AU_M;
      const near = { x: ce.x + 2000 * KM, y: ce.y }, far = { x: ce.x - 2000 * KM, y: ce.y };
      const hidden = occulter(tm, near, Math.PI, 4000 * 1000);
      const clear = occulter(tm, near, Math.PI / 2, 4000 * 1000);
      console.log(`      behind Ceres from 2,000 km: ${hidden?.body.name || 'nothing in the way'} · to the side: ${clear?.body.name || 'clear'}`);
      assert(hidden?.body.name === 'Ceres' && !clear, 'what is behind a world is hidden; beside it is not');
      assert(sunOffAxis(far, Math.atan2(-far.y, -far.x)) < 1e-9, 'the Sun is on the boresight looking sunward');
    },
  },
  {
    name: 'telescope: the plume filters cut a drive far more than a hull; through our own exhaust, blind, or degraded with a filter',
    fn: () => {
      const s = game(10);
      freeSpace(s);
      setSensorRange(s, 2);
      const t = shipAt(s, 1500, 0.4, { transponder: true });
      t.thrust = 1; t.heading = 0.4;
      sensorsTick(s);
      const off = sightOf(s, t, t.pos, s.flight.pos, scopeOf(s), FILTERS.off);
      const deep = sightOf(s, t, t.pos, s.flight.pos, scopeOf(s), FILTERS.deep);
      console.log(`      plume ${off.plumeMag.toFixed(1)} → ${deep.plumeMag.toFixed(1)} · hull ${off.hullMag.toFixed(1)} → ${deep.hullMag.toFixed(1)} · the gap ${(off.hullMag - off.plumeMag).toFixed(1)} → ${(deep.hullMag - deep.plumeMag).toFixed(1)} mag`);
      assert(deep.plumeMag - off.plumeMag === 9 && Math.abs(deep.hullMag - off.hullMag - 1.2) < 1e-9, 'DEEP: the drive −9, the hull −1.2');
      s.flight.thrustG = 1; s.flight.facing = 0;
      const blind = ownPlume(s, Math.PI, FILTERS.off), plume = ownPlume(s, Math.PI, FILTERS.plume), dp = ownPlume(s, Math.PI, FILTERS.deep);
      console.log(`      aft through our own exhaust: off wash ${blind.wash.toFixed(2)} (sees ${blind.see}) · plume ${plume.wash.toFixed(2)} · deep ${dp.wash.toFixed(2)}, blur ×${dp.blur.toFixed(1)}`);
      assert(!blind.see && plume.see && dp.see && dp.wash < plume.wash && plume.wash < blind.wash, 'blind without a filter; with one, washed and blurred, less so the deeper');
      assert(ownPlume(s, 0, FILTERS.off) === null, 'ahead, nothing in the way');
    },
  },
  {
    name: 'our own torpedoes\' last minutes run at 1× (the telescope watches them arrive)',
    fn: () => {
      const s = game(8);
      freeSpace(s);
      setSensorRange(s, 2);
      const target = shipAt(s, 60_000, 0.5, { transponder: true });
      sensorsTick(s);
      const torp = launchTorpedo(s, PLAYER, target.id, { warhead: 'he', profile: 'fast' }, (t, p) => bus.emit(t, p));
      assert(torp, 'torpedo away');
      let early = null, late = [], t = 0;
      while (launchedBy(s, PLAYER).length && t < 300) {
        advance(s, 1); t++;
        const e = launchedBy(s, PLAYER)[0];
        if (!e) break;
        const eta = timeToGo(s, e);
        if (eta < OWN_ARRIVAL_S) late.push(s.$combatWarp);
        else if (isFinite(eta) && early == null) early = s.$combatWarp;
      }
      console.log(`      warp ${early} with it far, ${late.join(',')} in its last ${OWN_ARRIVAL_S / 60} min · done after ${t} min`);
      assert(late.length && late.every(w => w === 1), 'real time for the arrival');
      assert(early == null || early > 1, 'not before');
    },
  },
];
