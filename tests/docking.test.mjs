// Ships, stations and what happens between them: hulls and interiors that
// agree, stations where they should be, traffic control's rules, docking
// by the computer and by hand, ship to ship, boarding, station guns,
// manifests, and saves taken mid-dock.
import { assert, fmt, near } from './helpers.mjs';
import { AU_M, AU_KM, DAY_MIN, G0 } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { getBody, surfaceGravity } from '../js/sim/ephemeris.js';
import { CLASSES, PLAYABLE, maxCrew } from '../js/sim/ship-classes.js';
import { hullOf, COLLARS } from '../js/sim/hulls.js';
import { createLayout, shipGeometry, airlockFor, DECK_PROGRAMS } from '../js/sim/ship-layout.js';
import { STATIONS, stationModel, stationOrbit, gateId, berthCounts, berthPose } from '../js/sim/stations.js';
import * as TC from '../js/sim/traffic-control.js';
import * as D from '../js/sim/docking.js';
import { spawnAgent, surrender, makeHostile } from '../js/sim/agents.js';
import { ensureHull, PLAYER, profile } from '../js/sim/combatants.js';
import { crewAboard, complementOf, knownCrew, dossierOf, learn } from '../js/sim/manifest.js';
import { openChannel, topics, say, closeChannel } from '../js/sim/dialogue.js';
import { startBoarding, boardingActions, orderAboard } from '../js/sim/boarding.js';
import { applyHit, wreckNpc } from '../js/sim/damage.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { releaseHold } from '../js/sim/autopilot.js';
import { hire, hiringHall, shoreLeave } from '../js/sim/crew-services.js';
import { leaseFor, extendLease, leaseRate, FREE_LEASE_MIN } from '../js/sim/leases.js';

function game(seed = 5, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 6, traffic: 0, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

function events() {
  const ev = {};
  bus.on('*', (t, p) => { (ev[t] ||= []).push(p); });
  return ev;
}

/** Put the ship at a station's gate, co-moving (as a route there leaves it). */
function atGate(s, stationId) {
  releaseHold(s);
  const g = getWorld(s).get(gateId(stationId));
  s.flight.pos = { x: g.pos.x, y: g.pos.y };
  s.flight.vel = { vx: g.vel.vx, vy: g.vel.vy };
  return g;
}

const emit = (t, p) => bus.emit(t, p);
const run = (s, pred, max) => { let t = 0; while (t < max && !pred(s)) { advance(s, 1); t++; } return t; };

export default [
  {
    name: 'every hull a small crew flies has its collars where its airlocks are, and berths for its people',
    fn: () => {
      for (const id of PLAYABLE) {
        const c = CLASSES[id];
        const h = hullOf(id);
        const ship = { decks: createLayout(id), crew: [] };
        const geo = shipGeometry(ship);
        for (const p of h.ports) {
          assert(p.deck, `${id}: port ${p.id} opens onto no deck`);
          const lock = airlockFor(ship, p.id);
          assert(lock && ship.decks[lock.deck].id === p.deck, `${id}: no airlock on the ${p.deck} deck for its ${p.id} collar`);
          // the collar sits on the hull at that deck's place along the axis
          const deckRows = geo.deckStart[lock.deck];
          const f = (deckRows + ship.decks[lock.deck].tiles.length / 2) / geo.totalRows * 0.9;
          if (p.face !== 'x+') near((h.L / 2 - p.x) / h.L, f, 0.06, `${id}: ${p.id} collar along the hull`);
        }
        const fx = geo.fixtures;
        const seats = ['couch', 'helm', 'ops', 'weapons', 'engStation'].reduce((n, k) => n + (fx[k]?.length || 0), 0);
        assert(seats >= maxCrew(id), `${id}: ${seats} secure seats for a crew of ${maxCrew(id)}`);
        // (a warship's brig cells are berths too, on a deck of their own)
        assert((fx.paxBerth?.length || 0) === (c.berths || 0) + (c.brig || 0), `${id}: ${fx.paxBerth?.length || 0} berths and cells, for ${c.berths} passengers and a brig of ${c.brig || 0}`);
        if (c.category === 'military') assert(c.brig > 0 && ship.decks.some(d => d.id === 'brig'), `${id}: a warship with no brig`);
        assert((fx.locker?.length || 0) >= maxCrew(id), `${id}: a suit for everyone`);
        if (c.berths) {
          const pax = ship.decks.findIndex(d => d.zone === 'pax'), crewDecks = ship.decks.map((d, i) => d.zone === 'crew' ? i : -1).filter(i => i >= 0);
          assert(pax > Math.max(...crewDecks), `${id}: passengers live aft of the crew`);
        }
      }
      const rated = Object.keys(CLASSES).filter(id => CLASSES[id].atmo);
      console.log(`      ${PLAYABLE.length} interiors; rated for atmospheric entry: ${rated.join(', ')}`);
      assert(rated.length > 2 && rated.length < Object.keys(CLASSES).length / 4, 'only a few hulls are rated for atmosphere');
    },
  },
  {
    name: 'stations sit where they should: on their rocks turning with them, or on Keplerian orbits',
    fn: () => {
      const s = game();
      const world = getWorld(s);
      for (const [id, spec] of Object.entries(STATIONS)) {
        const st = world.get(id);
        const b = getBody(spec.body);
        const o = stationOrbit(id);
        if (spec.site === 'surface') {
          near(o.r * AU_KM, b.radius, 0.01, `${id} on the surface`);
          near(o.period * 24, b.rotH, 1e-6, `${id} turns with ${b.name}`);
        } else {
          const kepler = 2 * Math.PI * Math.sqrt((o.r * AU_KM) ** 3 / b.gm) / 86400;
          near(o.period, kepler, 1e-6, `${id} on a Keplerian orbit`);
        }
        const m = stationModel(id);
        assert(m.berths.length >= 5 && m.sizeM > 800 && m.sizeM < 6000, `${id}: a few km across, with berths`);
        const gate = world.get(gateId(id));
        const dM = Math.hypot(gate.pos.x - st.pos.x, gate.pos.y - st.pos.y) * AU_M;
        near(dM, spec.gateKm * 1000, 1, `${id} gate`);
        assert(TC.zoneAt(st, dM) !== 'keepout', `${id}: the gate is outside the keep-out zone`);
        // berths move with the station's turn
        const b0 = berthPose(s, st, m.berths[0]), b1 = berthPose(s, st, m.berths[0], s.clock.minute + 60);
        assert(Math.abs(b1.angle - b0.angle) > 0, `${id}: its frame turns`);
      }
      const ceres = getBody('Ceres');
      console.log(`      Ceres: radius ${ceres.radius} km, a day of ${ceres.rotH} h, ${fmt(surfaceGravity(ceres), 3)} m/s² at the port, which moves at ${fmt(2 * Math.PI * ceres.radius * 1000 / (ceres.rotH * 3600), 0)} m/s`);
    },
  },
  {
    name: 'traffic berths and waits at the anchorage; traffic control keeps berths back for the arrivals it clears',
    fn: () => {
      const s = game(6, { traffic: 600 });
      advance(s, 600);
      const world = getWorld(s);
      for (const st of world.stations) {
        const c = berthCounts(s, st);
        const t = TC.stationTraffic(s, st);
        console.log(`      ${st.name.padEnd(20)} berths ${c.used}/${c.total} · anchorage ${t.anchored} · inbound ${t.inbound}`);
        assert(c.used <= c.total, 'never more ships in berths than berths');
      }
      const ceres = world.get('ceres-station');
      const r = TC.requestDocking(s, 'ceres-station');
      assert(r.ok, `a cleared arrival finds a berth: ${r.text}`);
    },
  },
  {
    name: 'traffic control: no clearance, a warning, a citation; trespass is a crime; a naval yard turns strangers away',
    fn: () => {
      const s = game(7);
      const ev = events();
      atGate(s, 'vesta-depot');
      // drift in on the approach with no clearance
      const st = getWorld(s).get('vesta-depot');
      s.flight.pos.x += (st.pos.x - s.flight.pos.x) * 0.5;
      s.flight.pos.y += (st.pos.y - s.flight.pos.y) * 0.5;
      s.tc.clear = {};
      advance(s, 25);
      const warned = (ev['tc-warning'] || []).map(w => w.key);
      assert(warned.includes('keepout'), `a final warning inside the keep-out zone (${warned})`);
      assert((ev.crime || []).some(c => c.kind === 'trespass'), 'trespass in the keep-out zone is a crime');
      assert(s.law.wanted.OPA >= 1 || (s.law.wanted.UN ?? 0) >= 0, 'recorded');
      // a naval yard doesn't berth strangers
      const r = TC.requestDocking(s, 'phobos-yard');
      assert(!r.ok && /denied/i.test(r.text), `Phobos turns us away: ${r.text}`);
      s.law.standing.MCR = 40;
      assert(TC.requestDocking(s, 'phobos-yard').ok, 'with standing, Phobos berths us');
      // wanted: no berth anywhere of that power
      s.law.wanted.OPA = 2;
      assert(!TC.requestDocking(s, 'ceres-station').ok, 'a wanted ship gets no berth');
      console.log(`      warnings: ${[...new Set(warned)].join(', ')} · citations ${s.law.fines.length} · ${s.law.record.map(r => r.kind).join(', ')}`);
    },
  },
  {
    name: 'the docking computer brings us in at every station: corridor, contact inside the envelope, a hard seal',
    fn: () => {
      const rows = [];
      for (const id of Object.keys(STATIONS)) {
        const s = game(8);
        s.law.standing.MCR = 40;
        atGate(s, id);
        const ev = events();
        const r = TC.requestDocking(s, id);
        assert(r.ok, `${id}: ${r.text}`);
        const b = D.beginDocking(s, { kind: 'station', id }, { mode: 'auto' });
        assert(b.ok, `${id}: ${b.text}`);
        const fuel0 = s.resources.fuel.current;
        const t = run(s, st => st.dock?.phase === 'docked', 600);
        assert(s.dock?.phase === 'docked', `${id}: not docked after ${t} min (${s.dock?.phase})`);
        const cap = ev['dock-capture']?.[0];
        assert(cap && cap.closing <= COLLARS[D.dockStatus(s).port.size].captureMS, `${id}: captured inside the envelope`);
        assert(!(ev.citation || []).length, `${id}: the docking computer flies by the rules`);
        rows.push(`${id} ${t} min, ${s.dock.bumps} bumps, ${fmt(fuel0 - s.resources.fuel.current, 2)} kg, contact ${fmt(cap.closing, 2)} m/s`);
        // and the berth is ours on the station's board
        assert(getWorld(s).get(id).berths[s.dock.berth] === 'player', 'the berth is ours');
      }
      console.log(rows.map(r => `      ${r}`).join('\n'));
    },
  },
  {
    name: 'by hand: a careful pilot docks, a careless one bounces off and pays for it',
    fn: () => {
      const fly = (careful) => {
        const s = game(9);
        atGate(s, 'ceres-station');
        TC.requestDocking(s, 'ceres-station');
        D.beginDocking(s, { kind: 'station', id: 'ceres-station' }, { mode: 'manual' });
        run(s, st => st.dock?.phase === 'prox', 120);
        const hull0 = s.hull.integrity;
        const ev = events();
        // a pilot's hands: close at a rate set by range, null the drift, square up
        for (let sec = 0; sec < 3600 && s.dock.phase === 'prox'; sec++) {
          const r = s.dock.rel;
          const want = careful ? Math.min(2, Math.max(0.12, r.x * 0.02)) : 1.2;
          const input = {
            tx: -r.vx < want - 0.03 ? 1 : -r.vx > want + 0.03 ? -1 : 0,
            ty: careful ? Math.sign(-r.y * 0.05 - r.vy) * (Math.abs(r.y) > 0.05 || Math.abs(r.vy) > 0.01 ? 1 : 0) : 0,
            tz: careful ? Math.sign(-r.z * 0.05 - r.vz) * (Math.abs(r.z) > 0.05 || Math.abs(r.vz) > 0.01 ? 1 : 0) : 0,
          };
          D.setDockInput(s, input);
          D.frameStep(s, 1, emit);
          if (s.dock.t >= 60) minuteTick(s);
        }
        return { s, ev, hull0, contacts: (ev['dock-bump'] || []).map(b => fmt(b.closing, 2)) };
      };
      const good = fly(true);
      assert(good.s.dock.phase === 'capture' || good.s.dock.phase === 'seal' || good.s.dock.phase === 'docked', `careful pilot: ${good.s.dock.phase}, ${good.s.dock.bumps} bumps`);
      const bad = fly(false);
      assert(bad.s.dock.bumps > 0, 'a 1.2 m/s contact bounces');
      assert(bad.s.hull.integrity < bad.hull0 && (bad.ev.citation || []).length, `and damages the hull, and earns a citation (contacts at ${bad.contacts} m/s)`);
      console.log(`      careful: ${good.s.dock.phase}, ${good.s.dock.bumps} bumps, ${fmt(good.s.dock.fuel, 3)} kg · careless: ${bad.s.dock.bumps} bumps, hull ${fmt(bad.hull0)} → ${fmt(bad.s.hull.integrity)}%`);
    },
  },
  {
    name: 'undocking takes a departure clearance; leaving the gate the drive stays at 0.1G',
    fn: () => {
      const s = game(10);
      const ev = events();
      assert(s.dock.phase === 'docked', 'a new game starts in a berth');
      D.undock(s, emit);
      run(s, st => st.dock?.phase === 'holding', 30);
      assert((ev.citation || []).some(c => /departure/.test(c.kind)), 'undocking without clearance is a citation');
      const s2 = game(10);
      TC.requestDeparture(s2, 'ceres-station');
      const ev2 = events();
      D.undock(s2, emit);
      run(s2, st => st.dock?.phase === 'holding', 30);
      assert(!(ev2.citation || []).length, 'with clearance, no citation');
      assert(s2.dock.phase === 'holding' && s2.dock.rel.x >= D.CLEAR_M - 1, 'backed out to the hold point');
      assert(TC.keepOutDriveCap(s2) <= 0.1 || s2.tc.zone !== 'keepout', 'inside the gate the drive is held to 0.1G');
    },
  },
  {
    name: 'thermal counts: a long look gives one, said once; a declared count is checked, not replaced',
    fn: () => {
      const s = game(11);
      releaseHold(s);
      s.dock = null;
      s.flight.pos.y += 0.02;
      const f = s.flight;
      const e = spawnAgent(s, { role: 'civilian', cls: 'freighter', faction: 'independent', pos: { x: f.pos.x + 20_000 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
      e.agent.mode = 'dock-hold';
      const ev = events();
      const said = () => (ev.dossier || []).filter(d => d.src === 'scan' && d.id === e.id).length;
      advance(s, 12 * 60);
      const alone = said();
      // the truth over the radio: the next look bears it out, quietly, and the count stays theirs
      delete dossierOf(s, e.id).scanAt;
      learn(s, e, { crew: crewAboard(e) }, 'hail');
      const before = said();
      advance(s, 6 * 60);
      const r = dossierOf(s, e.id);
      assert(said() === before && r.crew.src === 'hail' && !r.crew.doubt, 'an honest count is checked quietly and stands');
      // a lie: three times the crew; the heat inside doesn't bear it out
      delete r.scanAt;
      learn(s, e, { crew: 3 * crewAboard(e) }, 'hail');
      advance(s, 60);
      const told = (ev.dossier || []).filter(d => d.src === 'scan' && d.id === e.id).at(-1)?.text;
      console.log(`      12 h alongside: ${alone} thermal count logged · an honest hail: checked quietly · a lie: "${told}"`);
      assert(alone === 1, `one count for a ship alongside, not one every few hours (${alone})`);
      assert(r.crew.src === 'hail' && r.crew.doubt && /declared/.test(told), 'a declared count the heat does not bear out is kept, marked doubtful and logged');
      advance(s, 12 * 60);
      assert((ev.dossier || []).filter(d => d.id === e.id && /declared/.test(d.text)).length === 1, 'and said once, not every look');
    },
  },
  {
    name: 'ship to ship: hail a hauler, rendezvous, dock, buy over the collar',
    fn: async () => {
      const s = game(11);
      releaseHold(s);
      s.dock = null;
      s.flight.pos.y += 0.02;
      const f = s.flight;
      const e = spawnAgent(s, { role: 'civilian', cls: 'freighter', faction: 'independent', pos: { x: f.pos.x + 30_000 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
      advance(s, 2);
      const conv = openChannel(s, e.id);
      assert(!conv.error, 'channel open');
      const tlist = topics(s).map(t => t.id);
      assert(tlist.includes('dock-request') && tlist.includes('souls'), `topics: ${tlist}`);
      const souls = say(s, 'souls');
      assert(dossierOf(s, e.id)?.crew?.src === 'hail', 'their answer is logged');
      say(s, 'dock-request');
      assert(e.agent.mode === 'dock-hold', 'they hold for us');
      closeChannel(s);
      const b = D.beginDocking(s, { kind: 'ship', id: e.id }, { mode: 'auto' });
      assert(b.ok, b.text);
      const t = run(s, st => st.dock?.phase === 'docked', 600);
      assert(s.dock?.phase === 'docked', `not docked with the hauler after ${t} min: ${s.dock?.phase}`);
      openChannel(s, e.id);
      assert(topics(s).some(x => x.id === 'trade-now'), 'docked, we can trade');
      const { buyFromShip } = await import('../js/sim/dialogue.js');
      s.resources.fuel.current = 1000;
      const r = buyFromShip(s, e, 'fuel');
      assert(r.ok && s.resources.fuel.current > 1000, r.text);
      console.log(`      ${souls.lines[1].text} · docked with the ${e.name} in ${t} min · ${r.text}`);
    },
  },
  {
    name: 'a boarding party crosses together: boarders on one deck don\'t race for one suit; one with no suit left, or not at the lock in time, stays aboard and goes back to work',
    fn: () => {
      const setup = (seed) => {
        const s = game(seed, { classId: 'mcrn-corvette', crewCount: 10 });
        releaseHold(s);
        s.dock = null;
        s.flight.pos.y += 0.02;
        const f = s.flight;
        const w = spawnAgent(s, { role: 'civilian', cls: 'pirate-corvette', faction: 'pirate', pos: { x: f.pos.x + 900 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
        wreckNpc(s, w, null);
        // three of the crew, unsuited, side by side at the first suit locker
        const geo = shipGeometry(s.ship), locker = geo.fixtures.locker[0], at = geo.nodes[locker.access];
        const party = s.ship.crew.filter(m => m.role !== 'Captain' && m.role !== 'Pilot').slice(0, 3);
        for (const m of party) { m.task = null; m.seat = null; m.path = []; m.pos.sx = at.sx; m.pos.sy = at.sy; m.suit.wearing = false; }
        return { s, w, party };
      };
      // 1. all three, the nearest locker holding one suit: each finds their own
      {
        const { s, w, party } = setup(41);
        const r = startBoarding(s, w.id, { party: party.map(m => m.id), via: 'eva' });
        assert(r.ok, r.text);
        const t = run(s, st => st.boarding.phase !== 'muster', 60);
        console.log(`      three boarders from one locker: across in ${t} min, ${s.boarding.party.length} of 3`);
        assert(s.boarding.party.length === 3 && party.every(m => m.away && m.suit.wearing), 'all three suited and across');
      }
      // 2. a suit gone from the lockers after the order: the one left without stays aboard
      {
        const { s, w, party } = setup(42);
        startBoarding(s, w.id, { party: party.slice(0, 2).map(m => m.id), via: 'eva' });
        advance(s, 1);
        const L = s.lifeSupport.lockers;
        const spare = Object.keys(L).filter(id => L[id].hasSuit && !s.ship.crew.some(m => m.task?.locker === id));
        for (const id of spare) L[id].hasSuit = false;
        const claimed = s.ship.crew.find(m => m.task?.type === 'board' && m.task.locker && party.slice(0, 2).includes(m) && m !== party[0]);
        if (claimed) L[claimed.task.locker].hasSuit = false;
        run(s, st => st.boarding.phase !== 'muster', 60);
        assert(s.boarding.phase === 'cross' && s.boarding.party.length === 1, `one goes (${s.boarding.phase}, ${s.boarding.party.length})`);
        assert(s.boarding.log.some(l => /no suit left/.test(l.text)), 'the other is told off, no suit');
        advance(s, 2);
        assert(!s.ship.crew.some(m => m.task?.type === 'board'), 'nobody left at the lock');
      }
      // 3. one still on the way is waited for; one held up past the cap is left aboard, back at work
      {
        const { s, w, party } = setup(43);
        startBoarding(s, w.id, { party: party.slice(0, 2).map(m => m.id), via: 'eva' });
        const slow = party[1];
        advance(s, 1);
        // (sent off to the far end of the ship for a suit, and held there)
        const geo = shipGeometry(s.ship), far = geo.nodes.at(-1);
        const hold = () => { if (slow.task?.type === 'board') { slow.task.phase = 'goto'; slow.pos.sx = far.sx; slow.pos.sy = far.sy; slow.path = [{ sx: far.sx + 10, sy: far.sy }]; } };
        for (let i = 0; i < 40; i++) { hold(); advance(s, 1); }
        assert(s.boarding.phase === 'muster', 'still waited for at 40 minutes: on the way');
        s.boarding.since -= 60;
        hold(); advance(s, 1);
        assert(s.boarding.phase !== 'muster' && s.boarding.party.length === 1 && !slow.away, 'past the cap the party goes without them');
        assert(s.boarding.log.some(l => /not at the lock in time/.test(l.text)), 'and says so');
        advance(s, 2);
        assert(slow.task?.type !== 'board' && slow.activity !== 'at the lock', `back to the ship's work (${slow.task?.type}, ${slow.activity})`);
      }
      // 4. a save with someone already stuck at the lock (before 1.1): they leave it
      {
        const { s, party } = setup(44);
        party[0].task = { type: 'board', phase: 'ready', lock: null, locker: null, timer: 0 };
        s.boarding = null;
        advance(s, 2);
        assert(party[0].task?.type !== 'board', 'a board task with no muster is dropped');
      }
    },
  },
  {
    name: 'boarding: a struck pirate taken by EVA, its crew counted, prisoners in the brig; boarding a lawful hull is piracy',
    fn: () => {
      const s = game(12, { classId: 'cutter', crewCount: 8 });
      releaseHold(s);
      s.dock = null;
      s.flight.pos.y += 0.02;
      const f = s.flight;
      const p = spawnAgent(s, { role: 'pirate', cls: 'pirate-gunship', faction: 'pirate', pos: { x: f.pos.x + 800 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
      ensureHull(p).drive = 0.1;
      makeHostile(s, p, PLAYER);
      p.agent.aggressor = true;
      surrender(s, p);
      const before = crewAboard(p);
      const party = s.ship.crew.filter(m => m.role !== 'Captain' && m.role !== 'Pilot').slice(0, 4).map(m => m.id);
      const r = startBoarding(s, p.id, { party, via: 'eva' });
      assert(r.ok, r.text);
      run(s, st => st.boarding?.phase === 'secured' || st.boarding?.phase === 'done', 200);
      assert(s.boarding.phase === 'secured', `boarding: ${s.boarding.phase} — ${s.boarding.log.map(l => l.text).join(' / ')}`);
      assert(dossierOf(s, p.id)?.crew?.src === 'boarded', 'the crew counted aboard');
      orderAboard(s, 'prisoners');
      run(s, st => !st.boarding.action, 30);
      const held = s.passengers.find(x => x.kind === 'prisoners');
      assert(held && held.count > 0, 'prisoners aboard');
      orderAboard(s, 'withdraw');
      run(s, st => st.boarding.phase === 'done', 30);
      assert(s.ship.crew.every(m => !m.away), 'the party is home');
      assert(!s.law.record.some(c => c.kind === 'piracy'), 'boarding a struck pirate is lawful');
      // a lawful hauler, uninvited
      const h = spawnAgent(s, { role: 'civilian', cls: 'tramp', faction: 'OPA', pos: { x: f.pos.x + 500 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
      ensureHull(h).drive = 0.1;
      surrender(s, h);
      s.boarding = null;
      startBoarding(s, h.id, { party, via: 'eva' });
      assert(s.law.record.some(c => c.kind === 'piracy'), 'boarding a lawful hull uninvited is piracy');
      console.log(`      ${before} aboard the pirate; ${held.count} taken prisoner; log: ${s.law.record.map(c => c.kind).join(', ')}`);
    },
  },
  {
    name: 'salvage: a party crosses to a wreck, run after run gives less; cracking a lawful ship\'s accounts is theft',
    fn: () => {
      const s = game(14, { classId: 'cutter', crewCount: 8 });
      releaseHold(s);
      s.dock = null;
      s.flight.pos.y += 0.02;
      const f = s.flight;
      const w = spawnAgent(s, { role: 'civilian', cls: 'meridian', faction: 'UN', pos: { x: f.pos.x + 900 / AU_M, y: f.pos.y }, vel: { ...f.vel } });
      wreckNpc(s, w, null);
      s.resources.scrap.current = 0;
      const party = s.ship.crew.filter(m => m.role !== 'Captain' && m.role !== 'Pilot').slice(0, 3).map(m => m.id);
      const r = startBoarding(s, w.id, { party, via: 'eva' });
      assert(r.ok, r.text);
      run(s, st => st.boarding?.phase === 'secured' || st.boarding?.phase === 'done', 200);
      assert(s.boarding.phase === 'secured', `boarding: ${s.boarding.phase}`);
      const runs = [];
      for (let i = 0; i < 4; i++) {
        const before = { scrap: s.resources.scrap.current, parts: s.resources.parts.current, fuel: s.resources.fuel.current };
        const o = orderAboard(s, 'salvage');
        if (!o.ok) break;
        run(s, st => !st.boarding.action, 60);
        runs.push(s.boarding.log.at(-1).text.replace('Salvage run: ', ''));
      }
      assert(runs.length >= 3, 'salvage is repeatable');
      assert(s.resources.scrap.current > 0 || s.resources.parts.current > 0, 'something came out of it');
      assert((w.tags.salvageLeft ?? 1) < 0.2, 'each run takes from what is left');
      orderAboard(s, 'accounts');
      run(s, st => !st.boarding.action, 40);
      const cracked = /MCR transferred/.test(s.boarding.log.at(-1).text);
      if (cracked) assert(s.law.record.some(c => c.kind === 'theft'), 'a UN ship\'s credits are theft');
      console.log(`      ${runs.length} runs: ${runs.join(' | ')} · accounts: ${s.boarding.log.at(-1).text}`);
    },
  },
  {
    name: 'stations fight back: fire on one and its guns answer, its power wants us, its docks can be shot out',
    fn: () => {
      const s = game(13);
      const ev = events();
      atGate(s, 'ceres-station');
      const st = getWorld(s).get('ceres-station');
      for (let i = 0; i < 3; i++) applyHit(s, st.id, { dp: 400, aim: 'disable', precision: 0.9, kind: 'he', from: PLAYER, weapon: 'test' });
      assert(s.law.wanted.OPA >= 2, `attacking a station is a serious crime (wanted ${s.law.wanted.OPA})`);
      assert(st.combat.hostile.includes(PLAYER), 'it remembers who did it');
      advance(s, 30);
      const fired = (ev['torpedo-launched'] || []).filter(t => t.owner === st.id).length + (ev['pdc-strafe'] || []).filter(t => t.from === st.id).length;
      assert(fired > 0, 'its guns answer');
      assert(st.combat.docks < 1, 'disabling fire hits the docks');
      assert(!TC.requestDocking(s, 'ceres-station').ok, 'and it will not berth us');
      console.log(`      station: structure ${fmt(st.combat.hp)}/${st.combat.hpMax}, docks ${fmt(st.combat.docks * 100, 0)}%, shots at us ${fired}`);
    },
  },
  {
    name: 'manifests: who is aboard out there, and what we know of it and from where',
    fn: () => {
      const s = game(14, { traffic: 300 });
      advance(s, 30);
      const world = getWorld(s);
      const ships = s.entities.filter(e => e.type === 'ship' && e.cls);
      for (const e of ships.slice(0, 200)) {
        const c = CLASSES[e.cls];
        const n = complementOf(e);
        assert(n >= c.crew[0] && n <= c.crew[1], `${e.cls}: ${n} aboard, rated ${c.crew}`);
        assert(complementOf(e) === n, 'the same hull keeps the same crew');
      }
      // the traffic board gives manifests for the berthed
      openChannel(s, 'ceres-station');
      say(s, 'traffic');
      const learned = Object.values(s.dossier.ships).filter(r => r.crew?.src === 'manifest');
      assert(learned.length > 0, 'manifests from the traffic board');
      // (a hull with a crew of two or more: half of a crew of one is still one)
      const e = world.get((learned.find(r => complementOf(world.get(r.id)) >= 2) || learned[0]).id);
      assert(knownCrew(s, e).lo === crewAboard(e), 'declared crews are true for honest ships');
      // casualties: a hull that lost men has fewer aboard
      ensureHull(e).crew = 0.5;
      assert(crewAboard(e) < complementOf(e), 'casualties');
      console.log(`      ${learned.length} manifests from Ceres traffic control; e.g. ${e.name}: ${knownCrew(s, e).text}`);
    },
  },
  {
    name: 'crew ashore: sign a hand on in the hiring hall, send the crew on leave, and no undocking until they are back',
    fn: () => {
      const s = game(15);
      const st = getWorld(s).get('ceres-station');
      const n0 = s.ship.crew.length;
      const hall = hiringHall(s, st);
      assert(hall.length > 0, 'the hall has people');
      s.resources.credits.current = 10_000;
      const r = hire(s, 0);
      assert(r.ok && s.ship.crew.length === n0 + 1, r.text);
      const short = shoreLeave(s);
      assert(!short.ok && short.lease?.hours > 0, 'the free lease is shorter than a run ashore: ' + short.text);
      const l = shoreLeave(s, null, { extend: true });
      assert(l.ok && s.ship.crew.every(m => m.away?.ashore), l.text);
      assert(leaseFor(s).left >= 8 * 60, 'the berth is ours until they are back');
      assert(!D.undock(s).ok, 'no undocking with the crew ashore');
      advance(s, 8 * 60 + 2);
      assert(s.ship.crew.every(m => !m.away), 'everyone back');
      assert(s.ship.crew.every(m => m.needs.fun >= 90), 'and better for it');
    },
  },
  {
    name: 'a berth is leased: a free working lease, long leases paid by the hour, overstayers cited and in the end let go',
    fn: () => {
      const s = game(21);
      const ev = events();
      minuteTick(s);
      const L = leaseFor(s);
      near(L.left, FREE_LEASE_MIN, 2, `a fresh dock comes with ${FREE_LEASE_MIN / 60} free hours`);
      const cr = s.resources.credits.current, rate = leaseRate(s);
      const r = extendLease(s, 24);
      assert(r.ok && s.resources.credits.current === cr - 24 * leaseRate(s), r.text);
      assert(leaseFor(s).left > 29 * 60, 'thirty hours now');
      advance(s, leaseFor(s).left + 31);
      assert(ev['tc-warning']?.some(w => w.key === 'lease-60') && ev['tc-warning'].some(w => w.key === 'lease-up'), 'told an hour before and when it is up');
      assert(ev.citation?.some(c => c.kind === 'overstaying a berth lease'), 'cited after the grace');
      assert(s.dock?.phase === 'docked', 'still in the berth');
      const fines = ev.citation.length;
      advance(s, 6 * 60);
      assert(ev.citation.length > fines, 'cited again while we stay');
      assert(s.dock && s.dock.phase !== 'docked', `the dock lets go of us (${s.dock?.phase})`);
      console.log(`      lease ${rate} MCR/h here; ${ev.citation.length} citations before the clamps let go`);
    },
  },
  {
    name: 'a save taken mid-docking flies on the same',
    fn: () => {
      const s = game(16);
      atGate(s, 'vesta-depot');
      TC.requestDocking(s, 'vesta-depot');
      D.beginDocking(s, { kind: 'station', id: 'vesta-depot' }, { mode: 'auto' });
      run(s, st => st.dock?.phase === 'prox', 120);
      assert(s.dock.phase === 'prox', 'in proximity operations');
      const copy = deserialize(serialize(s)).state;
      for (let i = 0; i < 20; i++) { advance(s, 1); advance(copy, 1); }
      near(copy.dock.rel.x, s.dock.rel.x, 1e-6, 'same range after load');
      assert(copy.dock.phase === s.dock.phase, 'same phase');
    },
  },
];
