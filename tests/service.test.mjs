// Politics and military service: the powers' relations, licenses and the
// flag, rank, command ships, military missions, and the yards.
import { assert, fmt } from './helpers.mjs';
import { DAY_MIN, AU_M } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { getBody, bodyVel } from '../js/sim/ephemeris.js';
import { createIntel } from '../js/sim/intel.js';
import { createPolitics, dailyRelations, setPhase, PAIRS, relation } from '../js/sim/politics.js';
import { spawnZone, zonePos } from '../js/sim/conflict.js';
import { spawnAgent } from '../js/sim/agents.js';
import { wreckNpc } from '../js/sim/damage.js';
import { contrabandFor, settleInspection, recordAttack, lawfulTarget } from '../js/sim/law.js';
import { commandShipFor, forcesSummary, NAVY_STRENGTH, fobsOf, commandOnStation } from '../js/sim/forces.js';
import { liveKnowledge } from '../js/sim/intel.js';
import { knownName } from '../js/sim/flags.js';
import { shipDockable } from '../js/sim/docking.js';
import { priceOf, acceptContract, completeContract, contractsTick, torpedoRefusal, PRICES } from '../js/sim/contracts.js';
import { generateMil, milRefusal } from '../js/sim/military.js';
import {
  contractor, flagOf, effectiveRelation, enemyOf, applyForLicense, resignLicense, hullLegal, rankOf, rankName,
  serviceTick, RANK_REP, supplyPriceFactor, COMMAND_PRICE, ourName,
} from '../js/sim/service.js';
import { PLAYER } from '../js/sim/combatants.js';

function game(seed = 21, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 6, traffic: 0, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** Put the ship somewhere, at rest in the local frame of a body. */
function placeAt(s, pos, body = null) {
  s.dock = null;
  s.flight.hold = null;
  s.flight.pos = { x: pos.x, y: pos.y };
  const v = body ? bodyVel(getBody(body), s.clock.minute / DAY_MIN) : { vx: 0, vy: 0 };
  s.flight.vel = { vx: v.vx, vy: v.vy };
}

export default [
  {
    name: 'flying one of its navy\'s hulls under its license, our ship carries the navy\'s prefix',
    fn: () => {
      const name = (classId, license, shipName = 'Longhaul') => ourName(createGame({ classId, license, shipName, crewCount: 4, traffic: 0 }));
      const got = { mcrn: name('mcrn-corvette', 'MCR'), unn: name('unn-corvette', 'UN'), opa: name('opa-corvette', 'OPA'), civil: name('light-freighter', 'MCR'), bare: name('mcrn-corvette', null), typed: name('mcrn-corvette', 'MCR', 'MCRN Longhaul') };
      console.log(`      ${Object.entries(got).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
      assert(got.mcrn === 'MCRN Longhaul' && got.unn === 'UNN Longhaul', 'a contractor\'s hull carries its navy\'s prefix');
      assert(got.opa === 'Longhaul', 'OPA warships carry bare names');
      assert(got.civil === 'Longhaul' && got.bare === 'Longhaul', 'no flag, no prefix');
      assert(got.typed === 'MCRN Longhaul', 'a prefix the captain gave is not doubled');
    },
  },
  {
    name: 'politics: Earth and Mars swing between cold war and war and are never friends; the Belt stays mostly calm',
    fn: () => {
      const share = {};
      let wars = 0;
      for (const seed of [1, 2, 3]) {
        seedRandom(seed);
        const s = { clock: { minute: 0 }, flight: { pos: { x: 1, y: 0 } }, intel: createIntel(), politics: createPolitics() };
        for (let d = 0; d < 730; d++) {
          s.clock.minute = d * DAY_MIN + 300;
          dailyRelations(s, (t, p) => { if (t === 'politics-phase' && p.phase === 'war' && p.pair === 'MCR-UN') wars++; });
          for (const k of PAIRS) { const ph = s.politics.pairs[k].phase; share[`${k} ${ph}`] = (share[`${k} ${ph}`] || 0) + 1 / (3 * 730); }
          assert(s.politics.pairs['MCR-UN'].rel <= -25, 'Earth and Mars are never friends');
        }
      }
      console.log(`      2 years × 3: ${wars} Earth–Mars wars · ${Object.entries(share).sort().map(([k, v]) => `${k} ${fmt(v * 100, 0)}%`).join(' · ')}`);
      assert(wars >= 3 && wars <= 15, 'wars come and go');
      assert((share['MCR-UN cold'] || 0) > 0.15 && (share['MCR-UN war'] || 0) < 0.35, 'mostly a cold war or a crisis');
      assert(!share['MCR-UN neutral'] && !share['MCR-UN friendly'], 'never neutral, never friends');
      assert((share['OPA-UN war'] || 0) < 0.15 && (share['MCR-OPA war'] || 0) < 0.15, 'the Belt rarely goes to war');
    },
  },
  {
    name: 'a license at the start: our power\'s yard, its standing, its flag in its own navy\'s hull',
    fn: () => {
      const s = game(1, { license: 'MCR', classId: 'mcrn-corvette', docked: true });
      assert(s.dock?.target.id === 'phobos-yard', `starts at Phobos: ${s.dock?.target.id}`);
      assert(contractor(s) && flagOf(s) === 'MCR', 'a contractor under the MCR flag');
      assert(s.law.standing.MCR >= 20, 'in Mars\'s good books');
      s.politics.frozen = true;
      setPhase(s, 'MCR', 'UN', 'war');
      assert(enemyOf(s, 'UN') && effectiveRelation(s, 'UN') <= -60, `at war with Earth: ${effectiveRelation(s, 'UN')}`);
      setPhase(s, 'MCR', 'UN', 'cold');
      assert(!enemyOf(s, 'UN'), 'a cold war is not a war');
      // The personal tenth: our own standing moves it a little
      const before = effectiveRelation(s, 'OPA');
      s.law.standing.OPA += 50;
      assert(Math.abs(effectiveRelation(s, 'OPA') - before - 5) < 1e-9, 'standing counts a tenth under the flag');
      // A license in a civilian hull: no flag
      const t = game(2, { license: 'UN', classId: 'tramp' });
      assert(!contractor(t) && !flagOf(t) && t.service.license === 'UN', 'licensed, but no flag in a tramp');
      assert(effectiveRelation(t, 'MCR') === t.law.standing.MCR, 'without the flag, relations are our own');
    },
  },
  {
    name: 'licenses: apply in good standing, one at a time; resigning makes a navy hull illegal; crimes against our own side revoke it',
    fn: () => {
      const s = game(3, { classId: 'unn-corvette' });
      assert(!hullLegal(s), 'a navy hull without its license is illegal');
      assert(contrabandFor(s, 'UN').hull === 'stolen' && contrabandFor(s, 'MCR').hull === 'unlicensed', 'its own navy calls it stolen');
      assert(!applyForLicense(s, 'UN').ok, 'no standing, no license');
      s.law.standing.UN = 15;
      const r = applyForLicense(s, 'UN');
      assert(r.ok && contractor(s) && hullLegal(s), r.text);
      assert(!applyForLicense(s, 'MCR').ok, 'one license at a time');
      // Nukes: legal in our own power's space, not in Mars's; none at all without a license
      s.magazine.nuke = 2;
      assert(contrabandFor(s, 'UN').nukes === 0 && contrabandFor(s, 'MCR').nukes === 2 && contrabandFor(s, 'OPA').nukes === 0, 'nukes under a UN license');
      assert(resignLicense(s).ok && !hullLegal(s) && contrabandFor(s, 'OPA').nukes === 2, 'resigned: the hull and the nukes are contraband');
      const fine = settleInspection(s, 'OPA');
      assert(fine.found && s.law.wanted.OPA >= 1, fine.text);
      // Revoked for firing on our own side
      s.law.standing.UN = 30; s.law.wanted.UN = 0;
      assert(applyForLicense(s, 'UN').ok, 'licensed again');
      const world = getWorld(s);
      const own = spawnAgent(s, { role: 'navy', kind: 'frigate', category: 'military', faction: 'UN', pos: { x: s.flight.pos.x + 0.001, y: s.flight.pos.y }, vel: s.flight.vel });
      recordAttack(s, own, 'disabled');
      assert(!s.service.license && s.service.revoked.UN > s.clock.minute, 'license revoked');
      assert(!applyForLicense(s, 'UN').ok, 'and not given back for a while');
      void world;
    },
  },
  {
    name: 'the flag in a fight: the enemy engages us once it knows us; destroying its warships is war, not a crime, and earns rank',
    fn: () => {
      const s = game(4, { license: 'UN', classId: 'unn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'UN', 'MCR', 'war');
      const p = { x: 1.6, y: 0.4 };
      placeAt(s, p);
      s.comms.transponder = true;
      const foe = spawnAgent(s, { role: 'navy', kind: 'corvette', category: 'military', faction: 'MCR', pos: { x: p.x + 0.0006, y: p.y }, vel: { vx: 0, vy: 0 }, enemies: ['UN'] });
      for (let i = 0; i < 12 && !foe.agent.hostile.includes(PLAYER); i++) minuteTick(s);
      assert(foe.agent.hostile.includes(PLAYER), 'a Martian warship engages a UN contractor at war');
      const crimes = s.law.record.length;
      const rep0 = s.service.rep.UN;
      wreckNpc(s, foe, PLAYER);
      assert(s.law.record.length === crimes, 'no crime');
      assert(s.service.kills === 1 && s.service.rep.UN > rep0, `reputation for the kill: ${s.service.rep.UN}`);
      // A civilian of the enemy is never a target: firing on it is a crime
      const hauler = spawnAgent(s, { role: 'civilian', category: 'civilian', faction: 'MCR', pos: { x: p.x - 0.0005, y: p.y }, vel: { vx: 0, vy: 0 } });
      recordAttack(s, hauler, 'fired');
      assert(s.law.record.length === crimes + 1, 'firing on an enemy civilian is a crime');
      // Rank from reputation
      s.service.rep.UN = RANK_REP[3];
      s.service.rank = 0;
      serviceTick(s);
      advance(s, DAY_MIN);
      console.log(`      ${s.service.kills} kill · rep ${Math.round(s.service.rep.UN)} · rank ${rankOf(s)}: ${rankName(s)}`);
      assert(rankOf(s) >= 3, 'promoted with reputation');
      // In a cold war the same ship would only have watched
      setPhase(s, 'UN', 'MCR', 'cold');
      const watcher = spawnAgent(s, { role: 'navy', kind: 'corvette', category: 'military', faction: 'MCR', pos: { x: p.x + 0.0006, y: p.y }, vel: { vx: 0, vy: 0 } });
      for (let i = 0; i < 12; i++) minuteTick(s);
      assert(!watcher.agent.hostile.includes(PLAYER), 'no war, no shooting');
    },
  },
  {
    name: 'command ships: each power in a fight sends one; it takes its own contractors alongside, calls them up, and sells at a tenth',
    fn: () => {
      const s = game(5, { traffic: 40, license: 'UN', classId: 'unn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'UN', 'MCR', 'war');
      const z = spawnZone(s, { body: 'Ganymede', kind: 'front', factions: ['UN', 'MCR'], w: 1 });
      const un = commandShipFor(s, z.id, 'UN'), mcr = commandShipFor(s, z.id, 'MCR');
      assert(un && mcr, 'both powers sent a command ship');
      for (let d = 0; d < 14 && un.tags.force.state !== 'post'; d++) advance(s, DAY_MIN);
      assert(un.tags.force.state === 'post', `on station near Ganymede: ${un.tags.force.state}`);
      assert(shipDockable(s, un).ok && !shipDockable(s, mcr).ok, 'ours takes us alongside, theirs does not');
      // Call-up: near the fight, the order comes in at light speed
      const post = getWorld(s).get(un.tags.force.post);
      placeAt(s, { x: post.pos.x + 0.02, y: post.pos.y }, 'Ganymede');
      for (let i = 0; i < 90 && !s.service.callups[0]?.heard; i++) minuteTick(s);
      assert(s.service.callups[0]?.heard && s.service.callups[0].ship === un.id, 'called up to our command ship');
      // Alongside: supplies at a tenth, and its board is all military work
      s.dock = { target: { kind: 'ship', id: un.id }, berth: 'crew-p', port: 'crew', mode: 'auto', phase: 'docked', rel: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, wy: 0, wp: 0, wr: 0 }, t: 0, since: s.clock.minute, at: s.clock.minute, timer: 0, bumps: 0, fuel: 0, rate: 3 };
      assert(supplyPriceFactor(s) === COMMAND_PRICE && Math.abs(priceOf(s, 'fuel') - PRICES.fuel * COMMAND_PRICE) < 1e-9, 'fuel at a tenth');
      assert(torpedoRefusal(s, un, 'nuke'), 'no warheads for a junior contractor');
      s.service.rank = 3;
      assert(!torpedoRefusal(s, un, 'nuke'), 'warheads from rank 3');
      serviceTick(s);
      assert(s.service.callups[0].reported, 'reported aboard');
      s.clock.minute += 10 - (s.clock.minute % 10);
      contractsTick(s);
      const board = un.board.missions;
      console.log(`      ${un.name} near Ganymede: board ${board.map(c => c.type).join(', ')}`);
      assert(board.length > 0 && board.every(c => c.mil), 'all military work');
    },
  },
  {
    name: 'FOBs: a forward command on its post is charted for everyone, named; a fight that began with none in port gets one when a yard has one; another navy\'s posts no work for us',
    fn: () => {
      const s = game(5, { traffic: 40, license: 'UN', classId: 'unn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'UN', 'MCR', 'war');
      const world = getWorld(s);
      // every MCR command ship busy elsewhere: the fight begins without one
      const mcrs = [...world.forces].filter(e => e.tags.force.role === 'command' && e.faction === 'MCR');
      for (const e of mcrs) e.tags.force.state = 'post';
      const z = spawnZone(s, { body: 'Ganymede', kind: 'front', factions: ['UN', 'MCR'], w: 1 });
      let fobs = fobsOf(s, z);
      assert(fobs.find(f => f.faction === 'UN').status === 'transit' && fobs.find(f => f.faction === 'MCR').status === 'none', `UN under way, MCR none in port (${fobs.map(f => `${f.faction} ${f.status}`).join(', ')})`);
      const un = fobs.find(f => f.faction === 'UN').ship;
      assert(!liveKnowledge(s, un), 'on its way out, not charted');
      for (const e of mcrs) e.tags.force.state = 'berth';
      for (let i = 0; i < 61 && !commandShipFor(s, z.id, 'MCR'); i++) minuteTick(s);
      assert(commandShipFor(s, z.id, 'MCR'), 'within the hour a yard sends one out');
      for (let d = 0; d < 14 && !commandOnStation(un); d++) advance(s, DAY_MIN);
      fobs = fobsOf(s, z);
      assert(commandOnStation(un) && liveKnowledge(s, un) === 'charted' && knownName(s, un.id) === un.name, `on its post, charted and named: ${knownName(s, un.id)}`);
      // the MCR's FOB, alongside: no work for a UN contractor
      const mcr = commandShipFor(s, z.id, 'MCR');
      const c = generateMil(s, mcr, 'c-x');
      assert(!c, 'another navy\'s forward command posts no work for us');
      console.log(`      ${fobs.map(f => `${f.faction} FOB ${f.ship?.name || '—'}: ${f.status}`).join(' · ')}`);
    },
  },
  {
    name: 'military work: an intelligence job — lock enemy warships, report at any port of our power — pays and earns reputation',
    fn: () => {
      const s = game(6, { license: 'MCR', classId: 'mcrn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'MCR', 'UN', 'war');
      const z = spawnZone(s, { body: 'Ganymede', kind: 'skirmish', factions: ['MCR', 'UN'], w: 1 });
      const world = getWorld(s);
      const st = world.get('phobos-yard');
      let c = null;
      for (let i = 0; i < 40 && c?.type !== 'INTEL'; i++) c = generateMil(s, { ...st, tags: { command: { zone: z.id } }, faction: 'MCR', id: 'phobos-yard', name: st.name, pos: st.pos }, `c-t${i}`);
      assert(c?.type === 'INTEL' && c.mil && c.faction === 'MCR', 'an intelligence job');
      st.board.missions.push(c);
      placeAt(s, st.pos);
      s.dock = null;
      // (signing needs port space; at the station itself we are in it)
      const r = acceptContract(s, st.id, c.id);
      assert(r.ok, r.text);
      const zp = zonePos(z, s.clock.minute);
      const foes = [0, 1, 2].map(i => spawnAgent(s, { role: 'navy', kind: 'corvette', category: 'military', faction: 'UN', pos: { x: zp.x + 0.0005 * i, y: zp.y }, vel: { vx: 0, vy: 0 } }));
      placeAt(s, { x: zp.x + 0.0003, y: zp.y + 0.0003 });
      for (const f of foes.slice(0, c.count)) {
        s.sensors.locked = f.id;
        for (let m = 0; m < c.lockMin; m++) { s.clock.minute++; contractsTick(s); }
      }
      assert(c.phase === 'return', `intelligence gathered: ${c.phase} ${JSON.stringify(c.tracked)}`);
      placeAt(s, st.pos);
      const cr = s.resources.credits.current, rep = s.service.rep.MCR;
      const done = completeContract(s, c.id, st.id);
      assert(done.ok, done.text);
      console.log(`      ${c.title}: ${fmt(s.resources.credits.current - cr, 0)} MCR, +${s.service.rep.MCR - rep} reputation`);
      assert(s.resources.credits.current > cr && s.service.rep.MCR > rep && s.service.missions === 1, 'paid, and noted');
    },
  },
  {
    name: 'an insurgency has work for an ensign: intelligence on the cells, whose ships lie up dark round an area, found, locked and reported; fair game if it comes to a fight, let go after',
    fn: () => {
      const s = game(9, { license: 'MCR', classId: 'mcrn-corvette' });
      s.politics.frozen = true;
      const z = spawnZone(s, { body: 'Ganymede', kind: 'insurgency', factions: ['MCR'], sub: 'opa-ceres', w: 1 });
      const world = getWorld(s), st = world.get('phobos-yard');
      const port = { ...st, tags: { command: { zone: z.id } }, faction: 'MCR', id: 'phobos-yard', name: st.name, pos: st.pos };
      assert(s.service.rank === 0, 'an ensign');
      const offers = [];
      for (let i = 0; i < 40; i++) { const c = generateMil(s, port, `c-i${i}`); if (c) offers.push(c); }
      const ours = offers.filter(c => !milRefusal(s, c));
      assert(ours.length && ours.every(c => c.type === 'INTEL' && c.enemy === '$cells'), `work an ensign can sign for (${offers.map(c => c.type).join(' ')})`);
      const c = ours[0];
      st.board.missions.push(c);
      placeAt(s, st.pos);
      const r = acceptContract(s, st.id, c.id);
      assert(r.ok, r.text);
      const mark = world.get(c.markId), cells = c.spawned.map(id => world.get(id));
      assert(mark && cells.length === c.count + 1, `${cells.length} cell hulls out, for ${c.count} locks`);
      for (const e of cells) {
        const d = Math.hypot(e.pos.x - mark.pos.x, e.pos.y - mark.pos.y) * AU_M / 1000;
        assert(e.sub === 'opa-ceres' && !e.transponder && e.tags.wanted && !lawfulTarget(e) && d >= 59_000 && d <= 271_000, `a cell hull lying up dark ${fmt(d, 0)} km out, fair game (${e.cls})`);
      }
      for (const e of cells.slice(0, c.count)) {
        placeAt(s, { x: e.pos.x + 0.0005, y: e.pos.y });
        s.sensors.locked = e.id;
        for (let m = 0; m < c.lockMin; m++) { s.clock.minute++; contractsTick(s); }
      }
      assert(c.phase === 'return', `the cells' ships logged: ${c.phase} ${JSON.stringify(c.tracked)}`);
      assert(cells.every(e => !e.agent || e.agent.contract == null), 'the cell hulls go back to their own business');
      placeAt(s, st.pos);
      const cr = s.resources.credits.current;
      const done = completeContract(s, c.id, st.id);
      assert(done.ok, done.text);
      console.log(`      ${c.title}: ${cells.map(e => e.cls).join(', ')} lying up round ${mark.name}; ${fmt(s.resources.credits.current - cr, 0)} MCR`);
      // a command ship keeps work for the rank of the captain reporting to it: a board of strikes only gets some
      st.tags.command = { zone: z.id };
      const strikes = [];
      for (let i = 0; strikes.length < st.board.maxMissions && i < 200; i++) { const x = generateMil(s, port, `c-s${i}`); if (x?.type === 'STRIKE') strikes.push(x); }
      st.board.missions = strikes; st.board.lastRefresh = -Infinity;
      s.clock.minute = Math.ceil((s.clock.minute + 1) / 10) * 10;
      contractsTick(s);
      const board = st.board.missions;
      assert(board.length <= st.board.maxMissions && board.some(m => !milRefusal(s, m)), `work for an ensign on the board (${board.map(m => m.type).join(' ')})`);
      delete st.tags.command;
    },
  },
  {
    name: 'military work: a strike on a high-value target, and holding a control point at a war front through the enemy\'s waves',
    fn: () => {
      const s = game(8, { license: 'UN', classId: 'unn-corvette' });
      s.politics.frozen = true;
      setPhase(s, 'UN', 'MCR', 'war');
      const z = spawnZone(s, { body: 'Ganymede', kind: 'front', factions: ['UN', 'MCR'], w: 1 });
      const world = getWorld(s);
      const st = world.get('luna-yards');
      const port = { ...st, tags: { command: { zone: z.id } } };
      s.service.rank = 2;
      const pick = (type) => { for (let i = 0; i < 80; i++) { const c = generateMil(s, port, `c-${type}${i}`); if (c?.type === type) return c; } return null; };
      // STRIKE
      const strike = pick('STRIKE');
      assert(strike && strike.rankMin === 2, 'a strike, for a lieutenant');
      st.board.missions.push(strike);
      placeAt(s, st.pos);
      let r = acceptContract(s, st.id, strike.id);
      assert(r.ok, r.text);
      const hvt = world.get(strike.targetId);
      assert(hvt?.agent && hvt.tags.hvt && hvt.faction === 'MCR', `the target is out there: ${hvt?.name}`);
      const escorts = [...world.driven].filter(e => e.tags?.contract === strike.id && e !== hvt);
      assert(escorts.length === strike.escorts, 'with its escorts');
      wreckNpc(s, hvt, PLAYER);
      contractsTick(s);
      assert(strike.phase === 'return', 'target destroyed: report in');
      r = completeContract(s, strike.id, st.id);
      assert(r.ok && s.service.kills === 1, r.text);
      // HOLD
      const hold = pick('HOLD');
      assert(hold, 'a point to hold');
      hold.holdMin = 90;
      st.board.missions.push(hold);
      r = acceptContract(s, st.id, hold.id);
      assert(r.ok && hold.allies.length === 3, r.text);
      const mark = world.get(hold.markId);
      placeAt(s, mark.pos, 'Ganymede');
      const enemies = () => [...world.driven].filter(e => e.tags?.contract === hold.id && e.faction === 'MCR').length;
      for (let m = 0; m < 200 && hold.phase === 'active'; m++) {
        s.clock.minute++;
        world.refresh(mark, s.clock.minute);
        s.flight.pos = { ...mark.pos };
        contractsTick(s);
      }
      console.log(`      ${strike.title} · ${hold.title}: held ${hold.held} min, ${hold.waves} wave(s), ${enemies()} enemy ships sent at it`);
      assert(hold.phase === 'return' && hold.waves >= 1 && enemies() >= 2, 'held, through a wave');
      assert(z.points.find(p => p.name === hold.point).held === 'UN', 'the point is ours');
    },
  },
  {
    name: 'the yards: lost warships are made good after their build time, lost traffic after a day or more, born at a yard',
    fn: () => {
      const s = game(7, { traffic: 200 });
      const world = getWorld(s);
      const navy = () => [...world.forces].filter(e => e.tags.force.role === 'navy' && e.faction === 'MCR').length;
      const n0 = navy();
      const lost = [...world.forces].filter(e => e.tags.force.role === 'navy' && e.faction === 'MCR').slice(0, 4);
      for (const e of lost) world.remove(e);
      assert(navy() === n0 - 4, 'four MCRN hulls gone');
      advance(s, DAY_MIN + 1);
      const queued = s.yards.queue.filter(b => b.faction === 'MCR' && b.role === 'navy');
      assert(queued.length === 4 && navy() === n0 - 4, `laid down, not yet built: ${queued.map(b => fmt((b.at - s.clock.minute) / DAY_MIN, 1)).join(', ')} days`);
      for (let d = 0; d < 30 && navy() < n0; d++) advance(s, DAY_MIN);
      console.log(`      MCRN back to ${navy()}/${NAVY_STRENGTH.MCR} after ${Math.round(s.clock.minute / DAY_MIN)} days · forces ${JSON.stringify(forcesSummary(s))}`);
      assert(navy() === n0, 'back to strength');
      // Traffic: a lost ship is replaced from a yard a day or more later
      const T = s.traffic;
      const q0 = T.queue.length;
      T.spawned -= 3;
      advance(s, 2 * 60);
      assert(T.queue.length > q0, 'replacements laid down');
      const at = T.queue[T.queue.length - 1].at;
      assert(at - s.clock.minute >= 20 * 60, 'not before a day');
    },
  },
];
