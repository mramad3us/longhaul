// What we know and who is out there: light lag, the plot, traffic digests,
// the background forces waking around us and going back on rails.
import { assert, fmt } from './helpers.mjs';
import { AU_M, AU_KM, DAY_MIN } from '../js/core/constants.js';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame, advance, minuteTick } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { getWorld } from '../js/sim/world.js';
import { getBody, bodyPos, bodyVel } from '../js/sim/ephemeris.js';
import { spawnZone, zonePos } from '../js/sim/conflict.js';
import { relay, estimate, lightMinutes, liveKnowledge, INTEL_MAX } from '../js/sim/intel.js';
import { forcesSummary, forcesAt, WAKE_AU, SLEEP_AU, NAVY_STRENGTH, POLICE_PER_STATION } from '../js/sim/forces.js';
import { DEFAULT_TRAFFIC } from '../js/sim/traffic.js';

function game(seed = 11, opts = {}) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ crewCount: 4, ...opts });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** Put the ship somewhere, at rest in the local frame of a body (no station-keeping). */
function placeAt(s, pos, body = null) {
  const f = s.flight;
  f.hold = null;
  f.pos = { x: pos.x, y: pos.y };
  const v = body ? bodyVel(getBody(body), s.clock.minute / DAY_MIN) : { vx: 0, vy: 0 };
  f.vel = { vx: v.vx, vy: v.vy };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export default [
  {
    name: 'light lag: news from an AU away arrives eight minutes late',
    fn: () => {
      const s = game(1, { traffic: 0 });
      const heard = [];
      bus.on('zone-news', (p) => heard.push({ at: s.clock.minute, ...p }));
      const f = s.flight.pos;
      const sent = s.clock.minute;
      relay(s, { x: f.x + 1, y: f.y }, 'zone-news', { text: 'test' });
      relay(s, { x: f.x + 5, y: f.y }, 'zone-news', { text: 'far test' });
      advance(s, 60);
      console.log(`      1 AU: heard after ${heard[0]?.at - sent} min (light ${fmt(lightMinutes(1), 1)}); 5 AU: ${heard[1]?.at - sent} min`);
      assert(heard.length === 2, 'both arrive within the hour');
      assert(Math.abs(heard[0].at - sent - lightMinutes(1)) <= 1, '1 AU takes 8.3 minutes');
      assert(heard[1].lagMin >= 41, 'five AU takes 41 minutes');
    },
  },
  {
    name: 'the plot: thousands of ships, a live board of what is near, reports of the rest',
    fn: () => {
      const s = game(2);
      const world = getWorld(s);
      advance(s, DAY_MIN);
      const ships = s.entities.filter(e => e.type === 'ship');
      const board = s.sensors.contacts.length;
      const tracks = Object.values(s.intel.tracks);
      const byKind = tracks.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
      // How far off the plot is for ships still flying the plan their station filed
      let n = 0, err = 0, worst = 0;
      for (const r of tracks) {
        if (r.kind !== 'plan') continue;
        const e = world.get(r.id);
        if (!e?.transit || e.transit.to !== r.plan.to || e.transit.t0 !== r.plan.t0) continue;
        world.refresh(e, s.clock.minute);
        const est = estimate(s, r, s.clock.minute);
        const d = dist(est, e.pos) * AU_KM;
        err += d; worst = Math.max(worst, d); n++;
      }
      const digests = Object.values(s.intel.digests);
      console.log(`      ${ships.length} ships · ${board} on our board · plot ${tracks.length} (${JSON.stringify(byKind)}) · ${digests.length} digests, ages ${digests.map(d => `${d.name.split(' ')[0]} ${d.rx - d.issued}m`).join(', ')}`);
      console.log(`      filed plans flown forward: ${n} ships, mean error ${fmt(err / Math.max(1, n), 0)} km, worst ${fmt(worst, 0)} km`);
      assert(ships.length >= DEFAULT_TRAFFIC, 'thousands of ships');
      assert(board < ships.length / 5, 'our board holds only what is near');
      assert(tracks.length > 500 && tracks.length <= INTEL_MAX, 'the plot knows of hundreds from the digests');
      assert(digests.length >= 6, 'every station has reported');
      assert(n > 50 && worst < 1000, 'a filed plan puts a ship where it is');
      // Nothing far is on the board, and far ships aren't drawn as they are
      const far = ships.filter(e => dist(e.pos, s.flight.pos) > 0.2);
      assert(far.every(e => liveKnowledge(s, e) !== 'live'), 'no far ship is live');
    },
  },
  {
    name: 'digests travel at light speed, and are lost while the comms array is down',
    fn: () => {
      const s = game(3);
      const world = getWorld(s);
      advance(s, 12 * 60);
      const f = s.flight.pos;
      const lags = Object.entries(s.intel.digests).map(([id, d]) => {
        const st = world.get(id);
        return { name: d.name, lag: d.rx - d.issued, light: lightMinutes(dist(st.pos, f)) };
      });
      console.log(`      ${lags.map(l => `${l.name.split(' ')[0]} ${l.lag}/${fmt(l.light, 1)} min`).join(' · ')}`);
      for (const l of lags) assert(Math.abs(l.lag - l.light) <= 1.5, `${l.name}: ${l.lag} min vs light ${l.light}`);
      const before = JSON.stringify(s.intel.digests);
      s.systems.units.comms.enabled = false;          // the array is down
      for (let i = 0; i < 8 * 60; i++) minuteTick(s);
      assert(JSON.stringify(s.intel.digests) === before, 'nothing received with the array down');
    },
  },
  {
    name: 'a lost contact stays on the plot, coasting, its circle growing',
    fn: () => {
      const s = game(4);
      advance(s, 120);
      const lost = Object.values(s.intel.tracks).filter(r => r.src === 'SENSORS');
      // Step off a long way: everything on the board drops off
      const ids = s.sensors.contacts.filter(c => !c.station && !c.ordnance).map(c => c.id);
      const ceres = bodyPos(getBody('Ceres'), s.clock.minute / DAY_MIN);
      placeAt(s, { x: ceres.x + 0.5, y: ceres.y }, 'Ceres');
      advance(s, 2);
      const fixes = ids.map(id => s.intel.tracks[id]).filter(r => r?.src === 'SENSORS');
      const r = fixes[0];
      const e1 = estimate(s, r, s.clock.minute), e2 = estimate(s, r, s.clock.minute + 600);
      console.log(`      ${ids.length} on the board at Ceres, ${fixes.length} left as fixes (${lost.length} before); circle ${fmt(e1.sigmaAU * AU_KM, 0)} km now, ${fmt(e2.sigmaAU * AU_KM, 0)} km in 10 h`);
      assert(fixes.length >= ids.length * 0.9, 'what we saw stays on the plot');
      assert(e2.sigmaAU > e1.sigmaAU * 10, 'the circle grows');
    },
  },
  {
    name: 'forces: police on their beats, navies at their yards, pirates in the dark',
    fn: () => {
      const s = game(5);
      const sum = forcesSummary(s);
      const stations = getWorld(s).stations.filter(st => ['UN', 'MCR', 'OPA'].includes(st.faction)).length;
      console.log(`      ${JSON.stringify(sum)}`);
      assert(sum.police === stations * POLICE_PER_STATION, 'cutters at every policed station');
      assert(sum.navy >= Object.values(NAVY_STRENGTH).reduce((a, b) => a + b, 0), 'navies at strength');
      assert(sum.pirate >= 20, 'pirates at large');
      // Days pass: losses are made good, nobody multiplies
      advance(s, 3 * DAY_MIN);
      const later = forcesSummary(s);
      console.log(`      3 days later: ${JSON.stringify(later)}`);
      assert(later.police === sum.police, 'police steady');
    },
  },
  {
    name: 'a skirmish draws squadrons — many UNN hulls, few MCRN — and the war is fought unseen with real ships',
    fn: () => {
      const s = game(6);
      const world = getWorld(s);
      const z = spawnZone(s, { body: 'Ganymede', kind: 'skirmish', factions: ['UN', 'MCR'], w: 1 });
      z.intensity = 1;
      z.until = s.clock.minute + 90 * DAY_MIN;
      const sent = {};
      for (const e of world.forces) if (e.tags.force.zone === z.id) sent[e.faction] = (sent[e.faction] || 0) + 1;
      const lost = { UN: 0, MCR: 0 };
      let charted = 0;
      bus.on('zone-incident', (p) => {
        const e = world.get(p.entityId);
        if (p.zoneId === z.id && e && e.faction in lost) lost[e.faction]++;
        if (s.intel.tracks[p.entityId]?.kind === 'chart') charted++;
      });
      let both = null;
      for (let d = 1; d <= 40 && (lost.UN + lost.MCR < 6); d++) {
        advance(s, DAY_MIN);
        const t = forcesAt(s, z);
        if (!both && t.UN?.length && t.MCR?.length) both = d;
      }
      const left = Object.fromEntries(Object.entries(forcesAt(s, z)).map(([k, v]) => [k, v.length]));
      console.log(`      sent ${JSON.stringify(sent)}; both on station by day ${both}; lost ${JSON.stringify(lost)} (each wreck charted as the news lands: ${charted}); on station now ${JSON.stringify(left)}`);
      assert(sent.UN > sent.MCR * 3, 'the UNN sends numbers, the MCRN quality');
      assert(both, 'the squadrons arrive');
      assert(lost.UN + lost.MCR >= 1, 'warships were lost, and the news reached us');
      assert(charted >= lost.UN + lost.MCR, 'reported wrecks are charted');
    },
  },
  {
    name: 'the live window: a zone\'s warships wake when we arrive, fight, and go back on rails when we leave',
    fn: () => {
      const s = game(7);
      const z = spawnZone(s, { body: 'Hygiea', kind: 'skirmish', factions: ['MCR', 'OPA'], w: 1 });
      z.until = s.clock.minute + 60 * DAY_MIN;
      z.intensity = 1;
      z.wrecks = 99;             // no unseen losses: we want to watch
      for (let d = 0; d < 30; d++) {
        advance(s, DAY_MIN);
        const there = forcesAt(s, z);
        if ((there.MCR?.length || 0) >= 3 && (there.OPA?.length || 0) >= 3) break;
      }
      const world = getWorld(s);
      const zp = zonePos(z, s.clock.minute);
      placeAt(s, { x: zp.x + 0.03, y: zp.y }, 'Hygiea');
      let awake = [], fighting = false;
      for (let i = 0; i < 6 * 60; i++) {
        minuteTick(s);
        awake = [...world.driven].filter(e => e.tags?.force?.role === 'navy' && e.agent);
        if (awake.some(e => e.agent.mode === 'engage')) { fighting = true; break; }
      }
      console.log(`      at the zone: ${awake.length} warships awake (${awake.map(e => `${e.faction} ${e.agent.mode}`).join(', ')}), fighting: ${fighting}`);
      assert(awake.length >= 2 && awake.length <= 6, 'the warships there come alive');
      assert(fighting, 'and fight each other');
      // Leave: past SLEEP_AU they go back on rails, still in the world
      const ids = awake.map(e => e.id);
      placeAt(s, { x: zp.x + SLEEP_AU * 2, y: zp.y });
      advance(s, 3);
      const back = ids.map(id => world.get(id)).filter(Boolean);
      console.log(`      we left: ${back.filter(e => !e.agent && (e.transit || e.orbit)).length}/${ids.length} back on rails (${back.map(e => e.tags.force?.state).join(', ')})`);
      assert(back.length >= ids.length - 1, 'nobody vanished (one may have been lost in the fight)');
      assert(back.every(e => !e.agent || e.combat?.status !== 'ok'), 'all asleep');
      void WAKE_AU;
    },
  },
  {
    name: 'a v0.10 save gets a plot, the traffic of a settled system, and the forces',
    fn: () => {
      const s = game(8, { traffic: 36, forces: false });
      delete s.intel;
      delete s.traffic.v;
      advance(s, 10);
      const { state } = deserialize(serialize(s));
      const sum = forcesSummary(state);
      const ships = state.entities.filter(e => e.tags?.traffic).length;
      console.log(`      upgraded: ${ships} traffic ships, forces ${JSON.stringify(sum)}, plot ${state.intel ? 'ready' : 'missing'}`);
      assert(state.traffic.population === DEFAULT_TRAFFIC && ships >= DEFAULT_TRAFFIC - 5, 'traffic topped up');
      assert(sum.police > 0 && sum.navy > 0 && sum.pirate > 0, 'forces raised');
      assert(state.intel?.tracks, 'a plot');
      advance(state, 60);
      const again = deserialize(serialize(state)).state;
      assert(again.entities.length === state.entities.length, 'a second load adds nothing');
    },
  },
  {
    name: 'scale: the default system costs little per minute, docked at a busy port',
    fn: () => {
      const s = game(9);
      advance(s, DAY_MIN);
      let t = performance.now();
      for (let i = 0; i < 600; i++) minuteTick(s);
      const perMinute = (performance.now() - t) / 600;
      const size = serialize(s).length;
      console.log(`      ${s.entities.length} entities · ${fmt(perMinute, 3)} ms/game-minute · save ${fmt(size / 1e6, 2)} MB`);
      assert(perMinute < 3, `per-minute cost ${perMinute} ms`);
      assert(size < 6e6, 'saves stay a few MB');
    },
  },
];
