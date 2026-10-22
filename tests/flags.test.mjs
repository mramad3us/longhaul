// What the nav computer flags: ships running dark, what our work points
// at, the captain's own lettered flags (sim/flags.js), and that a flag
// lasts as long as the track does. A ship we hunt is named only by its
// transponder or its drive signature on file (sensors.js identifyHunt).
import { assert } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { getWorld } from '../js/sim/world.js';
import { sensorsTick, setSensorRange, contactById, identifyHunt, REVEAL } from '../js/sim/sensors.js';
import { targetName } from '../js/sim/nav.js';
import { newSignature } from '../js/sim/entities.js';
import { recordContacts } from '../js/sim/intel.js';
import { spawnAgent } from '../js/sim/agents.js';
import { missionTargets, toggleFlag, flagOf, flagList, flagsTick, FLAG_LETTERS } from '../js/sim/flags.js';

function game(seed = 7) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 4, traffic: 0, forces: false });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** A ship 30,000 km off us, at our velocity: on the board at once, even cold. */
function shipNear(s, opts = {}, offAU = 0.0002) {
  const f = s.flight;
  return spawnAgent(s, { role: 'civilian', faction: 'independent', pos: { x: f.pos.x + offAU, y: f.pos.y }, vel: { ...f.vel }, ...opts });
}

/** One look of the board, and the plot's note of what it lost. */
function look(s) { sensorsTick(s); recordContacts(s); }

export default [
  {
    name: 'a ship with no transponder is marked dark on the board, and on the plot once lost',
    fn: () => {
      const s = game(1);
      setSensorRange(s, 2);
      const dark = shipNear(s, { role: 'pirate', faction: 'pirate', transponder: false });
      const lit = shipNear(s, { transponder: true }, -0.0002);
      look(s);
      const cd = contactById(s, dark.id), cl = contactById(s, lit.id);
      const st = s.sensors.contacts.find(c => c.station);
      console.log(`      dark: ${cd?.dark} (named ${cd?.name ?? 'no'}) · squawking: ${cl?.dark} (${cl?.name}) · station: ${st ? st.dark : 'none on the board'}`);
      assert(cd && cd.dark && !cd.name, 'the pirate is on the board, dark and unnamed');
      assert(cl && !cl.dark && cl.name === lit.name, 'a ship squawking is not dark, and is named');
      assert(!st || !st.dark, 'a station is never dark');
      // Off the board: the plot's last fix remembers it ran dark
      getWorld(s).remove(lit);
      dark.pos = { x: s.flight.pos.x + 3, y: s.flight.pos.y };
      look(s);
      assert(!contactById(s, dark.id), 'the pirate is off the board');
      assert(s.intel.tracks[dark.id]?.dark === true, 'its last fix on the plot is marked dark');
    },
  },
  {
    name: 'mission targets: a job\'s ship (once named) and mark, a delivery port, a report port, a distress call, a call-up',
    fn: () => {
      const s = game(2);
      const world = getWorld(s);
      const [a, b, c] = world.stations;
      s.contracts.active.push(
        { id: 'c-1', type: 'BOUNTY', phase: 'active', station: a.id, targetId: 'ship-x', markId: 'mark-x', identified: 'signature' },
        { id: 'c-0', type: 'STRIKE', phase: 'active', station: a.id, targetId: 'ship-w', markId: 'mark-w' },
        { id: 'c-2', type: 'CARGO', phase: 'active', station: a.id, dest: b.id },
        { id: 'c-3', type: 'PASSENGERS', phase: 'active', station: a.id, dest: b.id },
        { id: 'c-4', type: 'SURVEY', phase: 'return', station: c.id, targetId: 'mark-y' },
        { id: 'c-5', type: 'SALVAGE', phase: 'failed', station: a.id, targetId: 'wreck-z' },
      );
      s.missions.list.push({ id: 'sos-1', status: 'accepted', entityId: 'ship-sos' }, { id: 'sos-2', status: 'offered', entityId: 'ship-other' });
      s.service.callups.push({ ship: 'cmd-1', heard: true, reported: false, over: false });
      const m = missionTargets(s);
      console.log(`      ${[...m].map(([id, t]) => `${id}=${t}`).join(' · ')}`);
      assert(m.get('ship-x') === 'BOUNTY' && m.get('mark-x') === 'BOUNTY', 'the bounty\'s ship (named) and its last-seen mark');
      assert(m.get('mark-w') === 'STRIKE' && !m.has('ship-w'), 'a strike target not yet named: only its last fix');
      assert(m.get(b.id) === 'CARGO · PAX', 'two jobs at one port read as both');
      assert(m.get(c.id) === 'TURN IN' && !m.has('mark-y'), 'a job done points at the port to report at, not its old mark');
      assert(!m.has('wreck-z'), 'a failed job points at nothing');
      assert(m.get('ship-sos') === 'DISTRESS' && !m.has('ship-other'), 'a distress call we answered, not one only offered');
      assert(m.get('cmd-1') === 'CALL-UP', 'a navy call-up');
    },
  },
  {
    name: 'flags: lettered A to Z, only on what we have a track of, freed when cleared',
    fn: () => {
      const s = game(3);
      setSensorRange(s, 2);
      const world = getWorld(s);
      const p = shipNear(s, { role: 'pirate', faction: 'pirate', transponder: false });
      const far = shipNear(s, {}, 2);                    // two AU off: no track of it
      look(s);
      const st = world.stations[0];
      const r1 = toggleFlag(s, p.id), r2 = toggleFlag(s, st.id);
      console.log(`      ${r1.text} · ${r2.text} · far: ${toggleFlag(s, far.id).text} · nav mark: ${toggleFlag(s, `${st.id}-gate`).text}`);
      assert(r1.ok && r1.letter === 'A' && r2.letter === 'B', 'A, then B');
      assert(r1.text.includes('unidentified'), 'an unidentified contact is flagged as one');
      assert(!flagOf(s, far.id), 'a ship we have no track of can\'t be flagged');
      assert(!flagOf(s, `${st.id}-gate`), 'nor a nav mark');
      assert(!toggleFlag(s, p.id).on && !flagOf(s, p.id), 'flagging again clears it');
      assert(toggleFlag(s, p.id).letter === 'A', 'and its letter is free again');
      // Every letter, then no more
      const ships = Array.from({ length: 30 }, (_, i) => shipNear(s, {}, 0.00002 * (i + 12)));
      look(s);
      let last = null;
      for (const e of ships) last = toggleFlag(s, e.id);
      assert(flagList(s).length === FLAG_LETTERS.length, 'twenty-six flags at most');
      assert(!last.ok && /flags are in use/.test(last.text), 'the next is refused');
    },
  },
  {
    name: 'a flag lasts as long as the track: called out back on the board, dropped when the plot lets go',
    fn: () => {
      const s = game(4);
      setSensorRange(s, 2);
      const events = [];
      const emit = (type, p) => events.push({ type, ...p });
      const p = shipNear(s, { role: 'pirate', faction: 'pirate', transponder: false });
      look(s);
      toggleFlag(s, p.id);
      flagsTick(s, emit);
      // Gone from the board: the plot keeps its fix, so the flag stays
      const at = { ...p.pos };
      p.pos = { x: s.flight.pos.x + 3, y: s.flight.pos.y };
      look(s); flagsTick(s, emit);
      assert(flagOf(s, p.id) === 'A' && !s.navFlags[p.id].live, 'off the board, still flagged on the plot');
      // Back: called out
      p.pos = at;
      look(s); flagsTick(s, emit);
      assert(events.some(e => e.type === 'flag-back' && e.letter === 'A'), 'back on the board is called out');
      // Off again, and the plot forgets it: the flag goes
      p.pos = { x: s.flight.pos.x + 3, y: s.flight.pos.y };
      look(s);
      delete s.intel.tracks[p.id];
      flagsTick(s, emit);
      console.log(`      ${events.map(e => `${e.type} ${e.letter}`).join(' · ')}`);
      assert(!flagOf(s, p.id) && events.some(e => e.type === 'flag-lost' && e.letter === 'A'), 'no track, no flag');
      // A destroyed ship gone from the world takes its flag too (through the minute tick)
      const q = shipNear(s, {});
      look(s);
      toggleFlag(s, q.id);
      getWorld(s).remove(q);
      advance(s, 1);
      assert(!flagOf(s, q.id), 'a ship that is gone takes its flag');
    },
  },
  {
    name: 'flags are saved, and an older save gets an empty set',
    fn: () => {
      const s = game(5);
      const st = getWorld(s).stations[2];
      toggleFlag(s, st.id);
      const back = deserialize(serialize(s)).state;
      assert(flagOf(back, st.id) === 'A', 'a flag survives a save');
      const old = JSON.parse(serialize(s));
      delete old.navFlags;
      const up = deserialize(old).state;
      assert(up.navFlags && !Object.keys(up.navFlags).length, 'filled in on load');
    },
  },
  {
    name: 'a hunted ship is named only by its transponder or its drive signature on file, never by a long look',
    fn: () => {
      const s = game(6);
      setSensorRange(s, 2);
      let n = 0;
      const hunt = (sig) => {
        const signature = sig ? newSignature() : null;
        const e = shipNear(s, { role: 'pirate', faction: 'pirate', transponder: false, name: 'Patient Rook', signature: signature || undefined }, 0.0002 + 0.00002 * n++);
        const c = { id: `c-${e.id}`, type: 'BOUNTY', phase: 'active', station: 'ceres-station', targetId: e.id, targetName: e.name, signature };
        s.contracts.active.push(c);
        return { e, c };
      };
      const a = hunt(true), b = hunt(false);
      assert(a.e.signature === a.c.signature, 'the pirate flies the signature the brief has on file');
      // Two hours' look: nothing names either
      for (let i = 0; i < 120; i++) { look(s); identifyHunt(s, a.c); identifyHunt(s, b.c); }
      const ca = contactById(s, a.e.id);
      console.log(`      after ${s.sensors.scan[a.e.id]} min of looking (a profile takes ${REVEAL.PROFILE}): ${ca?.name ?? 'unnamed'} · route label "${targetName(s, { kind: 'entity', id: a.e.id })}"`);
      assert(ca && !ca.name && !contactById(s, b.e.id).name, 'a long look names neither');
      assert(!missionTargets(s).has(a.e.id) && missionTargets(s).size === 0, 'neither is marked as our target');
      assert(targetName(s, { kind: 'entity', id: a.e.id }) === 'unidentified contact', 'nor named on a route');
      // Its drive lit: the signature on file matches
      a.e.thrust = 1; b.e.thrust = 1;
      look(s);
      assert(identifyHunt(s, a.c) && a.c.identified === 'signature', 'the plume shows the signature on file');
      assert(!identifyHunt(s, b.c), 'with none on file, a plume names nothing');
      look(s);
      assert(contactById(s, a.e.id).name === 'Patient Rook' && missionTargets(s).get(a.e.id) === 'BOUNTY', 'named, and marked BOUNTY');
      a.e.thrust = 0;
      look(s);
      assert(contactById(s, a.e.id).name === 'Patient Rook', 'named it stays, drive cold');
      // The other squawks: that names it too
      b.e.transponder = true;
      look(s);
      assert(identifyHunt(s, b.c) && b.c.identified === 'transponder', 'a transponder names it');
    },
  },
];
