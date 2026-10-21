// Combat: ship classes, torpedoes, point defense, railguns, damage, NPC behaviour, law.
import { assert, fmt } from './helpers.mjs';
import { AU_M, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance } from '../js/sim/game.js';
import { getWorld } from '../js/sim/world.js';
import { CLASSES, CLASS_IDS, SIZES, TECH, BUILDERS, KINDS, PLAYABLE, rollIdentity } from '../js/sim/ship-classes.js';
import { hullOf } from '../js/sim/hulls.js';
import { spawnAgent, respondToRequest, surrender, makeHostile, ROLES } from '../js/sim/agents.js';
import { launchTorpedo, fireRailgun } from '../js/sim/ordnance.js';
import { applyHit, detonate } from '../js/sim/damage.js';
import { PLAYER, ensureHull, profile, gunner, isOutOfFight, classStrength } from '../js/sim/combatants.js';
import { setFireTarget, fireTorpedo, setPdcMode, setEvasive } from '../js/sim/combat.js';
import { sensorsTick } from '../js/sim/sensors.js';
import { circularSpeed } from '../js/sim/ephemeris.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { releaseHold } from '../js/sim/autopilot.js';

function game(seed = 11, classId) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 6, traffic: 0, classId });
  s.missions.cooldown = 1e9;                  // no distress calls
  s.politics.quietUntil = Infinity;           // no random encounters
  s.politics.zones = [];
  releaseHold(s);
  // out in the black, away from Ceres and its station's guns (station-defense.js)
  s.flight.pos.y += 0.02;
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

/** How a ship came out of a fight: 'destroyed' | 'disabled' | 'surrendered' | 'fled' | 'fighting'. */
function fate(e) {
  if (!e || e.combat?.status === 'wreck') return 'destroyed';
  if (e.combat.status === 'surrendered') return 'surrendered';
  if (e.combat.status === 'disabled' || e.combat.drive < 0.25) return 'disabled';
  if (e.agent.mode === 'flee' || e.agent.mode === 'leave') return 'fled';
  return 'fighting';
}

/**
 * Two warships meet in a skirmish (as the encounter director stages it,
 * 225,000 km apart) and fight for half a day: the loser may run, and be run
 * down. Returns the fates and how much structure each kept.
 */
function duel(clsA, clsB, seed, minutes = 12 * 60) {
  const s = game(seed);
  const world = getWorld(s);
  const { pos, vel } = near(s, 0.02);
  const fa = CLASSES[clsA].builder === 'Belt' ? 'OPA' : CLASSES[clsA].builder;
  const fb = CLASSES[clsB].builder === 'Belt' ? 'OPA' : CLASSES[clsB].builder;
  const a = spawnAgent(s, { role: 'navy', cls: clsA, faction: fa, pos, vel, enemies: [fb] });
  const bpos = { x: pos.x + 0.0015, y: pos.y };
  const b = spawnAgent(s, { role: 'navy', cls: clsB, faction: fb, pos: bpos, vel, enemies: [fa] });
  makeHostile(s, a, b.id);
  makeHostile(s, b, a.id);
  advance(s, minutes);
  untilQuiet(s, 6 * 60);
  const left = (e) => world.get(e.id) && e.combat.status !== 'wreck' ? e.combat.hp / e.combat.hpMax : 0;
  return { a: fate(world.get(a.id)), b: fate(world.get(b.id)), hpA: left(a), hpB: left(b) };
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
    name: 'the catalog: every kind is built by several yards, and the yard fixes the tech',
    fn: () => {
      const kinds = {};
      for (const id of CLASS_IDS) {
        const c = CLASSES[id];
        assert(hullOf(id)?.parts.length && hullOf(id).ports.length, `${id}: no hull or no docking collar`);
        assert(c.crew[0] <= c.crewStd && c.crewStd <= c.crew[1], `${id}: usual complement outside its rating`);
        assert(SIZES[c.size], `${id}: unknown size`);
        assert(TECH[c.tl], `${id}: bad TL`);
        assert(BUILDERS[c.builder] && KINDS[c.kind], `${id}: builder/kind`);
        assert(c.drive.maxG >= c.drive.cruiseG, `${id}: drive`);
        assert(Object.keys(c.factions).length, `${id}: nobody flies it`);
        assert(c.desc, `${id}: no description`);
        (kinds[c.kind] ||= []).push(id);
        // Mars builds the best, Earth the middle, the Belt refits
        if (c.builder === 'MCR') assert(c.tl >= 3 && (c.category !== 'military' || c.tl === 4), `${id}: Martian TL`);
        if (c.builder === 'UN') assert(c.tl === 2 || c.tl === 3, `${id}: Earth TL`);
        if (c.builder === 'Belt') assert(c.tl === 1, `${id}: Belt TL`);
        // Civilians are unarmed, bar the named exceptions
        if (c.category === 'civilian' && id !== 'light-freighter') {
          assert(!c.tubes && !c.railgun, `${id}: civilian with ship-killing weapons`);
          assert(!c.pdc || c.kind === 'liner', `${id}: civilian with PDCs`);
        }
        if (c.gear) assert(c.kind === 'miner' || c.kind === 'prospector', `${id}: gear on a non-miner`);
      }
      for (const [k, ids] of Object.entries(kinds)) assert(ids.length >= 2, `${k}: only ${ids.join()}`);
      console.log(`      ${CLASS_IDS.length} classes in ${Object.keys(kinds).length} kinds; ${PLAYABLE.length} we can start in`);
      assert(new Set(PLAYABLE.map(id => CLASSES[id].builder)).size === 4, 'a start from every yard');
      seedRandom(3);
      for (let i = 0; i < 200; i++) {
        const id = rollIdentity({ category: 'civilian', near: 'OPA' });
        assert(CLASSES[id.cls].category === 'civilian', 'civilian roll');
        assert(id.tl === CLASSES[id.cls].tl, 'tech level');
      }
      for (const f of ['UN', 'MCR', 'OPA']) {
        const id = rollIdentity({ kind: 'frigate', category: 'military', faction: f });
        assert(CLASSES[id.cls].kind === 'frigate' && CLASSES[id.cls].factions[f], `${f} frigate: ${id.cls}`);
      }
      // OPA builds no destroyers: it sends the nearest thing it has
      assert(CLASSES[rollIdentity({ kind: 'destroyer', category: 'military', faction: 'OPA' }).cls].factions.OPA, 'fallback stays in the faction');
    },
  },
  {
    name: 'warships with nothing inbound close to their standoff',
    fn: () => {
      // Each closes on where the other is, not on its thrust (matching each
      // other's burn, two ships would fly side by side). Magazines empty:
      // with torpedoes inbound a naval crew closes slowly on purpose, and
      // the fight is decided long before they meet.
      const s = game(31);
      const world = getWorld(s);
      const { pos, vel } = near(s, 0.02);
      const a = spawnAgent(s, { role: 'navy', cls: 'unn-corvette', faction: 'UN', pos, vel, enemies: ['MCR'] });
      const b = spawnAgent(s, { role: 'navy', cls: 'mcrn-corvette', faction: 'MCR', pos: { x: pos.x + 0.0015, y: pos.y }, vel, enemies: ['UN'] });
      for (const e of [a, b]) ensureHull(e).magazine = { he: 0, nuke: 0 };
      makeHostile(s, a, b.id);
      makeHostile(s, b, a.id);
      const nerve = ROLES.navy.breakOff;
      ROLES.navy.breakOff = 0;
      let closest = Infinity;
      const start = 0.0015 * AU_M;
      try {
        for (let t = 0; t < 150; t++) {
          advance(s, 1);
          const A = world.get(a.id), B = world.get(b.id);
          if (!A || !B || A.combat.status === 'wreck' || B.combat.status === 'wreck') break;
          closest = Math.min(closest, Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y) * AU_M);
        }
      } finally { ROLES.navy.breakOff = nerve; }
      console.log(`      from ${fmt(start / 1000)} km: closest ${fmt(closest / 1000)} km in 2½ hours (navy standoff ${fmt(ROLES.navy.standoffM / 1000)} km)`);
      assert(closest < 2 * ROLES.navy.standoffM, 'the two warships never closed to their standoff');
    },
  },
  {
    name: 'ships are not equal: the yard and the tech level decide a fight between hulls of a size',
    fn: () => {
      const rating = (id) => fmt(classStrength(id), 0);
      console.log(`      strength: corvettes OPA refit ${rating('opa-corvette')} · UNN Harrier ${rating('unn-corvette')} · MCRN Tharsis ${rating('mcrn-corvette')}; frigates OPA refit ${rating('opa-frigate')} · UNN Danube ${rating('unn-frigate')} · UNN Everest ${rating('unn-frigate-new')} · MCRN Hellas ${rating('mcrn-frigate')}`);
      const bouts = [
        ['opa-corvette', 'mcrn-frigate', 'Belt refit corvette vs Martian frigate'],
        ['opa-frigate', 'mcrn-frigate', 'Belt refit frigate vs Martian frigate'],
        ['unn-frigate', 'mcrn-frigate', 'Earth TL2 frigate vs Martian frigate'],
        ['unn-frigate-new', 'mcrn-frigate', 'Earth TL3 frigate vs Martian frigate'],
        ['opa-corvette', 'unn-corvette', 'Belt refit corvette vs Earth corvette'],
        ['unn-corvette', 'mcrn-corvette', 'Earth corvette vs Martian corvette'],
      ];
      const trials = 12;
      const won = {};
      const run = (x, y, label) => {
        let wx = 0, wy = 0, draw = 0, keptY = 0;
        const fates = {};
        for (let k = 0; k < trials; k++) {
          const r = duel(x, y, 700 + k);
          const outX = r.a !== 'fighting', outY = r.b !== 'fighting';
          if (outX && !outY) wy++; else if (outY && !outX) wx++; else draw++;
          keptY += r.hpB;
          fates[r.a] = (fates[r.a] || 0) + 1;
        }
        won[`${x}>${y}`] = wx;
        const how = Object.entries(fates).map(([f, n]) => `${n} ${f}`).join(', ');
        console.log(`      ${label}: ${wy}–${wx}${draw ? ` (${draw} undecided)` : ''} · the ${CLASSES[y].name} kept ${fmt(keptY / trials * 100, 0)}% structure · the ${CLASSES[x].name}: ${how}`);
      };
      console.log('      — as the AI fights (the outgunned break off):');
      for (const [x, y, label] of bouts) run(x, y, label);
      console.log('      — nobody breaks off:');
      const nerve = ROLES.navy.breakOff;
      ROLES.navy.breakOff = 0;
      try { for (const [x, y, label] of bouts) run(x, y, label); } finally { ROLES.navy.breakOff = nerve; }
      assert(won['opa-corvette>mcrn-frigate'] === 0 && won['opa-frigate>mcrn-frigate'] === 0, 'a Belt refit never beats a Martian frigate');
      assert(won['unn-frigate>mcrn-frigate'] <= 1, 'an old Earth frigate should almost never beat a Martian one');
      // Earth's best wins about one bout in four (SHIPS.md: thirty bouts); in twelve, never most of them
      assert(won['unn-frigate-new>mcrn-frigate'] <= trials / 2, 'even Earth\'s best frigate should not beat a Martian one as often as not');
      assert(won['unn-corvette>mcrn-corvette'] <= 2 && won['opa-corvette>unn-corvette'] <= 1, 'TL decides between corvettes');
    },
  },
  {
    name: 'our ship in a Belt junker cannot win against a Martian frigate; it can against a pirate',
    fn: () => {
      const fight = (classId, enemy, faction, role, seed) => {
        const s = game(seed, classId);
        const world = getWorld(s);
        s.combatStations = true;
        advance(s, 60);                       // everyone strapped in
        s.sensors.range = 2;
        const { pos, vel } = near(s, 0.003);
        const e = spawnAgent(s, { role, cls: enemy, faction, pos, vel, enemies: ['player'] });
        makeHostile(s, e, PLAYER);
        setPdcMode(s, 'engage');
        setEvasive(s, true);
        let t = 0;
        while (t < 24 * 60 && !s.lost && !isOutOfFight(world.get(e.id)) && fate(world.get(e.id)) === 'fighting') {
          sensorsTick(s);
          if (s.combat.target !== e.id) setFireTarget(s, e.id);
          fireTorpedo(s, { warhead: 'he', profile: 'fast' });
          advance(s, 1); t++;
          if (profile(s, PLAYER).maxG <= 0) break;             // dead in space: as good as lost
        }
        const crippled = s.lost || profile(s, PLAYER).maxG <= 0 || s.hull.integrity < 25;
        return { crippled, enemy: fate(world.get(e.id)), hull: s.hull.integrity, enemyHp: world.get(e.id) ? e.combat.hp / e.combat.hpMax : 0 };
      };
      const trials = 6;
      const tally = (classId, enemy, faction, role) => {
        let lost = 0, beat = 0, hull = 0, hurt = 0;
        for (let k = 0; k < trials; k++) {
          const r = fight(classId, enemy, faction, role, 800 + k);
          if (r.crippled) lost++;
          if (r.enemy !== 'fighting' && !r.crippled) beat++;
          hull += r.hull; hurt += 1 - r.enemyHp;
        }
        console.log(`      ${CLASSES[classId].name} vs ${CLASSES[enemy].name}: we were crippled or killed ${lost}/${trials}, won ${beat}/${trials}; our hull ${fmt(hull / trials, 0)}%, theirs lost ${fmt(hurt / trials * 100, 0)}%`);
        return { lost, beat };
      };
      const junk = tally('opa-corvette', 'mcrn-frigate', 'MCR', 'navy');
      const ours = tally('light-freighter', 'mcrn-frigate', 'MCR', 'navy');
      const pirate = tally('light-freighter', 'pirate-gunship', 'pirate', 'pirate');
      assert(junk.beat === 0 && junk.lost === trials, 'a Belt junker must not survive a Martian frigate');
      assert(ours.beat === 0, 'nor an armed freighter');
      assert(pirate.beat >= pirate.lost, 'an armed freighter should hold its own against a pirate gunship');
    },
  },
  {
    name: 'a mining barge has no weapons, but a ship that closes to rake it meets its ore drivers',
    fn: () => {
      let fired = 0, dp = 0, hull = 0;
      const trials = 6;
      for (let k = 0; k < trials; k++) {
        const s = game(900 + k);
        const ev = recorder();
        s.sensors.range = 2;
        const { pos, vel } = near(s, 4_000 / AU_M);              // 4 km off: inside our PDCs' reach, and its drivers'
        const barge = spawnAgent(s, { role: 'civilian', cls: 'mining-barge', faction: 'OPA', pos, vel });
        sensorsTick(s);
        setFireTarget(s, barge.id);
        setPdcMode(s, 'engage');
        advance(s, 30);
        const shots = (ev['gear-fired'] || []).filter(g => g.from === barge.id);
        fired += shots.length;
        dp += shots.reduce((a, g) => a + g.dp, 0);
        hull += s.hull.integrity;
      }
      console.log(`      raking a mining barge at 4 km: ${fmt(fired / trials, 0)} minutes of ore-driver fire back, ${fmt(dp / trials, 0)} DP thrown, our hull ${fmt(hull / trials, 0)}%`);
      assert(fired > 0 && dp > 0, 'the barge should turn its gear on us');
      assert(profile(game(1), PLAYER).gear === null, 'our armed freighter carries no mining gear');
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
          const e = spawnAgent(s, { role: 'navy', cls: 'mcrn-corvette', faction: 'MCR', pos, vel });
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
        const gun = spawnAgent(s, { role: 'navy', cls: 'unn-frigate-new', faction: 'UN', pos: s.flight.pos, vel: s.flight.vel });
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
      const close = spawnAgent(s, { role: 'civilian', cls: 'hermes', faction: 'UN', pos: { x: pos.x + 1000 / AU_M, y: pos.y }, vel });
      const far = spawnAgent(s, { role: 'civilian', cls: 'hermes', faction: 'UN', pos: { x: pos.x + 50_000 / AU_M, y: pos.y }, vel });
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
    name: 'saves carry ordnance, agents and politics',
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
    },
  },
];
