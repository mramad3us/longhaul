// Combat: ship classes, torpedoes, point defense, railguns, damage, NPC behaviour, law.
import { assert, fmt } from './helpers.mjs';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { CLASSES, CLASS_IDS, SHAPES, SIZES, TECH, rollIdentity, techFor } from '../js/sim/ship-classes.js';
import { spawnAgent, respondToRequest, surrender } from '../js/sim/agents.js';
import { launchTorpedo, fireRailgun } from '../js/sim/ordnance.js';
import { applyHit, detonate } from '../js/sim/damage.js';
import { PLAYER, ensureHull, profile, gunner } from '../js/sim/combatants.js';
import { setFireTarget, fireTorpedo } from '../js/sim/combat.js';
import { sensorsTick } from '../js/sim/sensors.js';
import { circularSpeed } from '../js/sim/ephemeris.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { releaseHold } from '../js/sim/autopilot.js';

function game(seed = 11) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 6, traffic: 0 });
  s.missions.cooldown = 1e9;                  // no distress calls
  s.politics.quietUntil = Infinity;           // no random encounters
  s.politics.zones = [];
  releaseHold(s);
  return s;
}

/** Collect sim events by type. */
function recorder() {
  const ev = {};
  bus.on('*', (type, p) => { (ev[type] ||= []).push(p); });
  return ev;
}

/** A spot `distAU` from us, at rest in the local frame (co-orbiting). */
function near(s, distAU, ang = 1.0) {
  const f = s.flight.pos;
  const pos = { x: f.x + Math.cos(ang) * distAU, y: f.y + Math.sin(ang) * distAU };
  return { pos, vel: { vx: s.flight.vel.vx, vy: s.flight.vel.vy } };
}

/** Advance until no ordnance is left in flight (or `max` minutes). */
function untilQuiet(s, max) {
  const world = getWorld(s);
  let t = 0;
  while (t < max) {
    advance(s, 1); t++;
    let any = false;
    for (const e of world.driven) if (e.type === 'ordnance') { any = true; break; }
    if (!any) break;
  }
  return t;
}

export default [
  {
    name: 'the catalog: every class is complete, and factions field the tech they build',
    fn: () => {
      for (const id of CLASS_IDS) {
        const c = CLASSES[id];
        assert(SHAPES[c.shape], `${id}: unknown shape ${c.shape}`);
        assert(SIZES[c.size], `${id}: unknown size`);
        assert(c.tl[0] >= 1 && c.tl[1] <= 4 && c.tl[0] <= c.tl[1], `${id}: bad TL range`);
        assert(c.drive.maxG >= c.drive.cruiseG, `${id}: drive`);
        assert(Object.keys(c.factions).length, `${id}: nobody flies it`);
      }
      assert(techFor('corvette', 'MCR') === 4 && techFor('corvette', 'UN') === 3, 'navy TL');
      assert(techFor('cutter', 'OPA') === 2, 'OPA police TL');
      assert(techFor('ice-hauler', 'OPA') === 1, 'belter civilian TL');
      seedRandom(3);
      for (let i = 0; i < 200; i++) {
        const id = rollIdentity({ category: 'civilian', near: 'OPA' });
        assert(CLASSES[id.cls].category === 'civilian', 'civilian roll');
        assert(TECH[id.tl], 'tech level');
      }
    },
  },
  {
    name: 'an unarmed civilian is all but certain to be hit by a torpedo',
    fn: () => {
      let hits = 0, intercepted = 0, trials = 12, mins = 0;
      for (let k = 0; k < trials; k++) {
        const s = game(100 + k);
        const ev = recorder();
        const { pos, vel } = near(s, 0.002);
        const e = spawnAgent(s, { role: 'civilian', cls: 'ice-hauler', faction: 'OPA', pos, vel });
        launchTorpedo(s, PLAYER, e.id, { warhead: 'he', profile: 'fast', aim: 'disable' }, (t, p) => bus.emit(t, p));
        mins += untilQuiet(s, 12 * 60);
        hits += (ev['torpedo-hit'] || []).length;
        intercepted += (ev['torpedo-intercepted'] || []).length;
      }
      console.log(`      ${hits}/${trials} hits on an unarmed hauler at 300,000 km, mean flight ${fmt(mins / trials / 60)}h`);
      assert(intercepted === 0, 'nothing to intercept with');
      assert(hits >= trials - 1, `only ${hits}/${trials} hits`);
    },
  },
  {
    name: 'a lone torpedo against a warship\'s point defense dies; a salvo sometimes gets through',
    fn: () => {
      let singleHits = 0, salvoHits = 0, salvoTorps = 0;
      const trials = 10;
      for (let k = 0; k < trials; k++) {
        for (const n of [1, 6]) {
          const s = game(200 + k * 3 + n);
          const ev = recorder();
          const { pos, vel } = near(s, 0.002);
          const e = spawnAgent(s, { role: 'navy', cls: 'corvette', faction: 'MCR', pos, vel });
          for (let i = 0; i < n; i++) launchTorpedo(s, PLAYER, e.id, { warhead: 'he', profile: 'fast' }, (t, p) => bus.emit(t, p));
          untilQuiet(s, 12 * 60);
          const h = (ev['torpedo-hit'] || []).length;
          if (n === 1) singleHits += h; else { salvoHits += h; salvoTorps += n; }
        }
      }
      console.log(`      MCRN corvette: ${singleHits}/${trials} single torpedoes hit; ${salvoHits}/${salvoTorps} from 6-torpedo salvos`);
      assert(singleHits <= 2, `PDC let ${singleHits}/${trials} singles through`);
    },
  },
  {
    name: 'a long-range shot coasts for days and never spends Δv it does not have',
    fn: () => {
      const s = game(31);
      const ev = recorder();
      const { pos, vel } = near(s, 0.04, 2.0);
      const e = spawnAgent(s, { role: 'civilian', cls: 'freighter', faction: 'independent', pos, vel });
      e.transponder = true;
      const t = launchTorpedo(s, PLAYER, e.id, { warhead: 'he', profile: 'cold' }, (x, p) => bus.emit(x, p));
      let minDv = Infinity, coldMinutes = 0, minutes = 0;
      const world = getWorld(s);
      while (world.get(t.id) && minutes < 30 * DAY_MIN) {
        advance(s, 10);
        minutes += 10;
        if (!world.get(t.id)) break;
        minDv = Math.min(minDv, t.ord.dv);
        if (t.thrust === 0) coldMinutes += 10;
      }
      const result = ev['torpedo-hit'] ? 'hit' : ev['torpedo-intercepted'] ? 'shot down by its PDC' : ev['torpedo-missed'] ? 'missed' : (ev['ordnance-gone'] || [])[0]?.why || 'still flying';
      console.log(`      6M km cold-coast shot: ${fmt(minutes / DAY_MIN)} days, ${fmt(coldMinutes / minutes * 100, 0)}% of it dark, ${result}, Δv left ≥ ${fmt(minDv / 1000)} km/s`);
      assert(minutes > DAY_MIN, `flight only ${minutes} min`);
      assert(minDv >= 0, 'negative Δv');
      assert(coldMinutes / minutes > 0.8, 'should coast dark most of the way');
    },
  },
  {
    name: 'a torpedo that loses its track flies on dead reckoning',
    fn: () => {
      const s = game(41);
      const ev = recorder();
      const { pos, vel } = near(s, 0.012, 0.5);
      const e = spawnAgent(s, { role: 'civilian', cls: 'tanker', faction: 'independent', pos, vel });
      launchTorpedo(s, PLAYER, e.id, { warhead: 'he', profile: 'cold' }, (x, p) => bus.emit(x, p));
      e.transponder = false;                  // the target goes silent and cold
      s.comms.transponder = false;
      advance(s, 120);
      assert(ev['torpedo-track-lost']?.length, 'track should be lost beyond seeker range');
      untilQuiet(s, 5 * DAY_MIN);
      console.log(`      track lost, reacquired: ${!!ev['torpedo-reacquired']}, outcome: ${ev['torpedo-hit'] ? 'hit' : ev['torpedo-missed'] ? 'missed' : (ev['ordnance-gone'] || []).map(o => o.why).join(',')}`);
    },
  },
  {
    name: 'railguns hit what holds still and miss what jinks',
    fn: () => {
      const tally = { still: 0, jink: 0 };
      const shots = 30;
      for (const mode of ['still', 'jink']) {
        const s = game(mode === 'still' ? 51 : 52);
        const ev = recorder();
        const { pos, vel } = near(s, 2_000_000 / AU_M);       // 2,000 km
        const gun = spawnAgent(s, { role: 'navy', cls: 'frigate', faction: 'UN', pos: s.flight.pos, vel: s.flight.vel });
        // an inert target (a docked 'convoy' never acts): it coasts, or jinks when we say so
        const tgt = spawnAgent(s, { role: 'convoy', cls: 'pirate-gunship', faction: 'pirate', pos, vel });
        ensureHull(tgt).hp = 1e9;            // survive the test
        tgt.agent.evade = mode === 'jink';
        for (let i = 0; i < shots; i++) {
          fireRailgun(s, gun.id, tgt.id, 'disable', (x, p) => bus.emit(x, p));
          tgt.agent.evade = mode === 'jink';
          advance(s, 1);
          // keep the target whole: we are measuring aim, not damage (20 slugs would wreck it)
          Object.assign(tgt.combat, { drive: 1, reactor: 1, weapons: 1, sensors: 1, containment: null, status: 'ok' });
        }
        advance(s, 5);
        tally[mode] = (ev['slug-hit'] || []).length;
      }
      console.log(`      2,000 km: ${tally.still}/${shots} slugs hit a coasting target, ${tally.jink}/${shots} a jinking one`);
      assert(tally.still >= shots * 0.8, 'should hit a target that holds still');
      assert(tally.jink <= shots * 0.2, 'should mostly miss a jinking target');
    },
  },
  {
    name: 'disabling shots cripple; reactor kills light the sky and hurt neighbors',
    fn: () => {
      let disabled = 0, blown = 0;
      for (let k = 0; k < 20; k++) {
        const s = game(300 + k);
        const { pos, vel } = near(s, 0.01);
        const e = spawnAgent(s, { role: 'pirate', cls: 'pirate-gunship', faction: 'pirate', pos, vel });
        for (let i = 0; i < 3 && getWorld(s).get(e.id) && e.combat.status === 'ok'; i++) applyHit(s, e.id, { dp: 45, aim: 'disable', precision: 0.8, kind: 'slug', from: PLAYER });
        if (e.combat.status === 'disabled') disabled++;
        const f = spawnAgent(s, { role: 'pirate', cls: 'pirate-gunship', faction: 'pirate', pos, vel });
        for (let i = 0; i < 4 && getWorld(s).get(f.id); i++) applyHit(s, f.id, { dp: 70, aim: 'kill', precision: 0.8, kind: 'he', from: PLAYER });
        if (!getWorld(s).get(f.id)) blown++;
      }
      console.log(`      DISABLE: ${disabled}/20 crippled by railgun hits · KILL: ${blown}/20 reactors detonated by HE hits`);
      assert(disabled >= 12, 'disable aim should usually cripple the drive');
      assert(blown >= 3, 'kill aim should sometimes detonate the reactor');

      // A fusion blast: deadly at a kilometer, harmless at fifty
      const s = game(400);
      const { pos, vel } = near(s, 0.01);
      const close = spawnAgent(s, { role: 'civilian', cls: 'courier', faction: 'UN', pos: { x: pos.x + 1000 / AU_M, y: pos.y }, vel });
      const far = spawnAgent(s, { role: 'civilian', cls: 'courier', faction: 'UN', pos: { x: pos.x + 50_000 / AU_M, y: pos.y }, vel });
      ensureHull(close); ensureHull(far);
      detonate(s, pos, SIZES.M.reactor, 'nobody');
      console.log(`      M-size reactor blast: courier at 1 km → ${close.combat.status} (hp ${fmt(close.combat.hp)}), at 50 km → hp ${fmt(far.combat.hp)}`);
      assert(close.combat.hp < close.combat.hpMax * 0.5, 'close ship barely touched');
      assert(far.combat.hp === far.combat.hpMax, 'far ship should be untouched');
    },
  },
  {
    name: 'hits on our ship hole decks, fault machinery, wound crew — and the reactor can go',
    fn: () => {
      const s = game(61);
      const ev = recorder();
      applyHit(s, PLAYER, { dp: 70, section: 'drive', kind: 'he', from: 'x' }, (t, p) => bus.emit(t, p));
      const hit = ev['player-hit'][0];
      console.log(`      HE on the drive: integrity ${fmt(s.hull.integrity, 0)}%, breaches ${hit.effects.breaches.join(',') || '—'}, faults ${hit.effects.systems.join(', ') || '—'}`);
      assert(s.hull.integrity < 100, 'hull damage');
      assert(hit.effects.systems.length > 0 || hit.effects.breaches.length > 0, 'something should break');
      let lost = 0;
      for (let k = 0; k < 20; k++) {
        const t = game(500 + k);
        applyHit(t, PLAYER, { dp: 100, section: 'reactor', aim: 'kill', kind: 'slug', from: 'x' });
        if (t.lost || t.reactor.status === 'containment-failure') lost++;
      }
      console.log(`      100 DP kill shot on the reactor: ${lost}/20 lost the ship or the containment`);
      assert(lost >= 10, 'reactor hits should be dangerous');
    },
  },
  {
    name: 'our point defense, with a gunner at fire control, beats a pirate\'s torpedoes',
    fn: () => {
      let manned = 0, auto = 0;
      const trials = 12;
      for (const gunnerOn of [true, false]) {
        for (let k = 0; k < trials; k++) {
          const s = game(600 + k);
          const ev = recorder();
          s.combatStations = gunnerOn;
          advance(s, 60);                     // in free fall it takes a while to get forward from the bunks
          assert(!!gunner(s) === gunnerOn, `gunner at the console: ${!!gunner(s)}`);
          const { pos, vel } = near(s, 0.002);
          // an inert launcher: it fires this one torpedo and does nothing else
          const p = spawnAgent(s, { role: 'convoy', cls: 'pirate-raider', faction: 'pirate', pos, vel });
          launchTorpedo(s, p.id, PLAYER, { warhead: 'he', profile: 'fast' }, (t, x) => bus.emit(t, x));
          untilQuiet(s, 6 * 60);
          const got = (ev['torpedo-intercepted'] || []).length;
          if (gunnerOn) manned += got; else auto += got;
        }
      }
      console.log(`      pirate HE torpedo at us: intercepted ${manned}/${trials} with a gunner, ${auto}/${trials} on automatic`);
      assert(manned >= auto, 'a gunner should not make the PDCs worse');
      assert(manned >= trials * 0.5, 'point defense should stop most single TL1–2 torpedoes');
    },
  },
  {
    name: 'fire control: torpedoes from tubes, magazine and reload; firing on a lawful ship is a crime',
    fn: () => {
      const s = game(71);
      const ev = recorder();
      s.sensors.range = 2;
      const { pos, vel } = near(s, 0.003);
      const e = spawnAgent(s, { role: 'civilian', cls: 'freighter', faction: 'OPA', pos, vel });
      sensorsTick(s);
      assert(setFireTarget(s, e.id).ok, 'target lock');
      const a = fireTorpedo(s, { warhead: 'he' }, (t, p) => bus.emit(t, p));
      const b = fireTorpedo(s, { warhead: 'he' }, (t, p) => bus.emit(t, p));
      const c = fireTorpedo(s, { warhead: 'he' }, (t, p) => bus.emit(t, p));
      assert(a.ok && b.ok && !c.ok, `two tubes, two torpedoes in the magazine: ${a.text} / ${b.text} / ${c.text}`);
      assert(s.magazine.he === 0, 'magazine spent');
      assert(s.law.wanted.OPA >= 1 && s.law.standing.OPA < 10, 'crime recorded');
      assert(e.agent.mode === 'flee', 'the victim runs');
      console.log(`      crime: ${ev.crime.map(c => `${c.kind} → ${c.factions.join('/')}`).join(', ')}; OPA standing ${s.law.standing.OPA}, wanted ${s.law.wanted.OPA}`);
    },
  },
  {
    name: 'a patrol stops a suspect ship, searches it, and seizes contraband',
    fn: () => {
      const s = game(81);
      const ev = recorder();
      s.law.wanted.OPA = 1;
      s.cargo.push({ contract: 'c-x', name: 'unregistered weapons', mass: 500, contraband: true, illegalIn: ['OPA'] });
      const { pos, vel } = near(s, 0.0015);
      spawnAgent(s, { role: 'patrol', cls: 'cutter', faction: 'OPA', pos, vel });
      let t = 0;
      while (t < 2 * DAY_MIN && !ev['inspection-complete']) {
        advance(s, 1); t++;
        const r = s.comms.requests[0];
        if (r?.kind === 'inspect') respondToRequest(s, r.id, 'comply', (x, p) => bus.emit(x, p));
      }
      const done = ev['inspection-complete']?.[0];
      console.log(`      hailed after ${ev['comm-request'] ? 'a request' : 'no request'}, searched in ${fmt(t / 60)}h: ${done?.text}`);
      assert(done, 'inspection should complete');
      assert(!s.cargo.some(c => c.contraband), 'contraband seized');
      assert(s.law.wanted.OPA === 0, 'record settled (we could pay)');
    },
  },
  {
    name: 'a pirate makes its demand; paying sends it away',
    fn: () => {
      const s = game(91);
      const ev = recorder();
      const { pos, vel } = near(s, 0.003);
      const p = spawnAgent(s, { role: 'pirate', cls: 'pirate-gunship', faction: 'pirate', pos, vel, transponder: false });
      const credits0 = s.resources.credits.current;
      let t = 0;
      while (t < DAY_MIN && !ev['pirates-paid']) {
        advance(s, 1); t++;
        const r = s.comms.requests[0];
        if (r?.kind === 'demand') respondToRequest(s, r.id, 'pay', (x, q) => bus.emit(x, q));
      }
      console.log(`      demand after ${fmt(t / 60)}h; paid ${credits0 - s.resources.credits.current} MCR; pirate now ${p.agent?.mode}`);
      assert(ev['pirates-paid'], 'the pirate should demand and be paid');
      assert(p.agent.mode === 'leave', 'and leave');
    },
  },
  {
    name: 'a disabled pirate offers its surrender',
    fn: () => {
      const s = game(95);
      const ev = recorder();
      const { pos, vel } = near(s, 0.002);
      const p = spawnAgent(s, { role: 'pirate', cls: 'pirate-raider', faction: 'pirate', pos, vel });
      p.agent.hostile.push(PLAYER); p.agent.mode = 'engage'; p.agent.target = PLAYER;
      ensureHull(p).drive = 0.1;
      advance(s, 2);
      const r = s.comms.requests.find(x => x.kind === 'surrender');
      assert(r, 'a surrender request');
      respondToRequest(s, r.id, 'accept');
      assert(p.combat.status === 'surrendered', 'struck colours');
    },
  },
  {
    name: 'saves carry ordnance, agents and politics; v0.9 saves are refitted with weapons',
    fn: () => {
      const s = game(97);
      const { pos, vel } = near(s, 0.01);
      const e = spawnAgent(s, { role: 'civilian', cls: 'freighter', faction: 'OPA', pos, vel });
      launchTorpedo(s, PLAYER, e.id, { warhead: 'he', profile: 'cold' });
      advance(s, 30);
      const back = deserialize(serialize(s)).state;
      const w = getWorld(back);
      const torp = [...w.driven].find(x => x.type === 'ordnance');
      assert(torp && torp.ord.target === e.id, 'torpedo survives the round trip');
      assert([...w.driven].some(x => x.id === e.id && x.agent), 'agent survives');
      advance(back, 30);

      const old = JSON.parse(serialize(game(98)));
      old.schema = 3;
      for (const k of ['combat', 'magazine', 'hull', 'law', 'politics']) delete old[k];
      delete old.resources.pdcRounds; delete old.systems.units.pdc; delete old.systems.units.launcher;
      delete old.ship.classId; delete old.ship.tl;
      for (const x of old.entities) { if (x.faction === 'OPA') x.faction = 'Belter'; delete x.cls; }
      const m = deserialize(old);
      assert(m.migrated, 'migrated');
      assert(m.state.combat && m.state.magazine.capacity > 0 && m.state.systems.units.pdc, 'weapons fitted');
      assert(!m.state.entities.some(x => x.faction === 'Belter'), 'factions renamed');
      assert(m.state.ship.decks.some(d => d.tiles.some(r => r.includes(28))), 'PDC turrets in the layout');
      advance(m.state, 60);
    },
  },
];
