// Politics: spheres of influence, hot zones, the encounter director, conflict contracts.
import { assert, fmt } from './helpers.mjs';
import { DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { getBody, bodyPos } from '../js/sim/ephemeris.js';
import { controlAt, spaceLabel } from '../js/sim/factions.js';
import { zoneCandidates, spawnZone, zonePos, zonesAt, director, spawnEncounter, ZONE_CAP } from '../js/sim/conflict.js';
import { acceptContract, ContractType, contractsTick } from '../js/sim/contracts.js';
import { explodeNpc } from '../js/sim/damage.js';
import { spawnAgent } from '../js/sim/agents.js';
import { gateId } from '../js/sim/stations.js';
import { keepOutM } from '../js/sim/traffic-control.js';
import { AU_M } from '../js/core/constants.js';

function game(seed = 5) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 4, traffic: 0 });
  s.missions.cooldown = 1e9;
  return s;
}

const at = (name, minute = 0) => bodyPos(getBody(name), minute / DAY_MIN);

export default [
  {
    name: 'spheres of influence: Earth, Mars and the Belt are held; deep space is not',
    fn: () => {
      const cases = [['Earth', 'UN'], ['Luna', 'UN'], ['Mars', 'MCR'], ['Phobos', 'MCR'], ['Ceres', 'OPA'], ['Tycho/Juno', 'OPA', 'Juno'], ['Titan', 'OPA']];
      for (const [label, want, body = label] of cases) {
        const p = at(body);
        const c = controlAt(p.x, p.y, 0);
        assert(c.faction === want, `${label}: ${spaceLabel(c)}`);
      }
      const gany = at('Ganymede');
      const g = controlAt(gany.x, gany.y, 0);
      console.log(`      Ganymede: ${spaceLabel(g)} · Pallas: ${spaceLabel(controlAt(at('Pallas').x, at('Pallas').y, 0))}`);
      assert(g.contested, 'Ganymede is contested between Earth and Mars');
      const deep = controlAt(0, 4.4, 0);
      assert(!deep.faction, `between Belt and Jupiter: ${spaceLabel(deep)}`);
    },
  },
  {
    name: 'hot zones are born where influence overlaps or fails, and come and go',
    fn: () => {
      const s = game(7);
      const cands = zoneCandidates(s);
      const kinds = new Set(cands.map(c => c.kind));
      console.log(`      ${cands.length} candidates: ${[...kinds].join(', ')}`);
      assert(kinds.has('pirates') && kinds.has('standoff'), 'pirate havens and contested places');
      const seen = new Set();
      for (let d = 0; d < 60; d++) {
        advance(s, DAY_MIN);
        for (const z of s.politics.zones) seen.add(`${z.kind}@${z.body}`);
        assert(s.politics.zones.length <= ZONE_CAP, 'zone cap');
      }
      console.log(`      60 days: ${seen.size} zones (${[...seen].slice(0, 8).join(', ')}…); tension ${Object.entries(s.politics.tension).map(([k, v]) => `${k} ${fmt(v, 2)}`).join(', ')}`);
      assert(seen.size >= 3, 'zones should come and go');
    },
  },
  {
    name: 'the director sends pirates into a pirate zone and patrols into held space',
    fn: () => {
      const s = game(9);
      const z = spawnZone(s, { body: 'Hygiea', kind: 'pirates', factions: ['pirate'], w: 1 });
      z.intensity = 1;
      s.flight.pos = { ...zonePos(z, s.clock.minute) };
      assert(zonesAt(s, s.flight.pos).includes(z), 'we are in the zone');
      const roles = {};
      for (let h = 0; h < 72; h++) {
        s.politics.quietUntil = 0;
        const e = director(s);
        if (e) roles[e.agent.role] = (roles[e.agent.role] || 0) + 1;
        for (const x of [...getWorld(s).driven]) if (x.agent?.ambient) getWorld(s).remove(x);   // keep the cap free
      }
      console.log(`      72 h in a pirate zone near Hygiea: ${JSON.stringify(roles)}`);
      assert((roles.pirate || 0) + (roles.civilian || 0) > 0, 'pirates (or their victims) should show up');
      const b = spawnEncounter(s, { kind: 'battle', zone: { id: 'z', factions: ['UN', 'MCR'] } });
      assert(b?.agent.hostile.length === 1, 'warships spawn at war');
    },
  },
  {
    name: 'a bounty: the wanted pirate is out there, and destroying it pays at the station',
    fn: () => {
      const s = game(13);
      const world = getWorld(s);
      const st = world.get('ceres-station');
      const c = { id: 'c-t', type: ContractType.BOUNTY, station: st.id, stationName: st.name, phase: 'offered', zone: null,
        ship: { cls: 'pirate-raider', name: 'Test Raider', faction: 'pirate', tl: 1, shipClass: 'Pirate raider', mass: 700 },
        body: 'Ceres', distAU: 0.01, reward: { credits: 5000 }, aliveBonus: 0.5, deadline: 10 * DAY_MIN, expires: s.clock.minute + DAY_MIN, title: 'Bounty: Test Raider' };
      st.board.missions.push(c);
      st.board.lastRefresh = s.clock.minute;
      const r = acceptContract(s, st.id, c.id);
      assert(r.ok, r.text);
      const pirate = world.get(c.targetId);
      assert(pirate?.agent?.role === 'pirate' && pirate.tags.wanted, 'the wanted pirate is in the world');
      pirate.combat.hp = 0;
      pirate.combat.status = 'wreck';
      contractsTick(s);
      assert(c.phase === 'return', 'bounty earned, return to the station');
    },
  },
  {
    name: 'an escort: at every station the convoy waits outside the gate, leaves when we join it there, and berths at its destination',
    fn: () => {
      const s = game(21);
      s.politics.quietUntil = Infinity;
      const world = getWorld(s);
      const rows = [];
      let trip = null;
      for (const st of world.stations) {
        const gate = world.get(gateId(st.id));
        world.refresh(gate, s.clock.minute);
        const dest = world.stations.filter(x => x !== st).sort((a, b) => Math.hypot(a.pos.x - st.pos.x, a.pos.y - st.pos.y) - Math.hypot(b.pos.x - st.pos.x, b.pos.y - st.pos.y))[0];
        const c = { id: `c-e-${st.id}`, type: ContractType.ESCORT, station: st.id, stationName: st.name, phase: 'offered', zone: null,
          dest: dest.id, destName: dest.name, ship: { cls: 'hauler', name: `Test Hauler ${st.id}`, faction: 'independent', tl: 2, shipClass: 'Hauler', mass: 9e6 }, g: 0.3,
          reward: { credits: 3000 }, deadline: 60 * DAY_MIN, expires: s.clock.minute + DAY_MIN, title: 'Escort' };
        st.board.missions.push(c); st.board.lastRefresh = s.clock.minute;
        // in port: at the gate, where a route to the station ends
        s.flight.hold = null; s.dock = null;
        s.flight.pos = { ...gate.pos }; s.flight.vel = { ...gate.vel };
        const r = acceptContract(s, st.id, c.id);
        assert(r.ok, `${st.id}: ${r.text}`);
        const convoy = world.get(c.targetId);
        const fromStation = Math.hypot(convoy.pos.x - st.pos.x, convoy.pos.y - st.pos.y) * AU_M;
        assert(fromStation > keepOutM(st.id), `${st.id}: the convoy waits outside the keep-out (${Math.round(fromStation / 1000)} km out, keep-out ${keepOutM(st.id) / 1000} km)`);
        contractsTick(s);
        assert(c.phase === 'underway', `${st.id}: joined at the gate, the convoy should get under way (${c.phase})`);
        c.ambushAt = null;
        rows.push(`${st.id} ${Math.round(fromStation / 1000)} km out`);
        if (st.id === 'phobos-yard') trip = { c, convoy, dest };
      }
      // the Phobos convoy flown to its destination's gate, and in to a berth
      let t = 0;
      for (; t < 30 * DAY_MIN && trip.c.phase === 'underway'; t += 60) { advance(s, 60); contractsTick(s); }
      console.log(`      convoys wait: ${rows.join(' · ')}; Phobos → ${trip.dest.name}: ${trip.c.phase} after ${fmt(t / DAY_MIN)} days, ${trip.convoy.tags.berth ? 'in berth ' + trip.convoy.tags.berth : 'at the anchorage'}`);
      assert(trip.c.phase === 'arrived', `the convoy should reach ${trip.dest.name}: ${trip.c.phase}`);
      assert(trip.convoy.tags.at === trip.dest.id, 'and be berthed there');
    },
  },
  {
    name: 'a bounty or a strike target blown apart by its reactor is destroyed, not got away (it leaves no wreck)',
    fn: () => {
      const s = game(14);
      const world = getWorld(s);
      const st = world.get('ceres-station');
      const c = { id: 'c-r', type: ContractType.BOUNTY, station: st.id, stationName: st.name, phase: 'offered', zone: null,
        ship: { cls: 'pirate-raider', name: 'Wolfish Ferret', faction: 'pirate', tl: 1, shipClass: 'Pirate raider', mass: 700 },
        body: 'Ceres', distAU: 0.01, reward: { credits: 5000 }, aliveBonus: 0.5, deadline: 10 * DAY_MIN, expires: s.clock.minute + DAY_MIN, title: 'Bounty: Wolfish Ferret' };
      st.board.missions.push(c);
      st.board.lastRefresh = s.clock.minute;
      assert(acceptContract(s, st.id, c.id).ok, 'accepted');
      // and a strike on another ship, the same way
      const other = spawnAgent(s, { role: 'pirate', faction: 'pirate', pos: { x: s.flight.pos.x + 0.003, y: s.flight.pos.y }, vel: { ...s.flight.vel } });
      const k = { id: 'c-s', type: 'STRIKE', mil: true, phase: 'active', faction: 'UN', targetId: other.id, targetName: other.name, title: 'Strike', dueAt: s.clock.minute + DAY_MIN, deadline: DAY_MIN, reward: { credits: 1 } };
      s.contracts.active.push(k);
      const failed = [];
      const emit = (t, p) => { if (t === 'contract-failed') failed.push(p.contract?.id); };
      explodeNpc(s, world.get(c.targetId), 'player', emit);
      explodeNpc(s, other, 'player', emit);
      assert(!world.get(c.targetId) && !world.get(other.id), 'both are gone from space');
      contractsTick(s, emit);
      console.log(`      bounty ${c.phase} (${c.outcome}) · strike ${k.phase} · failed: ${failed.join(', ') || 'none'}`);
      assert(c.phase === 'return' && c.outcome === 'destroyed', 'the bounty is earned: return to the station');
      assert(k.phase !== 'failed' && !failed.length, 'the strike is done, not failed');
    },
  },
];
