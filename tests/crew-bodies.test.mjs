// The crew's bodies on the room cameras (ui/gl/figures.js, assets/crew/).
// The kit as packed (tools/crew-assets.py): the skeleton in an order the
// posing can run down, every vertex bound to it, the bind pose its rest
// pose, the jumpsuit's tags where a jumpsuit's edges are. Then every
// posture the cameras give (ui/roomcam.js posture: on their feet, walking,
// at work, at each kind of station, in a couch, asleep, on the autodoc, at
// the mess table, on the treadmill, down, carried, adrift) put on both
// bodies and skinned vertex by vertex on the CPU (the same sums the shader
// does), and looked at as a body: bones their own length and joints that
// turn rigidly; the torso the way the person faces; elbows and knees bent
// the way the posture bends them, never backwards; the left hand on the
// left; on their feet, the soles on the deck and nothing through it; asleep,
// under the blanket. The numbers printed are how far the body's hands and
// feet land from the posture's (a body's arms are its own length, not the
// stick figure's). And the states a body can be in: braced against a hard
// burn, pinned flat by a crushing one, thrown across the deck or tumbling
// adrift when the ship moves under it, down where it fell (each its own
// way), asleep in a bunk a tile long (on its side, knees up: it fits), on
// the autodoc (knees raised: it fits).
import { readFileSync } from 'node:fs';
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { createGame } from '../js/sim/game.js';
import { shipGeometry } from '../js/sim/ship-layout.js';
import { TileType } from '../js/sim/tiles.js';
import { roomFor, posture, Lens, occludersNear } from '../js/ui/roomcam.js';
import { makeRig, pose, skinning, blanketMesh, lookOf, LIE_LIFT } from '../js/ui/gl/figures.js';

const ROOT = new URL('../', import.meta.url);
let _kit = null;
/** The packed kit: crew.json, crew.bin, and the rig made from them. */
function kit() {
  if (_kit) return _kit;
  const meta = JSON.parse(readFileSync(new URL('assets/crew/crew.json', ROOT), 'utf8'));
  const buf = readFileSync(new URL('assets/crew/crew.bin', ROOT));
  const bin = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _kit = { meta, bin, rig: makeRig(meta, bin) };
  return _kit;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** A mesh's arrays out of the bin. */
function arrays(m) {
  const { bin } = kit();
  return {
    pos: new Float32Array(bin, m.pos, m.count * 3), joints: new Uint8Array(bin, m.joints, m.count * 4),
    weights: new Uint8Array(bin, m.weights, m.count * 4), tags: new Uint8Array(bin, m.tags, m.count * 4),
    idx: m.index32 ? new Uint32Array(bin, m.idx, m.indices) : new Uint16Array(bin, m.idx, m.indices),
  };
}

/** Every vertex of a mesh skinned to a pose, as the shader does it: world positions (tiles). */
function skinned(m, S) {
  const a = arrays(m), out = new Float32Array(m.count * 3);
  for (let v = 0; v < m.count; v++) {
    let x = 0, y = 0, z = 0, ws = 0;
    const px = a.pos[v * 3], py = a.pos[v * 3 + 1], pz = a.pos[v * 3 + 2];
    for (let i = 0; i < 4; i++) {
      const w = a.weights[v * 4 + i] / 255;
      if (!w) continue;
      const o = a.joints[v * 4 + i] * 16;
      x += w * (S[o] * px + S[o + 4] * py + S[o + 8] * pz + S[o + 12]);
      y += w * (S[o + 1] * px + S[o + 5] * py + S[o + 9] * pz + S[o + 13]);
      z += w * (S[o + 2] * px + S[o + 6] * py + S[o + 10] * pz + S[o + 14]);
      ws += w;
    }
    out[v * 3] = x / ws; out[v * 3 + 1] = y / ws; out[v * 3 + 2] = z / ws;
  }
  return out;
}

// ---- The postures, on a real ship's decks ----

function ship() {
  seedRandom(7);
  bus.clear();
  const s = createGame({ classId: 'mcrn-corvette', docked: false, crewCount: 8, traffic: 0, forces: false });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  return s;
}

/** A crew member as roomcam.js poses them: { m, x, z, moving, heading, work, climb }, and whether adrift. */
function scenes(s) {
  const geo = shipGeometry(s.ship);
  const out = [];
  const base = (id) => ({ ...structuredClone(s.ship.crew[id % s.ship.crew.length]), id, seat: null, activity: 'idle', task: null, dead: false, consciousness: 100 });
  const seat = (kind) => {
    const f = geo.fixtures[kind]?.[0];
    if (!f) return null;
    return { room: roomFor(s.ship, f.deck), fig: { m: { ...base(out.length), seat: f.id }, x: f.x, z: f.y, moving: false, heading: Math.PI / 2, work: false } };
  };
  for (const kind of ['helm', 'ops', 'weapons', 'engStation', 'couch', 'bunk', 'paxBerth', 'medbay', 'rec']) {
    const sc = seat(kind);
    if (sc) out.push({ name: kind, ...sc, floating: false, fixture: geo.fixtures[kind][0] });
  }
  // on the deck: an open floor cell of the mess (where the tables are)
  const tableF = geo.fixtures.table[0];
  const room = roomFor(s.ship, tableF.deck);
  const tiles = room.tiles;
  const open = room.cells.filter(([x, z]) => tiles[z][x] === TileType.FLOOR);
  const nextToTable = open.find(([x, z]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => tiles[z + dz]?.[x + dx] === TileType.TABLE));
  const [fx, fz] = open[Math.floor(open.length / 2)];
  const deck = (name, m, o = {}) => out.push({ name, room, fig: { m: { ...base(out.length), ...m }, x: o.x ?? fx, z: o.z ?? fz, moving: !!o.moving, heading: o.heading ?? 0.4, work: !!o.work }, floating: !!o.floating, t: o.t ?? 0 });
  deck('stand', {});
  deck('work', {}, { work: true });
  for (const t of [0, 150, 300]) deck(`walk t${t}`, {}, { moving: true, t });
  if (nextToTable) deck('table', { activity: 'eating' }, { x: nextToTable[0], z: nextToTable[1] });
  for (let i = 0; i < 3; i++) deck(`down ${i}`, { consciousness: 0 });
  for (let i = 0; i < 3; i++) deck(`dead ${i}`, { dead: true });
  deck('carried', { task: { type: 'carried' } });
  deck('adrift', {}, { floating: true });
  deck('down adrift', { consciousness: 0 }, { floating: true });
  deck('braced', { gState: 'strained' });
  deck('pinned', { gState: 'prone' });
  for (const t of [0, 400]) {
    out.push({ ...out.find(o => o.name === 'stand'), name: `thrown deck t${t}`, t, fig: { ...out.find(o => o.name === 'stand').fig, m: { ...base(out.length) }, thrown: { vx: 1.6, vy: 0.4, grounded: true } } });
    out.push({ ...out.find(o => o.name === 'stand'), name: `thrown adrift t${t}`, t, floating: true, fig: { ...out.find(o => o.name === 'stand').fig, m: { ...base(out.length) }, thrown: { vx: -0.8, vy: 1.1, grounded: false } } });
  }
  return out;
}

/** The posture a scene gives, and the pose and skinning of a body on it. */
function poseScene(sc, sex) {
  const { rig } = kit();
  const P = posture(sc.room, sc.fig, sc.t ?? 0, sc.floating);
  const body = rig.bodies[sex];
  const f = { J: P.J, face: P.face, kind: P.kind, sex, cover: P.blanket || P.sheet || null };
  const posed = pose(body, f, rig);
  const S = skinning(posed, body.ibm, new Float32Array(rig.J.length * 16));
  return { P, f, posed, S, body };
}

/** A room's fixtures with their parts (as the camera builds them), for what stands in front of people. */
function furnished(room) {
  return room.fixtures.map(f => ({ ...f, parts: f.model({ x: f.x, z: f.z, h: 0.5, zone: room.zone, suit: false, glow: false }) }));
}

/** Of a mesh's skinned vertices, the share the lens can't see for the furniture in the way (ray to each, Möller–Trumbore). */
function hiddenShare(eye, v, tris) {
  let hidden = 0;
  const n = v.length / 3;
  for (let i = 0; i < n; i++) {
    const px = v[i * 3], py = v[i * 3 + 1], pz = v[i * 3 + 2];
    const dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2];
    let blocked = false;
    for (const t of tris) {
      for (let k = 0; k < t.length && !blocked; k += 9) {
        const e1x = t[k + 3] - t[k], e1y = t[k + 4] - t[k + 1], e1z = t[k + 5] - t[k + 2];
        const e2x = t[k + 6] - t[k], e2y = t[k + 7] - t[k + 1], e2z = t[k + 8] - t[k + 2];
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const a = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(a) < 1e-9) continue;
        const f = 1 / a, sx = eye[0] - t[k], sy = eye[1] - t[k + 1], sz = eye[2] - t[k + 2];
        const u = f * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const w = f * (dx * qx + dy * qy + dz * qz);
        if (w < 0 || u + w > 1) continue;
        const tt = f * (e2x * qx + e2y * qy + e2z * qz);
        if (tt > 1e-4 && tt < 0.985) blocked = true;          // (between the lens and the point, not at it)
      }
      if (blocked) break;
    }
    if (blocked) hidden++;
  }
  return hidden / n;
}

const LYING = new Set(['lying', 'down']);

export default [
  {
    name: 'the brig\'s cells: closed boxes round their bunks, the door shut and locked (red) on a cell held, open (green) on one free',
    fn: () => {
      const s = ship();
      const di = s.ship.decks.findIndex(d => d.id === 'brig');
      assert(di >= 0, 'a warship has a brig');
      const room = roomFor(s.ship, di);
      const cells = room.fixtures.filter(f => f.cell != null);
      assert(cells.length === s.brig && cells.every((f, i) => f.cell === i), `a cell for each the class holds (${cells.length} of ${s.brig}), numbered`);
      const shut = cells[0].model({ x: 0, z: 0, h: 0.5, held: true }), open = cells[0].model({ x: 0, z: 0, h: 0.5, held: false });
      assert(shut.some(p => p.deco === 'cellShut' && p.occupancy) && !shut.some(p => p.deco === 'cellLeaf'), 'held: the door shut, its lock lamp');
      assert(open.some(p => p.deco === 'cellLeaf' && p.occupancy) && !open.some(p => p.deco === 'cellShut'), 'free: the door open, its lamp');
      assert(shut.some(p => p.t0 === 0 && p.t1 === 1 && Math.min(...p.prof.map(v => v[1])) > 1.3), 'a roof over the cell');
      const other = roomFor(s.ship, s.ship.decks.findIndex(d => d.id === 'quarters'));
      assert(other.fixtures.every(f => f.cell == null), 'berths elsewhere are berths');
    },
  },
  {
    name: 'what stands nearer the lens hides them: the seat back at a station seen from behind, a table over a diner\'s legs; nobody hidden in the open',
    fn: () => {
      const s = ship();
      const want = { helm: [0.12, 0.9], ops: [0.12, 0.9], weapons: [0.12, 0.9], table: [0.03, 0.9], stand: [0, 0.02], couch: [0, 0.9], bunk: [0, 0.9] };
      for (const sc of scenes(s)) {
        if (!want[sc.name]) continue;
        const lens = new Lens(sc.room, 1600, 900, { l: 40, r: 40, t: 54, b: 45 });
        const fx = furnished(sc.room);
        for (const sex of ['male', 'female']) {
          const { P, S } = poseScene(sc, sex);
          const v = skinned(kit().meta.bodies[sex].meshes.body, S);
          const tris = occludersNear(fx, (P.J.hpL[0] + P.J.hpR[0]) / 2, (P.J.hpL[2] + P.J.hpR[2]) / 2);
          const h = hiddenShare(lens.eye, v, tris);
          console.log(`      ${sc.name.padEnd(8)} ${sex.padEnd(6)} hidden by the furniture: ${fmt(100 * h, 1)}% of the body (${tris.length} pieces near)`);
          const [lo, hi] = want[sc.name];
          assert(h >= lo && h <= hi, `${sc.name} ${sex}: ${fmt(100 * h, 1)}% hidden (want ${lo * 100}–${hi * 100}%)`);
        }
      }
    },
  },
  {
    name: 'the kit as packed: a skeleton the posing can run down, every vertex bound, bound at rest, tagged for a jumpsuit',
    fn: () => {
      const { meta, bin, rig } = kit();
      assert(meta.joints.length === 23, `23 joints kept (${meta.joints.length})`);
      meta.parents.forEach((p, j) => assert(p < j, `${meta.joints[j]}'s parent comes before it`));
      assert(/CC0/.test(meta.source), 'the source and its licence recorded');
      assert(readFileSync(new URL('assets/crew/LICENSE.txt', ROOT), 'utf8').includes('CC0'), 'LICENSE.txt with the kit');
      for (const [sex, b] of Object.entries(meta.bodies)) {
        const body = rig.bodies[sex];
        assert(body.height > 1.65 && body.height < 1.95, `${sex}: a person's height (${fmt(body.height, 2)} m)`);
        // bound at rest: rest × inverse bind is the identity, joint by joint
        for (let j = 0; j < meta.joints.length; j++) {
          const R = body.rest[j], B = body.ibm.subarray(j * 16, j * 16 + 16);
          for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            const v = R[r] * B[c * 4] + R[4 + r] * B[c * 4 + 1] + R[8 + r] * B[c * 4 + 2] + R[12 + r] * B[c * 4 + 3];
            assert(Math.abs(v - (r === c ? 1 : 0)) < 2e-3, `${sex} ${meta.joints[j]}: bound at rest`);
          }
        }
        for (const part of ['body', 'eyes', 'brows']) {
          const m = b.meshes[part];
          assert(m, `${sex} has ${part}`);
          const a = arrays(m);
          for (let v = 0; v < m.count; v++) {
            let ws = 0;
            for (let i = 0; i < 4; i++) { ws += a.weights[v * 4 + i]; assert(a.joints[v * 4 + i] < 23, 'joints within the skeleton'); }
            assert(Math.abs(ws - 255) <= 3, `${sex} ${part}: weights sum to one (${ws})`);
          }
          for (let i = 0; i < m.indices; i++) assert(a.idx[i] < m.count, 'indices within the mesh');
          assert(m.pos + m.count * 12 <= bin.byteLength && m.idx + m.indices * (m.index32 ? 4 : 2) <= bin.byteLength, 'arrays within the bin');
        }
        // the jumpsuit's edges: skin above the collar and past the wrists, boots below the ankles
        const a = arrays(b.meshes.body);
        let skin = 0, hand = 0, boot = 0;
        for (let v = 0; v < b.meshes.body.count; v++) {
          const y = a.pos[v * 3 + 1], x = Math.abs(a.pos[v * 3]);
          if (a.tags[v * 4]) { skin++; assert(y > body.land[1] - 1e-3, 'skin only above the collar'); }
          if (a.tags[v * 4 + 2]) { hand++; assert(x > body.land[3] - 1e-3, 'hands only past the wrists'); }
          if (a.tags[v * 4 + 1]) { boot++; assert(y < 0.25, 'boots only at the feet'); }
        }
        console.log(`      ${sex}: ${b.meshes.body.count} vertices, ${fmt(b.meshes.body.indices / 3, 0)} triangles · skin ${skin} · hands ${hand} · boots ${boot} · ${fmt(body.height, 2)} m`);
        assert(skin > 300 && hand > 300 && boot > 100, 'face, hands and boots all tagged');
      }
      for (const [cut, h] of Object.entries(meta.hair)) assert(h.mesh.count > 50 && h.tex, `hair ${cut}`);
    },
  },
  {
    name: 'who looks like what: half and half, kept by the id, a cut the kit has',
    fn: () => {
      const { meta } = kit();
      let female = 0, beards = 0;
      for (let id = 0; id < 400; id++) {
        const a = lookOf(id), b = lookOf(id);
        assert(a.sex === b.sex && a.cut === b.cut && a.beard === b.beard, 'the same look every time');
        assert(meta.hair[a.cut], `cut ${a.cut} in the kit`);
        if (a.sex === 'female') female++; else if (a.beard) beards++;
        if (a.sex === 'female') assert(!a.beard, 'no beards on the female body');
      }
      console.log(`      of 400: ${female} female · ${beards} bearded`);
      assert(female > 160 && female < 240, 'about half and half');
    },
  },
  {
    name: 'every posture on both bodies: rigid bones, the torso the way they face, limbs bent the right way, left on the left',
    fn: () => {
      const s = ship();
      const { rig } = kit();
      const rows = [];
      for (const sc of scenes(s)) for (const sex of ['male', 'female']) {
        const { P, posed, body } = poseScene(sc, sex);
        const { W, pos, k } = posed;
        const J = rig.J, at = (n) => pos[J.indexOf(n)].map(v => v * k);
        // nothing gone wrong in the numbers; every joint a rotation
        for (let j = 0; j < J.length; j++) {
          assert(pos[j].every(Number.isFinite) && W[j].flat().every(Number.isFinite), `${sc.name} ${sex}: finite`);
          const M = W[j], det = dot(M[0], cross(M[1], M[2]));
          assert(Math.abs(det - 1) < 1e-3 && M.every(c => Math.abs(len(c) - 1) < 1e-3), `${sc.name} ${sex} ${J[j]}: a rotation (det ${fmt(det, 4)})`);
          // bones their own length
          const p = rig.parents[j];
          if (p >= 0) {
            const r = Math.hypot(...sub(body.rest[j].slice(12, 15), body.rest[p].slice(12, 15)));
            assert(Math.abs(len(sub(pos[j], pos[p])) - r) < 1e-4, `${sc.name} ${sex} ${J[j]}: its bone its own length`);
          }
        }
        // the torso along the posture's, facing where it faces
        const up = norm(sub(mid(P.J.shL, P.J.shR), mid(P.J.hpL, P.J.hpR)));
        const torso = norm(sub(at('neck_01'), at('pelvis')));
        assert(dot(torso, up) > 0.93, `${sc.name} ${sex}: torso along the posture's (${fmt(dot(torso, up), 3)})`);
        // (the body's front: rest +z, turned as the chest is: W · restᵀ · z)
        const fwd = sub(P.face, up.map(v => v * dot(P.face, up)));
        const c3 = J.indexOf('spine_03'), r3 = body.rest[c3], restZ = [r3[2], r3[6], r3[10]];
        const facing = norm(W[c3].reduce((acc, col, i) => acc.map((v, c) => v + col[c] * restZ[i]), [0, 0, 0]));
        assert(len(fwd) < 0.3 || dot(facing, norm(fwd)) > 0.85, `${sc.name} ${sex}: faces where the posture faces (${fmt(dot(facing, norm(fwd)), 3)})`);
        // which posture side is the body's left: by the hips
        const left = dot(sub(P.J.hpL, P.J.hpR), sub(at('thigh_l'), at('thigh_r'))) > 0 ? 'L' : 'R', right = left === 'L' ? 'R' : 'L';
        // elbows and knees bend the posture's way, never backwards
        const bend = (a, b, c, A, B, C, what) => {
          const n1 = cross(sub(b, a), sub(c, b)), n2 = cross(sub(B, A), sub(C, B));
          if (len(n1) < 0.02 * len(sub(b, a)) * len(sub(c, b))) return;          // (straight: no way to bend)
          assert(dot(n1, n2) > 0, `${sc.name} ${sex}: ${what} bends the posture's way`);
        };
        for (const [side, s2] of [['l', left], ['r', right]]) {
          bend(P.J['sh' + s2], P.J['el' + s2], P.J['ha' + s2], at(`upperarm_${side}`), at(`lowerarm_${side}`), at(`hand_${side}`), `${side} elbow`);
          bend(P.J['hp' + s2], P.J['kn' + s2], P.J['ft' + s2], at(`thigh_${side}`), at(`calf_${side}`), at(`foot_${side}`), `${side} knee`);
        }
        // the left hand nearer the left target than the right one (no arms crossed)
        const dL = len(sub(at('hand_l'), P.J['ha' + left])), dX = len(sub(at('hand_l'), P.J['ha' + right]));
        const dR = len(sub(at('hand_r'), P.J['ha' + right]));
        assert(dL <= dX + 0.02, `${sc.name} ${sex}: the left hand on the left`);
        rows.push({ name: sc.name, sex, kind: P.kind, hand: Math.max(dL, dR), foot: Math.max(len(sub(at('foot_l'), P.J['ft' + left])), len(sub(at('foot_r'), P.J['ft' + right]))) });
      }
      const by = new Map();
      for (const r of rows) { const e = by.get(r.name) || { hand: 0, foot: 0, kind: r.kind }; e.hand = Math.max(e.hand, r.hand); e.foot = Math.max(e.foot, r.foot); by.set(r.name, e); }
      for (const [name, e] of by) console.log(`      ${name.padEnd(12)} ${e.kind.padEnd(6)} hands within ${fmt(e.hand * 1.52, 2)} m of the posture's · feet ${fmt(e.foot * 1.52, 2)} m`);
      // (the body's arms are its own: within about a forearm of the stick figure's hands)
      for (const r of rows) assert(r.hand * 1.52 < 0.45, `${r.name} ${r.sex}: hands near the posture's (${fmt(r.hand * 1.52, 2)} m)`);
    },
  },
  {
    name: 'the bodies skinned: on their feet the soles on the deck, nothing through the deck, sleepers under the blanket',
    fn: () => {
      const s = ship();
      for (const sc of scenes(s)) for (const sex of ['male', 'female']) {
        const { P, f, S, body } = poseScene(sc, sex);
        const mesh = kit().meta.bodies[sex].meshes.body;
        const v = skinned(mesh, S);
        let minY = Infinity;
        for (let i = 1; i < v.length; i += 3) minY = Math.min(minY, v[i]);
        const cm = 0.01 / 1.52;               // (tiles)
        // (what they stand on: the deck, or the treadmill's belt: where the posture puts its feet)
        const floor = Math.min(P.J.ftL[1], P.J.ftR[1]) - 0.02;
        if (P.kind === 'stand') {
          assert(minY > floor - 2.5 * cm && minY < floor + 3 * cm, `${sc.name} ${sex}: soles on what they stand on (lowest ${fmt((minY - floor) / cm, 1)} cm off it)`);
        } else if (!sc.floating && P.kind !== 'float') {
          assert(minY > -6 * cm, `${sc.name} ${sex}: nothing through the deck (lowest ${fmt(minY / cm, 1)} cm)`);
        }
        if (P.kind === 'float') assert(minY > 5 * cm, `${sc.name} ${sex}: adrift, off the deck (${fmt(minY / cm, 1)} cm)`);
        // down, pinned, fallen: lying on the deck, not over it
        if ((P.kind === 'down' || P.kind === 'pinned') && !sc.floating && sc.fig.m.task?.type !== 'carried') {
          assert(minY > -3 * cm && minY < 5 * cm, `${sc.name} ${sex}: lying on the deck (lowest ${fmt(minY / cm, 1)} cm)`);
          let maxY = -Infinity;
          for (let i = 1; i < v.length; i += 3) maxY = Math.max(maxY, v[i]);
          assert(maxY < 62 * cm, `${sc.name} ${sex}: lying, not sitting up (on their side a shoulder is half a metre up) (highest ${fmt(maxY / cm, 0)} cm)`);
        }
        // in a bunk or on the autodoc: within its tile, on it
        if (sc.fixture && (P.kind === 'side' || P.kind === 'lying')) {
          const fx = sc.fixture.x, fz = sc.fixture.y, tol = 3 * cm;
          let out = 0;
          for (let i = 0; i < v.length; i += 3) if (v[i] < fx - tol || v[i] > fx + 1 + tol || v[i + 2] < fz - tol || v[i + 2] > fz + 1 + tol) out++;
          console.log(`      ${sc.name.padEnd(9)} ${sex.padEnd(6)} fits its tile: ${v.length / 3 - out}/${v.length / 3} vertices inside · lowest ${fmt(minY / cm, 0)} cm`);
          assert(out === 0, `${sc.name} ${sex}: fits its ${sc.name} (${out} vertices out)`);
        }
        // asleep: the torso under the blanket (the blanket a height field over its footprint)
        if (f.cover && P.blanket) {
          const g = blanketMesh(f);
          const tri = [];
          for (let i = 0; i < g.pos.length; i += 9) tri.push(g.pos.slice(i, i + 9));
          const heightAt = (x, z) => {
            for (const t of tri) {
              const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
              const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
              const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
              if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * ay + l2 * by + l3 * cy;
            }
            return null;
          };
          const a = arrays(mesh);
          let inside = 0, under = 0;
          const poke = {};
          for (let i = 0; i < mesh.count; i++) {
            const ry = a.pos[i * 3 + 1];
            if (ry > body.land[1] - 0.05) continue;          // (all of them but the head and neck: limbs, hands and feet too)
            const h = heightAt(v[i * 3], v[i * 3 + 2]);
            if (h == null) continue;
            inside++;
            if (v[i * 3 + 1] <= h + 0.5 * cm) under++;
            else if (process.env.WHICH) {         // (WHICH=1: say which parts poke through)
              const jn = kit().rig.J[a.joints[i * 4]]; poke[jn] = (poke[jn] || 0) + 1; poke.$h = Math.max(poke.$h || 0, (v[i * 3 + 1] - h) / cm); }
          }
          if (process.env.WHICH) console.log('      poking through:', JSON.stringify(poke));
          console.log(`      ${sc.name.padEnd(9)} ${sex.padEnd(6)} under the blanket: ${under}/${inside} of the body below the neck (${fmt(100 * under / Math.max(1, inside), 1)}%) · lift ${fmt(LIE_LIFT * 1.52 * 100, 0)} cm`);
          assert(inside > 2000 && under / inside > 0.97, `${sc.name} ${sex}: under the blanket (${fmt(100 * under / inside, 1)}%)`);
        }
      }
    },
  },
];
