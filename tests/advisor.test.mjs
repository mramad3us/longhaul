// The ship's AI (ui/advisor.js): what it raises for staged situations, at
// what level and with which actions; its ordering; dismissals that hold and
// lapse; quiet in a calm port; read-only; and its cost on a full system.
import { assert, fmt } from './helpers.mjs';
import { DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { spawnAgent } from '../js/sim/agents.js';
import { launchTorpedo } from '../js/sim/ordnance.js';
import { PLAYER } from '../js/sim/combatants.js';
import { releaseHold, engageRoute } from '../js/sim/autopilot.js';
import { createPlan } from '../js/sim/nav.js';
import { triggerContainmentFailure } from '../js/sim/reactor.js';
import { setPhase } from '../js/sim/politics.js';
import { spawnZone } from '../js/sim/conflict.js';
import { commandShipFor } from '../js/sim/forces.js';
import { requestDocking } from '../js/sim/traffic-control.js';
import { advise, LEVELS, AI_NAME } from '../js/ui/advisor.js';

const ACT_TYPES = new Set(['plot', 'open', 'toggle', 'respond', 'hail', 'request-docking', 'request-departure', 'dock', 'undock', 'speed', 'select', 'order']);

function game(opts = {}, seed = 31) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: true, crewCount: 4, traffic: 0, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** Out in the black, away from Ceres' traffic control and its pull. */
function outInTheBlack(s) {
  s.politics.zones = [];
  releaseHold(s);
  s.flight.pos.y += 0.02;
  advance(s, 1);
}

/** Every advisory is well formed: short text, at most 3 actions the UI knows how to run. */
function check(list) {
  for (const a of list) {
    assert(typeof a.key === 'string' && a.key, 'a key');
    assert(Object.values(LEVELS).includes(a.level), `a level: ${a.level}`);
    assert(a.text.length <= 90, `text ≤ 90 chars: "${a.text}" (${a.text.length})`);
    assert(Array.isArray(a.actions) && a.actions.length <= 3, `≤ 3 actions: ${a.key}`);
    for (const x of a.actions) assert(x.id && x.label && ACT_TYPES.has(x.act?.type), `a runnable action on ${a.key}: ${JSON.stringify(x)}`);
  }
  for (let i = 1; i < list.length; i++) assert(list[i - 1].level >= list[i].level, `ordered by level: ${list.map(a => a.level).join(',')}`);
  assert(list.length <= 8, 'at most 8');
  assert(new Set(list.map(a => a.key)).size === list.length, 'keys are unique');
  return list;
}

const byKey = (list, key) => list.find(a => a.key === key);
const show = (list) => list.map(a => `[${a.level}] ${a.key}: ${a.text}${a.actions.length ? ` {${a.actions.map(x => x.label).join(' | ')}}` : ''}`).join('\n      ');
/** The state as a save would hold it (runtime $ keys left out). */
const snap = (s) => JSON.stringify(s, (k, v) => (k.startsWith('$') ? undefined : v));

export default [
  {
    name: `${AI_NAME}: a calm docked game gets advice or info, nothing louder`,
    fn: () => {
      const s = game();
      advance(s, 20);
      const mem = {};
      const list = check(advise(s, mem));
      console.log(`      docked at Ceres:\n      ${show(list)}`);
      assert(list.length > 0, 'something to say (the board, or what we are doing)');
      assert(list.every(a => a.level <= LEVELS.advice), 'no caution or warning in a calm port');
      // Dismiss everything: what is left is what we are doing
      for (const a of list) mem.dismissed[a.key] = s.clock.minute;
      const quiet = check(advise(s, mem));
      assert(quiet.length === 1 && quiet[0].key === 'status' && quiet[0].level === LEVELS.info, `then only the status line: ${show(quiet)}`);
      assert(/Docked at Ceres Station/.test(quiet[0].text), quiet[0].text);
    },
  },
  {
    name: 'inbound torpedo: a warning with its ETA, battle stations and the weapons board',
    fn: () => {
      const s = game({ docked: false });
      outInTheBlack(s);
      const p = s.flight.pos;
      const raider = spawnAgent(s, { role: 'pirate', kind: 'raider', faction: 'pirate', pos: { x: p.x - 0.0006, y: p.y }, vel: { ...s.flight.vel } });
      launchTorpedo(s, raider.id, PLAYER, { warhead: 'he', profile: 'fast' });
      minuteTick(s);
      const list = check(advise(s, {}));
      console.log(`      ${show(list)}`);
      const a = byKey(list, 'ordnance');
      assert(a && a.level === LEVELS.warning, 'torpedo warning');
      assert(list[0] === a, 'first on the line');
      assert(/torpedo inbound, first impact in/.test(a.text), a.text);
      assert(a.actions.some(x => x.act.type === 'toggle' && x.act.what === 'combat'), 'BATTLE STATIONS offered');
      assert(a.actions.some(x => x.act.type === 'open' && x.act.window === 'weapons'), 'WEAPONS offered');
      // At battle stations it isn't offered again; with the guns on HOLD, PDC AUTO is
      s.combatStations = true;
      s.combat.pdc = 'hold';
      const b = byKey(advise(s, {}), 'ordnance');
      assert(b && !b.actions.some(x => x.act.what === 'combat') && b.actions.some(x => x.act.type === 'order' && x.act.what === 'pdc-auto'), `PDC AUTO: ${JSON.stringify(b?.actions)}`);
    },
  },
  {
    name: 'fire, breach, a crewman dying, containment failing: warnings, each with its action',
    fn: () => {
      const s = game({ docked: false });
      outInTheBlack(s);
      const deck = s.ship.decks.findIndex(d => d.name === 'Engine');
      const di = deck >= 0 ? deck : s.ship.decks.length - 1;
      s.ship.decks[di].atmosphere.fire = { intensity: 0.4, since: s.clock.minute, cause: 'hit' };
      let list = check(advise(s, {}));
      const fire = byKey(list, 'fire');
      assert(fire && fire.level === LEVELS.warning && fire.text.includes(s.ship.decks[di].name), `fire: ${fire?.text}`);
      assert(fire.actions.some(x => x.act.type === 'toggle' && x.act.what === 'suits'), 'SUITS ON offered');
      s.ship.decks[0].atmosphere.breached = true;
      s.ship.crew[1].conditions.push('critical');
      s.ship.crew[1].deathTimer = 12;
      triggerContainmentFailure(s);
      list = check(advise(s, {}));
      console.log(`      ${show(list)}`);
      for (const k of ['fire', 'breach', 'crew-critical', 'containment']) assert(byKey(list, k)?.level === LEVELS.warning, `${k} is a warning`);
      assert(list[0].key === 'containment', `containment failure first: ${list[0].key}`);
      assert(byKey(list, 'containment').actions.some(x => x.act.type === 'order' && x.act.what === 'scram'), 'SCRAM offered');
      assert(/about 12 min/.test(byKey(list, 'crew-critical').text), byKey(list, 'crew-critical').text);
    },
  },
  {
    name: 'comm requests: a patrol\'s order to heave to and a pirate\'s demand, answered in one click',
    fn: () => {
      const s = game({ docked: false });
      outInTheBlack(s);
      s.law.wanted.OPA = 1;                 // (a suspect: the patrol comes to look)
      const p = s.flight.pos;
      spawnAgent(s, { role: 'patrol', category: 'authority', faction: 'OPA', pos: { x: p.x + 0.0015, y: p.y }, vel: { ...s.flight.vel } });
      for (let i = 0; i < 120 && !s.comms.requests.length; i++) minuteTick(s);
      const r = s.comms.requests[0];
      assert(r?.kind === 'inspect', 'the patrol hailed us');
      // and a pirate's ultimatum, shaped as agents.js makes them
      const now = s.clock.minute;
      s.comms.requests.push({ id: 'rq-99', kind: 'demand', from: 'pirate-x', fromName: 'Black Lantern', faction: 'pirate', text: '…', options: [{ id: 'pay', label: 'PAY 1,500 MCR' }, { id: 'refuse', label: 'REFUSE' }], at: now - 10, expires: now + 5 });
      const list = check(advise(s, {}));
      console.log(`      ${show(list)}`);
      const inspect = byKey(list, `request:${r.id}`), demand = byKey(list, 'request:rq-99');
      assert(inspect?.level === LEVELS.caution && /heave to for inspection \(\d+ min\)/.test(inspect.text), inspect?.text);
      assert(inspect.actions.map(x => x.act.option).join() === 'comply,refuse' && inspect.actions.every(x => x.act.type !== 'respond' || x.act.request === r.id), 'HEAVE TO / RUN');
      assert(/demands 1,500 MCR/.test(demand.text) && demand.actions.some(x => x.act.type === 'hail'), demand.text);
      assert(list.indexOf(demand) < list.indexOf(inspect), 'the one that expires sooner comes first');
      assert(/Silence/.test(inspect.detail), 'says what silence means');
    },
  },
  {
    name: 'orders: a contractor called up is offered the command ship, alongside',
    fn: () => {
      const s = game({ docked: false, traffic: 40, license: 'UN', classId: 'unn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'UN', 'MCR', 'war');
      const z = spawnZone(s, { body: 'Ganymede', kind: 'front', factions: ['UN', 'MCR'], w: 1 });
      const ship = commandShipFor(s, z.id, 'UN');
      assert(ship, 'a command ship was sent');
      s.service.callups.push({ zoneId: z.id, faction: 'UN', ship: ship.id, shipName: ship.name, body: z.body, kind: z.kind, post: ship.id, at: s.clock.minute, heardAt: s.clock.minute, heard: true, reported: false, over: false });
      const list = check(advise(s, {}));
      const a = byKey(list, `callup:${z.id}`);
      console.log(`      ${a?.text}`);
      assert(a?.level === LEVELS.caution, 'a caution');
      const plot = a.actions.find(x => x.act.type === 'plot');
      assert(plot && plot.act.target.id === ship.id && plot.act.dock === true, 'plot alongside the command ship');
      s.service.callups[0].reported = true;
      assert(!byKey(advise(s, {}), `callup:${z.id}`), 'reported: nothing more to say');
    },
  },
  {
    name: 'the port: lease running out, low stores, an unlicensed hull, waiting at the gate, a clearance unused',
    fn: () => {
      const s = game({ classId: 'unn-corvette' });
      advance(s, 5);
      s.dock.lease = { from: s.clock.minute - 300, until: s.clock.minute + 40, paid: 0, warned: 0, cited: 0 };
      s.resources.food.current = 5;         // 4 mouths: about 20 hours
      let list = check(advise(s, {}));
      console.log(`      ${show(list)}`);
      const lease = byKey(list, 'lease');
      assert(lease?.level === LEVELS.caution && /runs out in 40 min/.test(lease.text), lease?.text);
      assert(lease.actions.some(x => x.act.type === 'open' && x.act.window === 'station' && x.act.tab === 'berth'), 'EXTEND → the berth tab');
      assert(lease.actions.some(x => x.act.type === 'request-departure'), 'or clear to depart');
      const food = byKey(list, 'stores:food');
      assert(food?.level === LEVELS.caution && food.actions.some(x => x.act.tab === 'services'), `food low: ${food?.text}`);
      assert(byKey(list, 'unlicensed')?.level === LEVELS.caution, 'a navy hull without its license');
      // Over the lease: cited
      s.dock.lease.until = s.clock.minute - 90;
      assert(/over our berth lease/.test(byKey(advise(s, {}), 'lease').text), 'over the lease');
      // Holding at a gate awaiting clearance: ask for it
      const g = game({ docked: false });
      advance(g, 2);
      g.dock = { target: { kind: 'station', id: 'ceres-station' }, berth: null, port: null, mode: 'auto', phase: 'awaiting', rel: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, t: 0, since: g.clock.minute, timer: 0, bumps: 0, fuel: 0, rate: 3 };
      list = check(advise(g, {}));
      const dc = byKey(list, 'dock-clearance');
      assert(dc?.level === LEVELS.caution && dc.actions[0].act.type === 'request-docking' && dc.actions[0].act.id === 'ceres-station', `request docking: ${dc?.text}`);
      // Cleared, and not docking: one click to go in
      g.dock = null;
      assert(requestDocking(g, 'ceres-station').ok, 'clearance granted');
      const cl = byKey(check(advise(g, {})), 'cleared:ceres-station');
      assert(cl && cl.actions[0].act.type === 'dock' && /Cleared to dock at Ceres Station/.test(cl.text), `DOCK offered: ${cl?.text}`);
    },
  },
  {
    name: 'a route: securing for the burn waits on the crew (EXECUTE offered), then the status line says where we are going',
    fn: () => {
      const s = game({ docked: false });
      outInTheBlack(s);
      const plan = createPlan('closing', { kind: 'entity', id: 'vesta-depot' }, { accelG: 1, standoff: 1000, name: 'TEST' });
      engageRoute(s, plan, { estimate: { minutes: 6000, fuel: 300 } });
      const ap = s.autopilot;
      ap.createdAt = s.clock.minute - 5;
      ap.secure = { secured: 1, total: 4, pilotReady: true, pilot: s.ship.crew[1].name, helpless: 0 };
      let list = check(advise(s, {}));
      const sec = byKey(list, 'secure');
      assert(sec?.level === LEVELS.caution && /3 hands still on their feet/.test(sec.text), sec?.text);
      assert(sec.actions.some(x => x.act.type === 'order' && x.act.what === 'execute'), 'EXECUTE NOW');
      // Under way, nothing else to say: the status line
      ap.phase = 'active'; ap.engagedAt = s.clock.minute; ap.display = 'coast'; ap.flipIn = 200;
      list = check(advise(s, {}));
      console.log(`      ${show(list)}`);
      const st = byKey(list, 'status');
      assert(st && /Coasting to Vesta Depot, flip in 3h 20m/.test(st.text), st?.text);
      assert(st.actions.some(x => x.act.type === 'select'), 'show on the map');
      // The fuel for it: 50 kg of the planned 300 burned, 100 kg left
      s.resources.fuel.current = 100;
      ap.fuelStart = 150;
      const rf = byKey(advise(s, {}), 'route-fuel');
      assert(rf?.level === LEVELS.warning && /reaction mass/.test(rf.text), 'not enough reaction mass to finish');
      // …and whatever the plan says, braking off 2,000 km/s takes about 170 kg
      ap.fuelStart = 100 + 300;
      assert(!byKey(advise(s, {}), 'route-fuel'), 'the plan is covered');
      ap.relSpeed = 2e6;
      assert(byKey(advise(s, {}), 'route-fuel'), 'the Δv to stop is not');
    },
  },
  {
    name: 'dismissal: a dismissed advisory stays quiet, comes back when the situation changes, goes away, or the quiet lapses',
    fn: () => {
      const s = game({ docked: false });
      outInTheBlack(s);
      const mem = {};
      const decks = s.ship.decks;
      decks[0].atmosphere.fire = { intensity: 0.3, since: s.clock.minute, cause: 'hit' };
      assert(byKey(advise(s, mem), 'fire'), 'fire raised');
      mem.dismissed.fire = s.clock.minute;
      assert(!byKey(advise(s, mem), 'fire'), 'dismissed: quiet');
      decks[0].atmosphere.fire.intensity = 0.6;
      assert(!byKey(advise(s, mem), 'fire'), 'the same fire growing is no news');
      // Another deck catches: news
      decks[1].atmosphere.fire = { intensity: 0.2, since: s.clock.minute, cause: 'spread' };
      assert(byKey(advise(s, mem), 'fire'), 'a second deck burning is news');
      // Dismissed again; the quiet for a warning lapses in half an hour
      mem.dismissed.fire = s.clock.minute;
      assert(!byKey(advise(s, mem), 'fire'), 'quiet again');
      s.clock.minute += 31;
      assert(byKey(advise(s, mem), 'fire'), 'back after the quiet');
      // A caution dismissed, gone for a while, and back: a new occurrence
      decks[0].atmosphere.fire = null; decks[1].atmosphere.fire = null;
      const now = s.clock.minute;
      s.comms.requests.push({ id: 'rq-5', kind: 'surrender', from: 'x', fromName: 'Skiff', faction: 'pirate', text: '…', options: [{ id: 'accept', label: 'ACCEPT SURRENDER' }, { id: 'ignore', label: 'IGNORE' }], at: now, expires: now + 15 });
      s.ship.crew[2].conditions.push('critical');
      s.ship.crew[2].deathTimer = 30;
      assert(byKey(advise(s, mem), 'crew-critical'), 'raised');
      mem.dismissed['crew-critical'] = s.clock.minute;
      assert(!byKey(advise(s, mem), 'crew-critical'), 'quiet');
      // Still there at every call: the same situation, still quiet; a flicker is no new occurrence
      for (let i = 0; i < 4; i++) { s.clock.minute += 4; assert(!byKey(advise(s, mem), 'crew-critical'), 'quiet while it lasts'); }
      s.ship.crew[2].conditions = [];
      advise(s, mem);                       // (a call finds it gone)
      s.clock.minute += 5;
      s.ship.crew[2].conditions.push('critical');
      assert(!byKey(advise(s, mem), 'crew-critical'), 'a flicker is not a new occurrence');
      // A caution (quiet 6 h): held across calls an hour apart (time warp), back once gone and returned
      const rq = 'request:rq-5';
      const offer = s.comms.requests.find(r => r.id === 'rq-5');
      offer.expires = s.clock.minute + 2 * DAY_MIN;
      assert(byKey(advise(s, mem), rq), 'the surrender offer');
      mem.dismissed[rq] = s.clock.minute;
      for (let i = 0; i < 4; i++) { s.clock.minute += 60; assert(!byKey(advise(s, mem), rq), `quiet after ${i + 1} h`); }
      s.comms.requests = s.comms.requests.filter(r => r !== offer);
      advise(s, mem);                       // (gone)
      s.clock.minute += 31;
      s.comms.requests.push(offer);
      assert(byKey(advise(s, mem), rq), 'gone half an hour and back: raised again');
      // …and dismissed again, back when its 6 hours are up
      mem.dismissed[rq] = s.clock.minute;
      s.clock.minute += 5 * 60;
      assert(!byKey(advise(s, mem), rq), 'quiet at 5 h');
      s.clock.minute += 61;
      assert(byKey(advise(s, mem), rq), 'back after 6 h');
    },
  },
  {
    name: 'read-only: advising never touches the game state',
    fn: () => {
      const s = game();
      advance(s, 15);
      s.dock.lease = { from: s.clock.minute - 300, until: s.clock.minute + 20, paid: 0, warned: 0, cited: 0 };
      s.ship.decks[0].atmosphere.fire = { intensity: 0.3, since: s.clock.minute, cause: 'hit' };
      s.resources.parts.current = 0;
      s.law.fines.push({ id: 'fine-1', faction: 'OPA', station: 'ceres-station', kind: 'test', amount: 300, at: s.clock.minute - 6 * DAY_MIN });
      const before = snap(s);
      const mem = {};
      for (let i = 0; i < 5; i++) check(advise(s, mem));
      assert(snap(s) === before, 'state unchanged');
    },
  },
  {
    name: 'cost: a full system (3,000 traffic), well under half a millisecond a call',
    fn: () => {
      seedRandom(32);
      bus.clear();
      const s = createGame({ docked: true, crewCount: 4 });
      advance(s, 30);
      const mem = {};
      check(advise(s, mem));
      const N = 4000;
      let t0 = performance.now();
      for (let i = 0; i < N; i++) advise(s, mem);
      const docked = (performance.now() - t0) / N;
      // Out in the black among the traffic, with something going on
      releaseHold(s);
      s.dock = null;
      s.flight.pos.y += 0.02;
      advance(s, 5);
      s.ship.decks[0].atmosphere.fire = { intensity: 0.3, since: s.clock.minute, cause: 'hit' };
      check(advise(s, mem));
      t0 = performance.now();
      for (let i = 0; i < N; i++) advise(s, mem);
      const free = (performance.now() - t0) / N;
      console.log(`      ${getWorld(s).count ?? s.entities.length} entities · docked ${fmt(docked * 1000, 1)} µs a call · in the black ${fmt(free * 1000, 1)} µs a call`);
      assert(docked < 0.5 && free < 0.5, 'under 0.5 ms');
    },
  },
];
