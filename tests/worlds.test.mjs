// ============================================================
// LONGHAUL — Tests: worlds, their space, their air, their ground
//
// A world holds a planetary space out to where its pull falls to 0.01 G,
// with high orbits a route can end in (the parking orbit at its edge, the
// stationary orbit over an airspace), low orbit and the air below; the
// nav computer keeps our hull out of the air and the planner refuses a
// route into it; a ship in it is dragged; the ground of the settled worlds
// is shared into airspaces with their spaceports (nobody's on Mercury,
// Venus and Io), and sites come from seeds. Every body has its sheet.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_M, DAY_MIN, G0 } from '../js/core/constants.js';
import { createGame, advance } from '../js/sim/game.js';
import { releaseHold, engageRoute, overrideSecure } from '../js/sim/autopilot.js';
import { planRoutes } from '../js/sim/nav.js';
import { terrainGuard } from '../js/sim/terrain.js';
import { BODIES, getBody, bodyPos, bodyVel } from '../js/sim/ephemeris.js';
import {
  WORLDS, worldOf, atmosphere, layerOf, airspacesOf, airspaceAt, groundAngle, worldAngle, proceduralSite, solarDayH, orbitPeriodS, airDrag, settlementOf,
} from '../js/sim/worlds.js';
import { BODY_FACTS } from '../js/sim/bodyfacts.js';
import { bodySheet } from '../js/ui/bodysheet.js';

/** A game away from any port, the ship set down beside a world at `offAU` from it, co-moving. */
function nearWorld(name, offAU, seed = 3) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 4, traffic: 0, forces: false, docked: false });
  s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
  releaseHold(s); s.dock = null;
  const b = getBody(name), d = s.clock.minute / DAY_MIN;
  const c = bodyPos(b, d), v = bodyVel(b, d);
  s.flight.pos = { x: c.x + offAU, y: c.y + offAU * 0.4 }; s.flight.vel = { ...v };
  return s;
}
const from = (s, name) => { const c = bodyPos(getBody(name), s.clock.minute / DAY_MIN); return { rM: Math.hypot(s.flight.pos.x - c.x, s.flight.pos.y - c.y) * AU_M, ang: Math.atan2(s.flight.pos.y - c.y, s.flight.pos.x - c.x) }; };

export default [
  {
    name: 'a world\'s planetary space ends at 0.01 G (inside half its Hill sphere); its stationary orbit lies inside it or there is none; the air is the column its pressure and scale height make',
    fn: () => {
      const e = worldOf('Earth'), m = worldOf('Mars');
      assert(Math.abs(e.wellM / 63_754e3 - 1) < 0.01 && Math.abs(m.wellM / 20_898e3 - 1) < 0.01, `Earth ${fmt(e.wellM / 1000, 0)} km, Mars ${fmt(m.wellM / 1000, 0)} km`);
      assert(Math.abs(e.sync / 42_164e3 - 1) < 0.001 && m.sync && m.sync < m.wellM, 'Earth\'s stationary orbit 42,164 km; Mars\' inside its space');
      for (const n of ['Venus', 'Luna', 'Ganymede', 'Mercury']) assert(!worldOf(n).sync && worldOf(n).syncWhy, `${n}: no stationary orbit, and why`);
      const io = worldOf('Io');
      assert(io.wellM < Math.sqrt(io.GM / (0.01 * G0)) && Math.abs(io.wellM / (0.5 * io.hillM) - 1) < 1e-9, 'Io\'s held inside half its Hill sphere');
      assert(!worldOf('Ceres') && !worldOf('Phobos'), 'the rocks are no worlds');
      for (const w of WORLDS) {
        assert(w.wellM > w.R && w.parkM < w.wellM && w.low[0] > w.floorM && w.low[1] > w.low[0], `${w.name}: its layers in order`);
        assert(layerOf(w, w.parkM) === 'high' && layerOf(w, (w.low[0] + w.low[1]) / 2) === 'low' && layerOf(w, w.wellM * 1.01) === null, `${w.name}: layers`);
      }
      const rho = (n, km) => atmosphere(worldOf(n), km * 1000).rho;
      assert(Math.abs(rho('Earth', 0) - 1.22) < 0.05 && rho('Earth', 10) < 0.45 && rho('Earth', 200) === 0, `Earth's air: ${rho('Earth', 0).toFixed(3)} at the ground, none over its interface`);
      assert(rho('Venus', 0) > 50 && rho('Mars', 0) > 0.6 && rho('Mars', 0) < 0.9 && rho('Titan', 0) > 1, `Venus thick, Mars terraformed (${rho('Mars', 0).toFixed(2)} kg/m³: thinner than Earth's sea level), Titan thicker than Earth`);
      assert(worldOf('Jupiter').atmo.giant && Math.abs(rho('Jupiter', 0) - 0.15) < 0.03, 'a giant: its 1-bar level at its radius');
      assert(Math.abs(solarDayH(getBody('Earth')) - 24) < 0.05 && Math.abs(solarDayH(getBody('Mars')) - 24.66) < 0.05 && Math.abs(solarDayH(getBody('Venus')) / 24 - 116.75) < 0.2 && Math.abs(solarDayH(getBody('Luna')) / 24 - 29.53) < 0.05, 'days sun to sun');
      console.log(`      ${WORLDS.map(w => `${w.name} ${fmt(w.wellM / 1000, 0)} km`).join(' · ')}`);
    },
  },
  {
    name: 'the ground is shared out: airspaces round each world\'s equator by its size, each with its controller and spaceport; the giants have none; sites come from seeds',
    fn: () => {
      const n = (name) => airspacesOf(worldOf(name)).length;
      assert(n('Earth') === 11 && n('Mars') === 6 && n('Luna') === 3 && n('Titan') === 5 && n('Europa') === 3 && n('Ganymede') === 5 && n('Callisto') === 4, `Earth ${n('Earth')}, Mars ${n('Mars')}, Luna ${n('Luna')}`);
      for (const g of ['Jupiter', 'Saturn', 'Uranus', 'Neptune']) assert(n(g) === 0, `${g}: no ground, no airspaces`);
      for (const u of ['Mercury', 'Venus', 'Io']) assert(n(u) === 0 && !settlementOf(worldOf(u)).settled && settlementOf(worldOf(u)).note, `${u}: nobody's ground (${settlementOf(worldOf(u)).note.slice(0, 40)}…)`);
      const m = worldOf('Mars'), air = airspacesOf(m);
      assert(air[0].a0 === 0 && Math.abs(air.at(-1).a1 - 2 * Math.PI) < 1e-12 && air.every((a, i) => i === 0 || a.a0 === air[i - 1].a1), 'they cover the equator, end to end');
      assert(air.every(a => a.authority === 'MCR' && a.port.ang >= a.a0 && a.port.ang < a.a1 && a.ceilingM === m.low[1]), 'Martian, each port inside its own, up through low orbit');
      for (const a of air) assert(airspaceAt(m, (a.a0 + a.a1) / 2) === a, `the middle of ${a.name} is ${a.name}`);
      const t = 12_345;
      assert(Math.abs(groundAngle(m, worldAngle(m, 1.234, t), t) - 1.234) < 1e-9, 'ground and plane angles, both ways');
      const s1 = proceduralSite(m, 99), s2 = proceduralSite(m, 99), s3 = proceduralSite(m, 100);
      assert(s1.name === s2.name && s1.ang === s2.ang && s1.id !== s3.id && airspaceAt(m, s1.ang).id === s1.airspace, `the same seed, the same site: ${s1.name} (${s1.kind}, ${s1.airspace})`);
      assert(proceduralSite(worldOf('Jupiter'), 1) === null, 'none on a giant');
    },
  },
  {
    name: 'a route to a world ends in a high orbit: its parking orbit at the edge of planetary space, held free; or its stationary orbit over an airspace, the ground staying put below',
    fn: () => {
      const rows = [];
      for (const [name, off] of [['Mars', 0.02], ['Jupiter', 0.05]]) {
        const s = nearWorld(name, off);
        const w = worldOf(name);
        const opts = planRoutes(s, { kind: 'body', id: name }, { orbit: true });
        assert(opts.every(o => o.plan.target.kind === 'orbit' && Math.abs(o.plan.target.rKm * 1000 / w.parkM - 1) < 1e-9), `${name}: every profile to its parking orbit`);
        const o = opts.find(x => x.name === 'STANDARD');
        assert(o.feasible, `${name}: ${o.reason}`);
        engageRoute(s, o.plan); overrideSecure(s);
        let t = 0;
        while (s.autopilot && t < 10 * DAY_MIN) { advance(s, 1); t++; }
        assert(s.flight.hold?.kind === 'orbit', `${name}: held on the orbit (${s.flight.hold?.kind})`);
        const fuel0 = s.resources.fuel.current;
        let peak = 0;
        for (let i = 0; i < 6 * 60; i++) { advance(s, 1); peak = Math.max(peak, s.flight.thrustG || 0); }
        const r = from(s, name).rM;
        assert(Math.abs(r / w.parkM - 1) < 1e-3 && peak < 1e-3 && fuel0 - s.resources.fuel.current < 0.01, `${name}: on it, free (${fmt(r / 1000, 0)} km, ${peak.toExponential(1)} G)`);
        rows.push(`${name} parking orbit ${fmt(w.parkM / 1000, 0)} km in ${Math.round(t / 60)} h, held at ${peak.toExponential(1)} G`);
      }
      // the stationary orbit over an airspace: Earth's Sunda
      const s = nearWorld('Earth', 0.01);
      const w = worldOf('Earth');
      const o = planRoutes(s, { kind: 'body', id: 'Earth' }, { over: 'Earth:3' }).find(x => x.name === 'STANDARD');
      assert(o.plan.target.over === 'Earth:3' && Math.abs(o.plan.target.rKm * 1000 / w.sync - 1) < 1e-9, 'to the stationary orbit, over Sunda');
      engageRoute(s, o.plan); overrideSecure(s);
      let t = 0;
      while (s.autopilot && t < 10 * DAY_MIN) { advance(s, 1); t++; }
      const under = () => airspaceAt(w, groundAngle(w, from(s, 'Earth').ang, s.clock.minute)).name;
      const u0 = under();
      advance(s, 12 * 60);
      assert(s.flight.hold?.kind === 'orbit' && u0 === 'Sunda' && under() === 'Sunda' && Math.abs(from(s, 'Earth').rM / w.sync - 1) < 1e-3, `over Sunda, and still over it twelve hours on (${u0} → ${under()})`);
      rows.push(`stationary over ${u0} in ${Math.round(t / 60)} h`);
      console.log(`      ${rows.join(' · ')}`);
    },
  },
  {
    name: 'our hull keeps out of the air (shuttles go down: shuttles.test.mjs): the planner refuses a route into a world\'s air, and the guard keeps a falling ship out of it (a rock\'s ground as before)',
    fn: () => {
      const s = nearWorld('Earth', 0.005);
      // (the brachistochrones: a ballistic arc fails on its own account)
      const opts = planRoutes(s, { kind: 'surface', id: 'Earth', ang: 0 }).filter(o => o.name !== 'BALLISTIC');
      assert(opts.length && opts.every(o => !o.feasible && /atmosphere/.test(o.reason)), `refused: ${opts.map(o => o.reason).join(' / ')}`);
      // a ship 300 km over Earth's air, falling at 2 km/s: the guard climbs out
      const w = worldOf('Earth'), c = bodyPos(w.body, s.clock.minute / DAY_MIN), v = bodyVel(w.body, s.clock.minute / DAY_MIN);
      const r = (w.R + w.atmo.interfaceM + 300e3) / AU_M;
      const pos = { x: c.x + r, y: c.y }, vel = { vx: v.vx - 2000, vy: v.vy };
      const g = terrainGuard(pos, vel, { ax: 0, ay: 0 }, null, 3 * G0, s.clock.minute);
      assert(g?.climb && g.ax > 0, `a climb, away from the air (${g ? g.ax.toFixed(1) : 'none'})`);
    },
  },
  {
    name: 'in a world\'s air the ship is dragged: its speed through the air (which turns with the world) falls, and what it feels is kept for the displays',
    fn: () => {
      const s = nearWorld('Earth', 0.01);
      const w = worldOf('Earth'), c = bodyPos(w.body, s.clock.minute / DAY_MIN), v = bodyVel(w.body, s.clock.minute / DAY_MIN);
      const r = (w.R + 70e3) / AU_M;
      s.flight.pos = { x: c.x + r, y: c.y }; s.flight.vel = { vx: v.vx, vy: v.vy + 7500 };
      const v0 = Math.hypot(s.flight.vel.vx - v.vx, s.flight.vel.vy - v.vy);
      airDrag(s, 60);
      const v1 = Math.hypot(s.flight.vel.vx - v.vx, s.flight.vel.vy - v.vy);
      assert(v1 < v0 - 100 && s.$air && s.$air.rho > 0 && s.$air.heat > 1e5, `slowed ${fmt(v0, 0)} → ${fmt(v1, 0)} m/s · ${s.$air.rho.toPrecision(2)} kg/m³ · ${fmt(s.$air.heat / 1000, 0)} kW/m²`);
      s.flight.pos = { x: c.x + 2 * w.R / AU_M, y: c.y };
      airDrag(s, 60);
      assert(!s.$air, 'over the air, nothing');
    },
  },
  {
    name: 'the nav computer says where we are among the worlds: into planetary space, the airspace below in low orbit, out again',
    fn: () => {
      const s = nearWorld('Mars', 0.0001);          // (16,000 km out: inside its 20,900)
      const said = [];
      bus.on('nav-callout', (p) => said.push(p.text));
      advance(s, 1);
      assert(s.flight.world?.name === 'Mars' && /planetary space/.test(said.join(' ')), `in Mars' space: ${said[0]}`);
      // down to low orbit over an airspace (set there, co-moving with the world)
      const w = worldOf('Mars'), c = bodyPos(w.body, s.clock.minute / DAY_MIN), v = bodyVel(w.body, s.clock.minute / DAY_MIN);
      const r = (w.low[0] + w.low[1]) / 2 / AU_M;
      s.flight.pos = { x: c.x + r, y: c.y }; s.flight.vel = { ...v };
      advance(s, 1);
      assert(s.flight.world.layer === 'low' && s.flight.world.airspace && said.some(t => /low orbit/.test(t)) && said.some(t => /airspace/.test(t)), `low orbit over ${s.flight.world.airspace}`);
      s.flight.pos = { x: c.x + 0.01, y: c.y }; s.flight.vel = { ...v };
      advance(s, 1);
      assert(!s.flight.world && said.some(t => /Out of Mars/.test(t)), 'out again');
    },
  },
  {
    name: 'every body has its sheet: what it is, its orbit, its turn and day, its air, and a world its space and airspaces; the Sun its class',
    fn: () => {
      const s = nearWorld('Earth', 0.01);
      for (const b of BODIES) {
        const html = bodySheet(s, b.name);
        assert(html && !/undefined|NaN/.test(html), `${b.name}: a sheet, every figure there`);
        if (b.type === 'star') { assert(/G2V/.test(html), 'the Sun\'s class'); continue; }
        assert(BODY_FACTS[b.name], `${b.name}: its facts`);
        assert(/ORBIT/.test(html) && /SPIN/.test(html) && /ATMOSPHERE/.test(html), `${b.name}: the sections`);
        if (worldOf(b)) assert(/PLANETARY SPACE/.test(html), `${b.name}: its space`);
      }
      assert(/AIRSPACES · 11/.test(bodySheet(s, 'Earth')) && /ORBIT OVER/.test(bodySheet(s, 'Earth')) && !/ORBIT OVER/.test(bodySheet(s, 'Luna')), 'Earth\'s airspaces, with its stationary orbit over them; not Luna\'s');
    },
  },
];
