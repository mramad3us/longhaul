// ============================================================
// LONGHAUL — Tests: the war cycle as a closed loop
//
// Peace, a fight, the navies sent, the forward commands on their posts,
// the fighting (unseen, with real ships), the yards making good what is
// lost and the fights topped up from the berths, peace again, everyone
// home and nothing left over. Each link (forces.js, conflict.js), then
// the whole loop over a year of a default game with nobody watching.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { getWorld, backgroundBudget } from '../js/sim/world.js';
import { spawnZone } from '../js/sim/conflict.js';
import { setPhase } from '../js/sim/politics.js';
import { forcesAt, wreckInPlace, rouse, NAVY_STRENGTH, ZONE_FORCES, commandShipFor } from '../js/sim/forces.js';

/** A game with its forces, the player out of it (state.lost: nothing wakes for us), a war held between two powers. */
function wargame(seed, { traffic = 600, war = ['UN', 'MCR'] } = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 4, docked: false, traffic, forces: true });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  s.lost = { cause: 'test', at: 0 };
  if (war) { s.politics.frozen = true; setPhase(s, war[0], war[1], 'war'); }
  return s;
}
/** Navy hulls of a power tied to a zone (on their way or on station). */
const tied = (s, z, fac) => [...getWorld(s).forces].filter(e => e.tags.force.role === 'navy' && e.faction === fac && e.tags.force.zone === z.id);
const berthed = (s, fac) => [...getWorld(s).forces].filter(e => e.tags.force.role === 'navy' && e.faction === fac && e.tags.force.state === 'berth' && !e.tags.force.zone);
/** Run a stretch the way a warp does (lite minutes, the world's background each 24). */
function run(s, minutes, each = null) {
  const world = getWorld(s);
  for (let m = 0; m < minutes; m++) {
    minuteTick(s, { lite: m % 24 !== 23 });
    if (m % 24 === 23) world.background(s.clock.minute, backgroundBudget(world.count, 24));
    if (each && m % 60 === 59) each();
  }
}

export default [
  {
    name: 'hulls come from the yards, never from thin air: a fight that begins with a navy\'s berths empty gets none on the spot, and they go together once enough are launched',
    fn: () => {
      const s = wargame(3);
      const world = getWorld(s);
      // (Mars's navy all lost: the census lays it down again, at its yards' pace)
      for (const e of [...world.forces]) if (e.tags.force.role === 'navy' && e.faction === 'MCR') world.remove(e);
      const z = spawnZone(s, { body: 'Ganymede', kind: 'skirmish', factions: ['UN', 'MCR'], until: s.clock.minute + 90 * DAY_MIN, w: 1 });
      const want = Math.max(1, Math.round(ZONE_FORCES.skirmish[1] * NAVY_STRENGTH.MCR));
      assert(tied(s, z, 'MCR').length === 0 && [...world.forces].filter(e => e.tags.force.role === 'navy' && e.faction === 'MCR').length === 0, 'nothing commissioned on the spot');
      assert(tied(s, z, 'UN').length >= 1, 'the UN, in port, sends its squadron at once');
      let first = null, launched = 0;
      for (let d = 1; d <= 40 && !first; d++) {
        run(s, DAY_MIN);
        launched = [...world.forces].filter(e => e.tags.force.role === 'navy' && e.faction === 'MCR').length;
        const n = tied(s, z, 'MCR').length;
        if (n) first = { day: d, n, launched };
      }
      console.log(`      Mars's berths empty: its first ${first?.n} of ${want} sent on day ${first?.day}, with ${first?.launched} hulls launched`);
      assert(first && first.n >= Math.ceil(0.6 * want), `they go together, not one by one: ${first?.n} of ${want}`);
    },
  },
  {
    name: 'a fight cut down is made up from the berths: a squadron lost, the next day\'s top-up sends what is in port',
    fn: () => {
      const s = wargame(4);
      const world = getWorld(s);
      const z = spawnZone(s, { body: 'Ganymede', kind: 'skirmish', factions: ['UN', 'MCR'], until: s.clock.minute + 90 * DAY_MIN, w: 1 });
      z.wrecks = 999;                   // (no unseen losses but ours)
      const first = tied(s, z, 'MCR');
      assert(first.length >= 2, `a squadron sent: ${first.length}`);
      for (const e of first) wreckInPlace(s, e, 'Ganymede');
      assert(tied(s, z, 'MCR').length === 0, 'cut down');
      const inPort = berthed(s, 'MCR').length;
      run(s, 2 * DAY_MIN);
      const again = tied(s, z, 'MCR');
      console.log(`      ${first.length} MCRN hulls lost at Ganymede; ${again.length} sent again from the ${inPort} in port`);
      assert(again.length === first.length && again.every(e => !first.includes(e)), 'the squadron made up, from the berths');
    },
  },
  {
    name: 'a warship home from a fight is berthed, though we are at its yard (none kept awake cruising off the slips)',
    fn: () => {
      seedRandom(5); bus.clear();
      const s = createGame({ crewCount: 4, docked: true, license: 'UN', classId: 'unn-corvette', forces: true, traffic: 300 });
      s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
      const world = getWorld(s);
      const hulls = berthed(s, 'UN').slice(0, 4);
      for (const e of hulls) rouse(s, e);
      assert(hulls.every(e => e.agent), 'woken beside us');
      for (let m = 0; m < 6 * 60; m++) { minuteTick(s); if (s.dock?.lease) s.dock.lease.until = s.clock.minute + DAY_MIN; }
      const back = hulls.filter(e => !e.agent && ['berth', 'transit'].includes(e.tags.force.state));
      console.log(`      ${hulls.length} UNN hulls woken at Luna's yards with us there: ${back.length} back in their berths within six hours (${hulls.map(e => e.tags.force.state).join(', ')})`);
      assert(back.length === hulls.length, 'all back on rails, home');
      void world;
    },
  },
  {
    name: 'every kind of fight costs both sides: a proxy\'s raiders hunted by the navy they prey on, an insurgency\'s cells and the runners it stops, raiders lost to a hauler\'s guns',
    fn: () => {
      const s = wargame(6, { traffic: 3000, war: null });
      const world = getWorld(s);
      s.politics.frozen = true;
      setPhase(s, 'UN', 'OPA', 'crisis');
      const P = s.politics;
      const px = { id: 'proxy-test', backer: 'OPA', target: 'UN', sub: 'opa-ceres', since: s.clock.minute, until: s.clock.minute + 200 * DAY_MIN, exposed: false };
      P.proxies.push(px);
      const proxy = spawnZone(s, { body: 'Vesta', kind: 'proxy', factions: ['UN'], proxy: px.id, sub: px.sub, backer: 'OPA', until: px.until, w: 1 });
      const insurgency = spawnZone(s, { body: 'Ganymede', kind: 'insurgency', factions: ['MCR'], until: s.clock.minute + 200 * DAY_MIN, w: 1 });
      const pirates = spawnZone(s, { body: 'Hygiea', kind: 'pirates', factions: ['pirate'], sub: 'loca-greiga', until: s.clock.minute + 200 * DAY_MIN, w: 1 });
      for (const z of [proxy, insurgency, pirates]) z.intensity = 1;
      const seen = { proxy: [], insurgency: [], pirates: [] };
      bus.on('zone-incident', (p) => { for (const z of [proxy, insurgency, pirates]) if (p.zoneId === z.id) seen[z.kind].push(p.text); });
      // (intensity held: the politics frozen would let it drift down)
      for (let d = 0; d < 120; d++) { run(s, DAY_MIN); for (const z of [proxy, insurgency, pirates]) z.intensity = 1; }
      const hunted = seen.proxy.filter(t => /hunted down|lost near/.test(t)).length, taken = seen.proxy.filter(t => /taken by/.test(t)).length;
      const mined = seen.insurgency.filter(t => /cell's mine/.test(t)).length, stopped = seen.insurgency.filter(t => /suspected of running|bombed by the cells/.test(t)).length;
      const toll = seen.pirates.filter(t => /to the guns of/.test(t)).length, prizes = seen.pirates.filter(t => /taken by raiders/.test(t)).length;
      console.log(`      120 days: proxy raiders ${hunted} fought out with the UNN, ${taken} haulers taken · insurgency: ${mined} MCRN hulls to the cells, ${stopped} runners stopped or bombed · pirates: ${prizes} taken, ${toll} raiders lost to their prey`);
      assert(hunted >= 1, 'the navy on station fights the proxy\'s raiders');
      assert(mined >= 1 && stopped >= 1, 'an insurgency costs the navy, and the navy its runners');
      assert(prizes >= 1, 'pirates take haulers');
      void world;
    },
  },
  {
    name: 'a long war is fought all the way through: at most ten losses at a front in any eight days, and on past ten',
    fn: () => {
      const s = wargame(3);
      const z = spawnZone(s, { body: 'Ganymede', kind: 'front', factions: ['UN', 'MCR'], until: s.clock.minute + 200 * DAY_MIN, w: 1 });
      let worst = 0;
      run(s, 60 * DAY_MIN, () => { z.intensity = 0.85; worst = Math.max(worst, z.lossAt.filter(t => s.clock.minute - t <= 8 * DAY_MIN).length); });
      const there = forcesAt(s, z);
      console.log(`      60 days at the front: ${z.wrecks} lost, at most ${worst} in eight days; on station now UN ${there.UN?.length || 0}, MCR ${there.MCR?.length || 0}`);
      assert(z.wrecks > 10, 'the fighting goes on past ten');
      assert(worst <= 10, 'never more than ten in eight days');
    },
  },
  {
    name: 'the loop closes over a year: fights come and go by kind, each sends its navies and its forward commands, none outlives its fight, the navies stay within strength',
    fn: () => {
      seedRandom(11); bus.clear();
      const s = createGame({ crewCount: 4, docked: false });
      s.missions.cooldown = 1e9;
      s.lost = { cause: 'test', at: 0 };
      const world = getWorld(s);
      const born = {}, ended = {}, live = new Map(), gone = [];
      let over = 0, fobless = 0, naval = 0, orphans = 0, wrecks = 0;
      for (let d = 0; d < 365; d++) {
        run(s, DAY_MIN);
        const ids = new Set(s.politics.zones.map(z => z.id));
        for (const z of s.politics.zones) if (!live.has(z.id)) { live.set(z.id, z); born[z.kind] = (born[z.kind] || 0) + 1; }
        for (const [id, z] of live) if (!ids.has(id)) { live.delete(id); gone.push(z); ended[z.kind] = (ended[z.kind] || 0) + 1; wrecks += z.wrecks; }
        // the navies within strength; nobody tied to a fight that is over; no post or anchor left without its fight
        const navy = {};
        for (const e of world.forces) {
          const f = e.tags.force;
          if (f.role === 'navy') navy[e.faction] = (navy[e.faction] || 0) + 1;
          if (f.zone && !ids.has(f.zone)) orphans++;
        }
        for (const [fac, n] of Object.entries(navy)) if (n > NAVY_STRENGTH[fac]) over++;
        for (const z of gone.splice(0)) if (world.get(`anchor-${z.id}`) || z.factions.some(f => world.get(`command-${z.id}-${f}`))) orphans++;
        // a fight between two powers a week old has its forward commands (one per power that sends one), or none in port
        for (const z of s.politics.zones) {
          if (z.factions.length !== 2 || s.clock.minute - z.born < 7 * DAY_MIN) continue;
          naval++;
          if (z.factions.some(f => ['UN', 'MCR', 'OPA'].includes(f) && !commandShipFor(s, z.id, f))) fobless++;
        }
      }
      const kinds = Object.keys(born);
      console.log(`      a year: born ${JSON.stringify(born)} · ended ${JSON.stringify(ended)} · ${wrecks} lost in the fights that ended · fight-days without a forward command ${fobless} of ${naval}`);
      assert(kinds.length >= 4, `fights of several kinds: ${kinds.join(', ')}`);
      assert(Object.values(ended).reduce((a, b) => a + b, 0) >= 10, 'and they end');
      assert(wrecks > 0, 'with ships lost in them');
      assert(over === 0, 'no navy over strength, ever');
      assert(orphans === 0, 'nothing outlives its fight');
      assert(fobless <= naval * 0.25, 'a forward command at nearly every fight');
    },
  },
];
