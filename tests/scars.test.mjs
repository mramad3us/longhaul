// What hits leave on a hull, and what becomes of a hull set to blow.
// Scars (sim/damage.js): every hit marks the section it landed on, how
// hard, what made it, where (by a hash, never the dice), kept to the worst
// SCARS_MAX, carried in a save; our own hits name the deck they holed. How
// they look (ui/gl/damage.js, no GPU needed): placed on the hull's own
// surface, a wreck tumbling, broken-backed or not, its fragments drifting
// off, a ship hurt before scars were kept still marked. And scuttling: a
// boarded wreck's reactor set to blow goes up at its time (it has no pilot
// to count it down: the fuses), as does a wreck whose core a blast set
// failing; a hulk counted when it broke up is not counted again. A ship
// blown apart (an investigation's debris): only its pieces, spreading
// since it was lost, the telescope's sense of it the cloud's, nothing to
// dock with, board or hear; a derelict answers as the dead do.
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_M } from '../js/core/constants.js';
import { createGame, advance } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { spawnAgent } from '../js/sim/agents.js';
import { applyHit, wreckNpc, SCARS_MAX } from '../js/sim/damage.js';
import { ensureHull, PLAYER } from '../js/sim/combatants.js';
import { getWorld } from '../js/sim/world.js';
import { releaseHold, holdStation } from '../js/sim/autopilot.js';
import { startBoarding, orderAboard, SCUTTLE_FUSE_MIN } from '../js/sim/boarding.js';
import { hullOf } from '../js/sim/hulls.js';
import { damageLook, pieces } from '../js/ui/gl/damage.js';
import { fuseAboutToGo, FUSE_WATCH_MIN } from '../js/sim/combat.js';
import { advise } from '../js/ui/advisor.js';
import { blastClearM, blownCloud } from '../js/sim/damage.js';
import { acceptContract, dockedStation } from '../js/sim/contracts.js';
import { sightOf, scopeOf } from '../js/sim/telescope.js';
import { shipDockable } from '../js/sim/docking.js';
import { boardable } from '../js/sim/boarding.js';
import { crewAboard } from '../js/sim/manifest.js';
import { openChannel } from '../js/sim/dialogue.js';
import { CLASSES } from '../js/sim/ship-classes.js';

function game(seed = 21, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 8, traffic: 0, forces: false, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  releaseHold(s);
  s.dock = null;
  s.flight.pos.y += 0.02;
  return s;
}
const near = (s, cls, faction, m = 900) => spawnAgent(s, { role: 'civilian', cls, faction, pos: { x: s.flight.pos.x + m / AU_M, y: s.flight.pos.y }, vel: { ...s.flight.vel } });
const heard = (type) => { const got = []; bus.on(type, (p) => got.push(p)); return got; };
const run = (s, pred, max) => { let t = 0; while (t < max && !pred(s)) { advance(s, 1); t++; } return t; };

export default [
  {
    name: 'every hit leaves a scar where it landed: its section, how hard, what made it; placed by a hash, not the dice; the worst kept; saved',
    fn: () => {
      const s = game();
      const e = near(s, 'pirate-corvette', 'pirate', 5000);
      applyHit(s, e.id, { dp: 30, section: 'drive', kind: 'he', from: PLAYER, weapon: 'HE torpedo' });
      const h = ensureHull(e);
      assert(h.scars?.length === 1, 'one hit, one scar');
      const sc = h.scars[0];
      assert(sc.s === 'drive' && sc.k === 'he' && sc.r > 0 && sc.r <= 1 && sc.u >= 0 && sc.u < 1 && sc.v >= 0 && sc.v < 1 && sc.m === s.clock.minute, `the scar: ${JSON.stringify(sc)}`);
      // placed by the hull and the hit, not the dice: the same game played again marks it the same way;
      // another hull, elsewhere (that the dice are untouched: the combat suite's figures are the same with scars or without)
      const s2 = game();
      const e2 = near(s2, 'pirate-corvette', 'pirate', 5000);
      applyHit(s2, e2.id, { dp: 30, section: 'drive', kind: 'he', from: PLAYER, weapon: 'HE torpedo' });
      assert(e2.id === e.id && e2.combat.scars[0].u === sc.u && e2.combat.scars[0].v === sc.v, 'the same hull, hit the same way: the same place');
      const e3 = near(s2, 'pirate-corvette', 'pirate', 5000);
      applyHit(s2, e3.id, { dp: 30, section: 'drive', kind: 'he', from: PLAYER });
      assert(e3.combat.scars[0].u !== sc.u || e3.combat.scars[0].v !== sc.v, 'another hull, another place');
      for (let i = 0; i < 40; i++) { h.hp = h.hpMax; applyHit(s, e.id, { dp: 2 + (i % 7), section: 'hull', kind: 'pdc', from: PLAYER }); }
      assert(h.scars.length === SCARS_MAX, `kept to ${SCARS_MAX} (${h.scars.length})`);
      assert(h.scars.some(x => x.k === 'he'), 'the worst (the torpedo) kept over the slightest');
      // ours: the deck it holed
      applyHit(s, PLAYER, { dp: 25, section: 'reactor', kind: 'slug', from: e.id });
      const ours = s.hull.scars.at(-1);
      assert(ours?.d === 'reactor' && ours.k === 'slug', `our scar names the deck: ${JSON.stringify(ours)}`);
      const back = deserialize(serialize(s)).state;
      assert(getWorld(back).get(e.id).combat.scars.length === SCARS_MAX && back.hull.scars.length === s.hull.scars.length, 'scars carried in a save');
      console.log(`      a torpedo on the drive: r ${fmt(sc.r, 3)} at u ${fmt(sc.u, 2)} v ${fmt(sc.v, 2)} · 40 bursts of PDC kept to ${SCARS_MAX} · ours on the ${ours.d} deck`);
    },
  },
  {
    name: 'how damage looks: on the hull\'s own surface, a wreck tumbling and (mostly) broken-backed with its fragments, the same every time; old hurt hulls still marked',
    fn: () => {
      const s = game(22);
      const hull = hullOf('pirate-corvette');
      const b = hull.bounds, pad = 1;
      let broken = 0, wrecks = 0;
      for (let i = 0; i < 20; i++) {
        const e = near(s, 'pirate-corvette', 'pirate', 5000 + i * 100);
        applyHit(s, e.id, { dp: 25, aim: 'kill', precision: 0.5, kind: 'he', from: PLAYER });
        applyHit(s, e.id, { dp: 6, kind: 'pdc', from: PLAYER });
        const look = damageLook(e, hull, s.clock.minute);
        assert(look && look.scars.length === 2, 'two scars, two marks');
        for (const x of look.scars) assert(x.p[0] >= b.x0 - pad && x.p[0] <= b.x1 + pad && Math.abs(x.p[1]) <= hull.W / 2 + pad + 3 && Math.abs(x.p[2]) <= hull.H / 2 + pad + 3, `on the hull: ${x.p.map(v => v.toFixed(1))}`);
        assert(look.scars[0].kind === 0 && look.scars[0].hole === 1 && look.scars[0].heat > 0.9 && look.scars[0].vent >= 0, 'a fresh torpedo hole, hot');
        assert(look.scars[1].kind === 1, 'PDC: a peppering');
        assert(!look.tumble && !look.debris && look.lights > 0, 'still a ship: lit, holding its attitude');
        wreckNpc(s, e, PLAYER);
        const w = damageLook(e, hull, s.clock.minute + 30);
        wrecks++;
        assert(w.wreck && w.lights === 0 && w.tumble && Math.abs(w.tumble.deg) > 0 && w.debris.length > 20, 'a wreck: dark, tumbling, its fragments round it');
        assert(w.scars[0].heat < look.scars[0].heat, 'the hole cooling');
        if (w.broken) {
          broken++;
          const [fore, aft] = pieces(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), w);
          assert(fore.clip && aft.clip && w.broken.xc > b.x0 && w.broken.xc < b.x1, 'torn through somewhere along it, two pieces');
        }
        assert(JSON.stringify(damageLook(e, hull, s.clock.minute + 30)) === JSON.stringify(w), 'the same look every time');
      }
      console.log(`      of ${wrecks} wrecks, ${broken} broken-backed`);
      assert(broken > 5 && broken < wrecks, 'most, not all, broken-backed');
      // a hull hurt before scars were kept: its lost points shown all the same
      const old = near(s, 'pirate-corvette', 'pirate', 9000);
      const h = ensureHull(old);
      h.hp = h.hpMax * 0.4;
      const look = damageLook(old, hull, s.clock.minute);
      assert(look && look.scars.length >= 4 && look.worn > 0.5, 'an old save\'s hurt hull still marked');
      assert(damageLook(near(s, 'pirate-corvette', 'pirate', 9500), hull, s.clock.minute) === null, 'an untouched hull: nothing');
    },
  },
  {
    name: 'scuttling: a boarded wreck\'s reactor goes up on its time; a wreck a blast set failing goes up; a hulk already counted is not counted again',
    fn: () => {
      const s = game(23, { classId: 'mcrn-corvette', license: 'MCR' });
      const det = heard('detonation');
      const w = near(s, 'pirate-corvette', 'pirate', 900);
      wreckNpc(s, w, PLAYER);
      const kills = s.service.kills;
      const party = s.ship.crew.filter(m => m.role !== 'Captain' && m.role !== 'Pilot').slice(0, 3).map(m => m.id);
      const r = startBoarding(s, w.id, { party, via: 'eva' });
      assert(r.ok, r.text);
      run(s, st => st.boarding?.phase === 'secured' || st.boarding?.phase === 'done', 200);
      assert(s.boarding.phase === 'secured', `boarding: ${s.boarding.phase}`);
      const o = orderAboard(s, 'scuttle');
      assert(o.ok, o.text);
      const t0 = s.clock.minute;
      run(s, st => ensureHull(w).containment != null, 60);
      const setAt = s.clock.minute - t0;
      // the computer keeps the count: the party across, then how far to be clear
      const said = () => advise(s, {}).find(a => a.key === `scuttle:${w.id}`);
      const a1 = said();
      assert(a1 && /party is coming back/.test(a1.text) && /^(2h|1h 5\d)/.test(a1.text) && !a1.text.endsWith('…'), `while the party is across: ${a1?.text}`);
      assert(s.combat.fuses.includes(w.id), 'the wreck is on a fuse');
      // home, and well clear of it
      run(s, st => !st.boarding || st.boarding.phase === 'done', 120);
      const a2 = said();
      assert(a2 && /km clear of it/.test(a2.text) && !a2.text.endsWith('…'), `home, still inside its blast (${fmt(blastClearM(w), 0)} m): ${a2?.text}`);
      console.log(`      VIGIL: "${a1.text}" · then "${a2.text}"`);
      s.flight.pos.x += 0.004;
      assert(!said(), 'clear of it: nothing more to say');
      // its last minutes, watched: time at 1×, the telescope's to come up on it (ui/stage.js)
      let watched = false, warp = [];
      const t = run(s, st => {
        const live = getWorld(st).get(w.id);
        if (live && fuseAboutToGo(st) === live) { watched = true; warp.push(st.$combatWarp); }
        return !live;
      }, SCUTTLE_FUSE_MIN + 30);
      assert(watched && warp.length >= FUSE_WATCH_MIN - 1 && warp.every(x => x === 1), `its last minutes at 1× (${warp.join(',')})`);
      assert(!getWorld(s).get(w.id), `the wreck went up (${s.clock.minute - t0} min after the order)`);
      const upAt = s.clock.minute - t0;
      assert(upAt - setAt === SCUTTLE_FUSE_MIN, `on its two hours: charges set at ${setAt} min, up at ${upAt}`);
      assert(det.some(d => d.sourceId === w.id), 'a reactor detonation where it was');
      assert(s.service.kills === kills, `not counted twice (${kills} → ${s.service.kills})`);
      assert(!s.combat.fuses.includes(w.id), 'the fuse gone with it');
      // a wreck whose core a blast set failing
      const w2 = near(s, 'pirate-corvette', 'pirate', 5000);
      wreckNpc(s, w2, null);
      const h2 = ensureHull(w2);
      h2.reactor = 0.2;
      applyHit(s, w2.id, { dp: 40, spread: true, kind: 'blast', from: null });
      assert(h2.containment != null && s.combat.fuses.includes(w2.id), 'a blast set its core failing');
      run(s, st => !getWorld(st).get(w2.id), 40);
      assert(!getWorld(s).get(w2.id), 'and it went up');
      console.log(`      scuttled: charges set ${setAt} min after the order, up ${upAt - setAt} min later (the last ${t} with the party home) · kills ${kills} → ${s.service.kills} · the blasted wreck up within 30 min`);
    },
  },
  {
    name: 'a ship blown apart: its pieces spreading, no hull, nobody there',
    fn: () => {
      seedRandom(5);
      bus.clear();
      const s = createGame({ crewCount: 6, traffic: 0, forces: false });
      s.politics.quietUntil = Infinity;
      s.missions.cooldown = 1e9;
      const st = dockedStation(s);
      const find = () => {
        for (let i = 0; i < 80; i++) { st.board.lastRefresh = -Infinity; st.board.missions = []; advance(s, 10); const c = st.board.missions.find(x => x.type === 'INVESTIGATE'); if (c) return c; }
        return null;
      };
      const c = find();
      assert(c, 'no investigation posted');
      c.outcome = 'debris';
      // (lost as long before it was posted as its brief says)
      assert(c.offeredAt - c.lostAt === 60 * Number(/comms (\d+) hours ago/.exec(c.description)[1]), 'lost when the brief says');
      assert(acceptContract(s, st.id, c.id).ok, 'accept');
      const e = getWorld(s).get(c.targetId);
      assert(e.tags.blown && e.tags.wreck && e.combat.status === 'wreck' && e.combat.wreckedAt === c.lostAt, 'spawned blown apart, when it was lost');
      // what the cameras draw: no hull, only its pieces and the ice, the same every look
      const hull = hullOf(e.cls), tm = c.lostAt + 3 * 1440;
      const look = damageLook(e, hull, tm);
      assert(look.blown && !look.scars.length && look.lights === 0 && look.debris.length >= 80 && look.ice.length > 20, 'its pieces, no hull');
      assert(JSON.stringify(damageLook(e, hull, tm).debris) === JSON.stringify(look.debris), 'the same cloud every look');
      // spreading: the core grows as its heavy pieces creep apart, the small stuff long gone past it
      const early = blownCloud(e, c.lostAt + 360), late = blownCloud(e, tm);
      const out = look.debris.filter(d => d.d0 + d.v * look.debris.sinceS > late.r).length;
      assert(late.r > early.r && out > look.debris.length / 2, 'spreading');
      // the telescope: its size is the core's, its light the pieces' (dimmer than the whole hull)
      const at = { ...s, clock: { minute: tm } }, from = { x: e.pos.x, y: e.pos.y + 2000 / AU_M }, sc = scopeOf(s);
      const seen = sightOf(at, e, e.pos, from, sc), whole = sightOf(at, { ...e, tags: {} }, e.pos, from, sc);
      assert(Math.abs(seen.angRad * seen.distM - 2 * late.r) < 1, 'framed on the core');
      assert(seen.hullMag > whole.hullMag, 'its pieces throw back less light than its hull would');
      console.log(`      ${e.shipClass}, ${fmt(hull.L, 0)} m: core ${fmt(early.r, 0)} m after 6 h, ${fmt(late.r, 0)} m after 3 days (${look.debris.length - out} of ${look.debris.length} pieces in it); mag ${fmt(seen.hullMag)} at 2 km, its hull ${fmt(whole.hullMag)}`);
      // nothing to dock with, board, or hear
      assert(!shipDockable(s, e).ok && !boardable(s, e).ok && crewAboard(e) === 0, 'nothing aboard');
      assert(/Nothing on any band/.test(openChannel(s, e.id).lines[0].text), 'no one answers');
      // a derelict: a dead hull, uninvited alongside, nobody answering
      const d = find();
      d.outcome = 'derelict';
      assert(acceptContract(s, st.id, d.id).ok, 'accept the derelict');
      const h = getWorld(s).get(d.targetId);
      assert(!h.tags.blown && h.tags.derelict && crewAboard(h) === 0 && shipDockable(s, h).uninvited, 'a dead hull');
      assert(/Dead air/.test(openChannel(s, h.id).lines[0].text), 'dead air');
      // a save from before: the debris spawned whole, the derelict crewed; blown and dead on load, lost when its brief says
      for (const x of [e, h]) { delete x.tags.blown; delete x.tags.wreck; delete x.tags.derelict; delete x.combat; delete x.crewAboard; }
      delete c.lostAt; delete d.lostAt;
      const back = deserialize(serialize(s)).state;
      const e2 = getWorld(back).get(e.id), h2 = getWorld(back).get(h.id);
      const c2 = back.contracts.active.find(x => x.id === c.id);
      assert(e2.tags.blown && e2.combat.wreckedAt === c2.lostAt && c2.offeredAt - c2.lostAt === 60 * Number(/comms (\d+) hours ago/.exec(c2.description)[1]), 'an old debris target blown on load');
      assert(h2.tags.derelict && !h2.tags.blown && crewAboard(h2) === 0, 'an old derelict dead on load');
    },
  },
  {
    name: 'a salvage job\'s derelict is a wreck with a hull: the telescope and the cameras have something to draw, docking its collars, boarding something to cut up, the radio nothing; a save\'s is mended on load',
    fn: () => {
      seedRandom(21);
      bus.clear();
      const s = createGame({ crewCount: 6, traffic: 0, forces: false });
      s.politics.quietUntil = Infinity;
      s.missions.cooldown = 1e9;
      const st = dockedStation(s);
      let c = null;
      for (let i = 0; i < 120 && !c; i++) { st.board.lastRefresh = -Infinity; st.board.missions = []; advance(s, 10); c = st.board.missions.find(x => x.type === 'SALVAGE'); }
      assert(c, 'no salvage posted');
      assert(acceptContract(s, st.id, c.id).ok, 'accept');
      const e = getWorld(s).get(c.targetId), hull = hullOf(e.cls);
      assert(hull && e.shipClass === CLASSES[e.cls].name, `a hull of a class (${e.cls})`);
      // a wreck to everything that reads one, dark, nobody aboard, dead weeks
      const age = (s.clock.minute - e.combat.wreckedAt) / 1440;
      assert(e.tags.wreck && e.tags.derelict && !e.tags.blown && e.combat.status === 'wreck' && !e.transponder && crewAboard(e) === 0 && age >= 3 && age <= 61, `dead ${fmt(age, 0)} days`);
      // what the pictures draw: the hull, broken and unlit, and the telescope's size is the hull's
      const look = damageLook(e, hull, s.clock.minute);
      assert(look && !look.blown && look.lights === 0, 'drawn as a dead hull');
      const sight = sightOf(s, e, e.pos, { x: e.pos.x, y: e.pos.y + 2000 / AU_M }, scopeOf(s));
      assert(sight.regime === 'resolved' && Math.abs(sight.angRad * sight.distM / sight.foreshorten - hull.L) < 1, 'resolved at its own length');
      // the job itself: held on it, the crew work it
      releaseHold(s);
      s.dock = null;
      s.flight.pos = { x: e.pos.x + 900 / AU_M, y: e.pos.y }; s.flight.vel = { ...e.vel };
      assert(holdStation(s, { kind: 'entity', id: e.id }) !== false, 'held on it');
      advance(s, 5);
      assert((c.worked || 0) >= 4, `worked while we hold on it (${c.worked})`);
      // alongside uninvited, its collars there, a party can cross, and nobody answers
      assert(shipDockable(s, e).ok && shipDockable(s, e).uninvited && hull.ports.length > 0, 'collars to come alongside at');
      assert(boardable(s, e).ok, 'boardable');
      assert(/Dead air|Nothing on any band/.test(openChannel(s, e.id).lines[0].text), 'no one answers');
      // a save from before: no class, not a wreck; a real hull on load, the job going on
      const was = `${e.shipClass}, ${fmt(hull.L, 0)} m, ${hull.ports.length} collars`;
      for (const k of ['cls', 'combat', 'crewAboard']) delete e[k];
      e.tl = 2; e.faction = 'independent'; e.shipClass = 'Hulk'; e.mass = 90_000;
      delete e.tags.wreck; delete e.tags.derelict;
      const back = deserialize(serialize(s)).state, e2 = getWorld(back).get(e.id);
      assert(hullOf(e2.cls) && e2.tags.wreck && e2.tags.derelict && e2.combat.status === 'wreck' && crewAboard(e2) === 0, 'mended on load');
      assert(back.contracts.active.find(x => x.id === c.id)?.worked === c.worked, 'the job as it was');
      console.log(`      ${was}, dead ${fmt(age, 0)} days; an old save's mended on load as a ${e2.shipClass}`);
    },
  },
];
