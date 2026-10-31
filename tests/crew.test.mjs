// Crew behaviour: medicine, rescue chain, inertial events, life support.
import { addBurn, hasCondition, addCondition, needsMedical, needsHospital, woundCap, applyImpact, isAboard, SEVERE_BURN } from '../js/sim/crew.js';
import { careAt, patientsHere, quote, admit, discharge, treatment } from '../js/sim/hospital.js';
import { treatmentFor } from '../js/sim/ground.js';
import { dockedPort } from '../js/sim/contracts.js';
import { undock } from '../js/sim/docking.js';
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { triggerManeuver, updateInertia, isInertiaActive, Maneuver } from '../js/sim/inertia.js';
import { shipGeometry, isRestraint } from '../js/sim/ship-layout.js';
import { setBreach } from '../js/sim/life-support.js';
import { planRoutes } from '../js/sim/nav.js';
import { engageRoute, engageStance, overrideSecure, forceTurn } from '../js/sim/autopilot.js';
import { createStance } from '../js/sim/stance.js';
import { spawnAgent } from '../js/sim/agents.js';
import { getWorld } from '../js/sim/world.js';
import { sensorsTick } from '../js/sim/sensors.js';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { orderShutdown, orderStartup, ReactorState } from '../js/sim/reactor.js';
import { forceDistress } from '../js/sim/missions.js';
import { protectedG, physiologyTick } from '../js/sim/crew.js';
import { efficiency } from '../js/sim/needs.js';
import { fuelUsed } from '../js/sim/flight.js';
import { createPlan, STANDOFF } from '../js/sim/nav.js';

function game(seed = 1, crewCount = 6) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount });
  s.politics.quietUntil = Infinity;     // no patrols or pirates turning up mid-test
  return s;
}

/** A docked crew at `home` with nothing else going on. */
function medGame(home = 'ceres-station', seed = 9) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 8, traffic: 0, forces: false, home });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

export default [
  {
    name: 'burns are the autodoc\'s to heal; severe burns and deep trauma it can only hold, and left alone they kill; a hospital finishes them, in days, the ship waiting; the brain wants a full one',
    fn: () => {
      // a light burn: into the autodoc on their own, and gone
      const s = medGame();
      const m = s.ship.crew.find(x => x.role === 'Deckhand') || s.ship.crew[3];
      addBurn(m, 15);
      assert(hasCondition(m, 'burned') && needsMedical(m), 'a burn wants the autodoc, whatever the rest of them reads');
      let t = 0;
      while (t < 12 * 60 && m.burns > 0) { advance(s, 1); t++; }
      assert(m.burns === 0 && !hasCondition(m, 'burned'), `healed (${fmt(m.burns, 1)} left after ${t} min)`);
      console.log(`      a light burn healed aboard in ${fmt(t / 60, 1)} h`);

      // severe: the autodoc holds it, and that is all
      const v = medGame(), p = v.ship.crew.find(x => x.role === 'Deckhand') || v.ship.crew[3];
      addBurn(p, 60);
      p.body.torso = 30; p.body.leftArm = 40;
      assert(hasCondition(p, 'severe-burns') && !hasCondition(p, 'burned') && needsHospital(p) && !p.stabilized, 'severe');
      for (let i = 0; i < 3 * DAY_MIN && !p.stabilized; i++) advance(v, 1);
      assert(p.stabilized && p.burns === SEVERE_BURN, `stabilized, its burns at ${fmt(p.burns, 0)}`);
      assert(p.body.torso >= 69 && p.body.torso <= 70.01, `the body back as far as it comes (${fmt(p.body.torso, 0)}%)`);
      assert(!needsMedical(p), 'and off the bed, not back on it');
      const h0 = p.heart.health;
      for (let i = 0; i < 2 * DAY_MIN; i++) advance(v, 1);
      assert(p.body.torso <= 70.01 && p.burns === SEVERE_BURN && needsHospital(p) && p.heart.health >= h0 - 1 && !p.dead, 'held, and no further');

      // left alone, it kills: about two days
      const k = medGame(), q = k.ship.crew.find(x => x.role === 'Deckhand') || k.ship.crew[3];
      addBurn(q, 60);
      let d = 0;
      const physio = () => { d++; physiologyTick(q, 1, 1); };
      while (!q.dead && d < 6 * DAY_MIN) physio();
      assert(q.dead && d > DAY_MIN && d < 4 * DAY_MIN, `unheld, ${fmt(d / DAY_MIN, 1)} days`);
      console.log(`      severe burns unheld: dead in ${fmt(d / DAY_MIN, 1)} days`);

      // deep trauma, from a crushing blow, the same
      const r = medGame(), w = r.ship.crew.find(x => x.role === 'Deckhand') || r.ship.crew[3];
      applyImpact(w, 10);
      assert(hasCondition(w, 'deep-trauma') && woundCap(w) === 70 && needsHospital(w), 'deep trauma');

      // a clinic at a station: a stay, the ship waiting, the berth held
      const c = medGame('hygiea-ring'), n = c.ship.crew.find(x => x.role === 'Deckhand') || c.ship.crew[3];
      addBurn(n, 60); n.stabilized = true;
      c.resources.credits.current = 50_000;
      const st = dockedPort(c);
      assert(careAt(st) === 'clinic' && patientsHere(c, st).includes(n), 'a clinic takes burns');
      const qt = quote(c, n, st);
      assert(qt.minutes >= 7 * DAY_MIN && qt.minutes <= 12 * DAY_MIN, `days of grafts (${fmt(qt.minutes / DAY_MIN, 1)})`);
      const money = c.resources.credits.current;
      assert(admit(c, n.id).ok, 'admitted');
      assert(c.resources.credits.current === money - qt.cost - qt.berth, 'the bill and the berth paid');
      assert(n.away?.hospital && !isAboard(n), 'off the ship');
      assert(!undock(c).ok, 'we wait for them');
      for (let i = 0; i < qt.minutes + 3; i++) advance(c, 1);
      assert(!n.away && !n.burns && !hasCondition(n, 'severe-burns') && n.body.torso === 100 && !needsHospital(n), `mended (${n.conditions})`);
      assert(c.dock?.phase === 'docked' && !(c.law.citations || []).length, 'the berth held for the stay');
      console.log(`      severe burns at a clinic: ${fmt(qt.minutes / DAY_MIN, 1)} days, ${qt.cost.toLocaleString()} MCR and ${qt.berth.toLocaleString()} MCR of berth`);

      // discharged early: as they went, the rest back
      const e = medGame('hygiea-ring'), o = e.ship.crew.find(x => x.role === 'Deckhand') || e.ship.crew[3];
      addBurn(o, 60); o.stabilized = true;
      e.resources.credits.current = 50_000;
      admit(e, o.id);
      for (let i = 0; i < 1440; i++) advance(e, 1);
      assert(discharge(e, o.id).ok, 'discharged');
      advance(e, 1); advance(e, 1);
      assert(!o.away && hasCondition(o, 'severe-burns') && needsHospital(o), 'still burned');

      // the brain: a clinic won't, a full hospital will, and a world's clinic the same
      const b = medGame('hygiea-ring'), u = b.ship.crew.find(x => x.role === 'Deckhand') || b.ship.crew[3];
      addCondition(u, 'brain-damage');
      assert(quote(b, u, dockedPort(b))?.refused && !patientsHere(b).includes(u), 'a clinic can\'t');
      assert(treatment(u, 'full').brain && treatment(u, 'full').minutes === 14 * DAY_MIN, 'a full hospital can');
      assert(treatmentFor(u, 'Ganymede').untreatable && treatmentFor(u, 'Mars').brain, 'nor a world\'s clinic, and a big world\'s hospital can');
      // a world's ground takes burns too
      addBurn(u, 50);
      assert(treatmentFor(u, 'Ganymede').cost > 0 && /burn/.test(treatmentFor(u, 'Ganymede').text), 'burns at a world\'s clinic');

      // a command ship's sick bay
      assert(careAt({ id: 'cmd', tags: { command: { body: 'Ganymede' } } }) === 'clinic', 'a forward base has a sick bay');

      // an old save: the burned tag that nothing took off
      const a = medGame(), g = a.ship.crew.find(x => x.role === 'Deckhand') || a.ship.crew[3];
      addCondition(g, 'burned'); delete g.burns;
      const back = deserialize(serialize(a)).state, g2 = back.ship.crew.find(x => x.id === g.id);
      assert(g2.burns === 20 && needsMedical(g2), 'light burns, the autodoc\'s to heal');
    },
  },
  {
    name: 'unconscious crew: medic stabilizes, carries to autodoc, patient heals',
    fn: () => {
      const s = game(2);
      advance(s, 30);
      const patient = s.ship.crew.find(m => m.role === 'Gunner');
      patient.consciousness = 10;
      patient.heart.health = 0;          // cardiac arrest → critical
      patient.body.torso = 40;
      const seen = [];
      bus.on('*', (t) => seen.push(t));
      advance(s, 1);
      assert(patient.conditions.includes('critical'), 'should be critical');
      let t = 0;
      while (t < 600 && !(patient.seat || '').startsWith('medbay')) { advance(s, 1); t++; }
      assert(!patient.dead, `patient died after ${t} min (deathTimer ran out before the medic arrived?)`);
      assert(patient.seat?.startsWith('medbay'), `not in autodoc after ${t} min`);
      assert(seen.includes('crew-stabilized') && seen.includes('crew-delivered'), 'rescue chain events');
      advance(s, 600);
      console.log(`      in autodoc after ${t} min; after 10h: torso ${fmt(patient.body.torso)} heart ${fmt(patient.heart.health)} conscious ${fmt(patient.consciousness)}`);
      assert(patient.body.torso > 90 && patient.consciousness > 50, 'should be recovering');
    },
  },
  {
    name: 'surprise burn throws unsecured crew; strapped-in crew are safe',
    fn: () => {
      const s = game(3);
      advance(s, 20);
      const geo = shipGeometry(s.ship);
      const strapped = s.ship.crew[1];
      strapped.seat = geo.fixtures.couch[0].id;
      const before = s.ship.crew.map(m => m.body.torso);
      const loose = s.ship.crew.filter(m => !isRestraint(m.seat)).length;   // sleepers in bunks are strapped in too
      const n = triggerManeuver(s, Maneuver.BURN_START, { deltaG: 3, surprise: true, gForce: 3 });
      assert(loose > 0 && n === loose, `expected ${loose} bodies in motion, got ${n}`);
      let hits = [];
      for (let i = 0; i < 1000 && isInertiaActive(s); i++) hits = hits.concat(updateInertia(s, 1 / 60));
      assert(!isInertiaActive(s), 'slide never resolved');
      assert(hits.length > 0, 'nobody hit anything');
      assert(strapped.body.torso === before[1], 'strapped crew must be unharmed');
      console.log(`      ${hits.map(h => `${h.member.name}: ${h.severity} @${fmt(h.speed)}m/s`).join('; ')}`);
      // positions are back on walkable tiles and the sim continues
      advance(s, 30);
      for (const m of s.ship.crew) assert(Number.isFinite(m.pos.sx) && Number.isFinite(m.pos.sy), 'bad position');
    },
  },
  {
    name: 'hull breach: crew suit up and survive',
    fn: () => {
      const s = game(4);
      advance(s, 10);
      const deck = 2;   // mess
      for (const m of s.ship.crew) { m.homeDeck = deck; }
      advance(s, 120);  // everyone wanders to the mess
      setBreach(s, deck, true);
      advance(s, 60);
      const onDeck = s.ship.crew.filter(m => shipGeometry(s.ship).deckOfRow(m.pos.sy) === deck);
      console.log(`      ${s.ship.crew.filter(m => m.suit.wearing).length} suited, pressure ${fmt(s.ship.decks[deck].atmosphere.pressure)} kPa, ${onDeck.length} on deck`);
      assert(s.ship.crew.every(m => !m.dead), 'someone died');
      assert(s.ship.crew.some(m => m.suit.wearing), 'nobody suited up');
    },
  },
  {
    name: 'reactor shutdown and restart need an engineer at the reactor',
    fn: () => {
      const s = game(5);
      advance(s, 5);
      assert(orderShutdown(s).success, 'order shutdown');
      advance(s, 60);
      const eng = s.ship.crew.find(m => m.task?.type === 'reactor');
      assert(eng && eng.task.phase === 'work', 'engineer should be working at the reactor');
      advance(s, 720 + 60 + 5);
      assert(s.reactor.status === ReactorState.OFFLINE, `reactor should be offline, is ${s.reactor.status}`);
      assert(orderStartup(s).success, 'order startup');
      advance(s, 400);
      assert(s.reactor.status === ReactorState.ONLINE, `reactor should be back online, is ${s.reactor.status}`);
    },
  },
  {
    name: 'express 3G trip with juice: one dose each (the flip is covered), hangover once it wears off',
    fn: () => {
      const s = game(6);
      const r = planRoutes(s, { kind: 'entity', id: 'pallas-station' }).find(o => o.name === 'EXPRESS');
      engageRoute(s, r.plan);
      let t = 0;
      while (s.autopilot && t < r.estimate.minutes + 3000) { advance(s, 1); t++; }
      const arrived = !s.autopilot;
      advance(s, 90);                     // the last dose wears off an hour after the burn
      const used = 50 - s.resources.medSupplies.current;
      const alive = s.ship.crew.filter(m => !m.dead).length;
      const hung = s.ship.crew.filter(m => m.conditions.includes('juice-hangover')).length;
      console.log(`      ${fmt(t / 1440, 2)}d, alive ${alive}/${s.ship.crew.length}, hangovers ${hung}, med used ${fmt(used)}`);
      assert(arrived, 'did not arrive');
      assert(used <= s.ship.crew.length, `one standard dose per person for the whole trip, used ${used}`);
      assert(alive === s.ship.crew.length, 'crew died on an express run');
      assert(hung > 0, 'juice should leave a hangover');
    },
  },
  {
    name: 'autopilot never throws its own crew around (flips happen strapped in)',
    fn: () => {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const s = game(seed, 5);
        let offer = null;
        bus.on('sos-offered', p => { offer = p; });
        let thrown = 0;
        bus.on('inertia-start', p => { thrown += p.count; });
        forceDistress(s, (t, p) => bus.emit(t, p));
        offer.mission.status = 'accepted';
        engageRoute(s, createPlan('closing', { kind: 'entity', id: offer.mission.entityId }, { accelG: offer.feasibility.g, standoff: STANDOFF.TACTICAL }));
        for (let t = 0; t < 4000 && s.autopilot; t++) {
          minuteTick(s);
          while (isInertiaActive(s)) updateInertia(s, 0.05);
        }
        assert(!s.autopilot, `seed ${seed}: did not arrive`);
        assert(thrown === 0, `seed ${seed}: ${thrown} crew thrown during an autopilot intercept`);
      }
    },
  },
  {
    name: 'the nav computer holds a flip while anyone is on their feet; a stance flies its moves strapped in',
    fn: () => {
      // A stance taken with the crew about (the captain didn't wait): 30 km
      // from a hauler, the nose pointing away and opening at 200 m/s, so the
      // very first thing to do is flip
      const setup = (seed) => {
        const s = game(seed, 5);
        const world = getWorld(s);
        s.flight.hold = null;
        s.flight.pos.x += 0.02;              // (open space, away from Ceres' pull and ground)
        const { x, y } = s.flight.pos;
        const e = spawnAgent(s, { role: 'civilian', cls: 'mule', pos: { x: x + 30_000 / AU_M, y }, vel: { ...s.flight.vel }, transponder: true });
        s.flight.facing = Math.PI;
        s.flight.vel.vx -= 200;
        sensorsTick(s);
        engageStance(s, createStance({ kind: 'entity', id: e.id }, { mode: 'hold', rangeM: 2_000, accelG: 1 }));
        overrideSecure(s);
        const ev = { held: 0, forced: 0, thrown: 0, heldMin: 0 };
        bus.on('turn-held', () => { ev.held++; });
        bus.on('turn-forced', () => { ev.forced++; });
        bus.on('inertia-start', p => { ev.thrown += p.count; });
        return { s, ev, world };
      };
      const fly = ({ s, ev }, minutes, each = () => {}) => {
        for (let t = 0; t < minutes; t++) {
          minuteTick(s);
          while (isInertiaActive(s)) updateInertia(s, 0.05);
          if (s.autopilot?.turnHeld != null) ev.heldMin++;
          each(t);
        }
      };
      for (const seed of [1, 2, 3]) {
        const run = setup(seed);
        fly(run, 240);
        console.log(`      seed ${seed}: flip held ${run.ev.heldMin} min · ${run.ev.thrown} thrown · on station: ${!!run.s.autopilot?.settled}`);
        assert(run.ev.held >= 1 && run.ev.heldMin <= 30, `seed ${seed}: the flip was not held for the crew (${JSON.stringify(run.ev)})`);
        assert(run.ev.thrown === 0, `seed ${seed}: ${run.ev.thrown} crew thrown`);
        assert(run.s.autopilot?.settled, `seed ${seed}: never got on station`);
      }
      // The captain's call: flip now, whoever is up
      const run = setup(1);
      fly(run, 3, (t) => { if (t === 0) forceTurn(run.s); });
      assert(run.ev.forced === 1 && run.ev.heldMin <= 1, `the captain's FLIP NOW waited (${JSON.stringify(run.ev)})`);
    },
  },
  {
    name: 'juice shows in the vitals; high dose costs more and protects more',
    fn: () => {
      const s = game(9, 2);
      const [a, b] = s.ship.crew;
      const res = s.resources;
      const effA = protectedG(a, 3, true, res); physiologyTick(a, effA, 3);
      const used1 = 50 - res.medSupplies.current;
      const effB = protectedG(b, 10, true, res); physiologyTick(b, effB, 10);
      const used2 = 50 - res.medSupplies.current - used1;
      console.log(`      3G juiced: eff ${fmt(effA, 2)}G bpm ${a.heart.bpm} BP ${a.heart.bpSystolic}/${a.heart.bpDiastolic} · 10G high dose: eff ${fmt(effB, 2)}G bpm ${b.heart.bpm} · doses ${used1}/${used2}`);
      assert(a.heart.bpm > 110 && a.heart.bpSystolic > 140, 'juiced crew should show elevated vitals');
      assert(b.juiceDose === 'high' && used2 === 2 && effB < 2.5, 'high dose: 2 supplies, effective G below dangerous');
      assert(fuelUsed(10, 0) > 10 * fuelUsed(1, 0), 'overdrive should cost extra reaction mass');
    },
  },
  {
    name: 'FLANK 10G is offered only at battle stations, and short dashes are survivable',
    fn: () => {
      const s = game(10, 4);
      assert(!planRoutes(s, { kind: 'entity', id: 'vesta-depot' }).some(o => o.name === 'FLANK 10G'), 'flank must need battle stations');
      s.combatStations = true;
      let offer = null;
      bus.on('sos-offered', p => { offer = p; });
      forceDistress(s, (t, p) => bus.emit(t, p));
      const flank = planRoutes(s, { kind: 'entity', id: offer.entity.id }, { combat: true, standoff: STANDOFF.TACTICAL }).find(o => o.name === 'FLANK 10G');
      assert(flank && flank.estimate.arrived, 'flank option should plan');
      engageRoute(s, flank.plan);
      let t = 0;
      while (s.autopilot && t < 3000) { minuteTick(s); while (isInertiaActive(s)) updateInertia(s, 0.05); t++; }
      const arrived = !s.autopilot;
      const used = 50 - s.resources.medSupplies.current;
      // (the ship in distress may be a runaway torch: let go of it, so the juice can wear off)
      s.flight.hold = null;
      for (let k = 0; k < 90; k++) minuteTick(s);
      const hung = s.ship.crew.filter(m => m.juiceHangover > 4320 && m.juiceCrash).length;
      const eff = Math.max(...s.ship.crew.filter(m => !m.dead).map(efficiency));
      console.log(`      ${fmt(t / 60)}h dash, dead ${s.ship.crew.filter(m => m.dead).length}, crashed ${hung}, med used ${fmt(used)}, best efficiency after ${fmt(eff, 2)}, reactor ${s.reactor.status}`);
      assert(arrived, 'flank dash did not arrive');
      assert(used <= 2 * s.ship.crew.length, `a short high-dose dash costs 2 med each, used ${used}`);
      assert(eff <= 0.6, 'a high-dose crash should leave the crew working badly');
      assert(s.ship.crew.every(m => !m.dead), 'a short flank dash should not kill strapped-in crew');
      assert(hung > 0, 'high dose should leave a long hangover');
    },
  },
  {
    name: 'arrives at moon-orbiting stations (Luna, Ganymede)',
    fn: () => {
      for (const id of ['luna-yards', 'ganymede-station']) {
        const s = game(8);
        const r = planRoutes(s, { kind: 'entity', id }, { includeBallistic: false }).find(o => o.name === 'EXPRESS');
        assert(r.estimate.arrived, `${id}: planner found no arrival`);
        s.combatStations = false;
        engageRoute(s, r.plan);
        let t = 0;
        while (s.autopilot && t < r.estimate.minutes + 3000) { minuteTick(s); t++; }
        assert(!s.autopilot && s.flight.hold?.id === `${id}-gate`, `${id}: not holding at its gate after ${t} min`);
        console.log(`      ${id}: ${fmt(t / 1440, 2)} days`);
      }
    },
  },
];
