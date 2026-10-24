// ============================================================
// LONGHAUL — People on the room cameras: rigged bodies on the GPU
//
// A person on a room camera (roomcam.js) is posed as a handful of joints
// (feet, knees, hips, shoulders, elbows, hands, neck, head) from what the
// sim says they are doing. Here they are given a real body: a rigged human
// mesh (Quaternius' Universal Base Characters, CC0, built into
// assets/crew/ by tools/crew-assets.py), a male or a female base body on
// one skeleton, posed to those joints and drawn through the camera's own
// lens, so it stands exactly where the room puts it.
//
// Posing: the torso (pelvis and spine) turns as one to the line from the
// hips to the shoulders, facing where the person faces; the neck and head
// to the head's joints. Each arm and leg reaches by two-bone IK for the
// posture's hand or ankle at the body's own limb lengths, the elbow or knee
// bending toward where the posture has it (and the way that joint bends);
// a body down, pinned, thrown or adrift lies its limbs the posture's way
// instead, aimed joint to joint. Feet on a floor are sole-flat, the way the
// person faces; lying, along the shin. The body keeps its own bone lengths,
// placed by its hips, or on their feet by its soles.
//
// Dressing: the body is tagged at rest (skin above the collar and on the
// hands, boots below the ankles: the converter) and shaded as a jumpsuit
// in the department's colour between them, with its details worked from
// where a point lies on the body at rest (the collar, a zip, the belt and
// buckle, a name tape, the department's patches on chest and shoulder,
// cuffs, thigh panels), and the wounds the sim gives each part of the
// body (blood wet on skin and soaked dark into cloth, char from burns, the
// pallor of the dead). Skin is the kit's own texture, toned; hair one of
// the kit's cuts in the person's colour. A vac suit is the same body a
// little bulkier, white, with gloves and boots, a helmet and its visor, the
// life-support pack. Someone asleep is under a blanket that lies over the
// shape of them.
//
// Light is the room's: its panels, strips, lamps and screens (the lights
// roomcam.js lights the plating with), the strongest few at each person,
// and the camera's gain that keeps a person readable in a dark room. A
// thin dark edge separates a figure from what is behind it (the body drawn
// a little larger, behind itself); the selected one is outlined instead.
//
// Every figure a camera shows is rendered into its own rectangle of the
// shared GPU canvas (gl.js) in one pass, before the camera draws its rows:
// it copies each in, in its place in the draw order, so the furniture
// nearer the lens still hides it. The bodies load once, from the game's own
// folder (nothing from the network); until they have, or without WebGL2,
// renderFigures answers null and the camera draws its 2D figures.
// ============================================================

import { sharedGL, beginRender, program, onContextLost } from './gl.js';

/** Metres in a room tile (roomcam.js: a person about 1.15 tiles, 1.75 m). */
export const TILE_M = 1.52;
export const MAX_LIGHTS = 16;
const ATLAS_W = 2048;
const HEIGHT_TILES = { male: 1.17, female: 1.11 };                     // how tall each body stands, in tiles
const SKIN_REF = { male: [0.657, 0.467, 0.325], female: [0.672, 0.488, 0.338] };   // the kit's skin at the cheeks (sRGB)
// (the kit's long cut is a solid sheet down the back, a cape at a distance: only now and then)
const HAIR_CUTS = { male: ['simpleparted', 'buzzed', 'simpleparted', 'buzzed'], female: ['buns', 'simpleparted', 'buzzedfemale', 'buns', 'simpleparted', 'long'] };
export const LIE_LIFT = 0.075;               // tiles: a body lying down rests on its back, its joints this far off the mattress
const ASSETS = new URL('../../../assets/crew/', import.meta.url);

let R = null;
onContextLost(() => { R = null; });

function setup() {
  const ctx = sharedGL();
  if (!ctx) return null;
  if (R && R.gl === ctx.gl) return R;
  try {
    const gl = ctx.gl;
    const prog = program(gl, VS, FS, ['aPos', 'aNrm', 'aUV', 'aJ', 'aW', 'aTag']);
    R = { gl, ctx, prog, ready: false, failed: false, blanket: null };
    const r = R;
    load(r).catch(e => { console.error('[figures]', e.message); r.failed = true; });
  } catch (e) {
    console.error('[figures]', e.message);
    R = null;
  }
  return R;
}

/** Are the bodies there to draw? */
export const hasFigures3D = () => !!setup() && R.ready;

// ---- THE BODIES ----

async function load(r) {
  const gl = r.gl;
  const [meta, bin] = await Promise.all([
    fetch(new URL('crew.json', ASSETS)).then(x => { if (!x.ok) throw new Error(`crew.json ${x.status}`); return x.json(); }),
    fetch(new URL('crew.bin', ASSETS)).then(x => { if (!x.ok) throw new Error(`crew.bin ${x.status}`); return x.arrayBuffer(); }),
  ]);
  const tex = {};
  const names = new Set(['eye.png', ...Object.values(meta.bodies).map(b => b.skin), ...Object.values(meta.hair).map(h => h.tex)]);
  await Promise.all([...names].map(async (n) => { tex[n] = await texture(gl, new URL(n, ASSETS)); }));
  if (R !== r) return;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, bin, gl.STATIC_DRAW);
  const rig = makeRig(meta, bin);
  const J = rig.J;
  for (const [key, b] of Object.entries(meta.bodies)) {
    const body = rig.bodies[key];
    body.meshes = {};
    for (const [part, m] of Object.entries(b.meshes)) body.meshes[part] = meshVAO(gl, buf, bin, m);
    body.skin = tex[b.skin];
    body.helmet = rigid(gl, sphere(body.helmC, 0.165, 18), J.indexOf('Head'));
    body.pack = rigid(gl, box(add(body.restAt('spine_03'), [0, -0.06, -0.19]), [0.15, 0.23, 0.075]), J.indexOf('spine_03'));
  }
  const hair = {};
  for (const [key, h] of Object.entries(meta.hair)) hair[key] = { vao: meshVAO(gl, buf, bin, h.mesh), ibm: new Float32Array(bin, h.ibm, J.length * 16), tex: tex[h.tex] };
  Object.assign(r, rig, { hair, eyeTex: tex['eye.png'], ready: true });
}

/**
 * The skeletons, without the GPU: each body's rest pose (model metres, Y up,
 * facing +z), every joint's rest offset in its parent's frame, its inverse
 * binds, its height and the landmarks the jumpsuit is drawn from.
 */
export function makeRig(meta, bin) {
  const J = meta.joints, parents = meta.parents;
  const f32 = (off, n) => new Float32Array(bin, off, n);
  const bodies = {};
  for (const [key, b] of Object.entries(meta.bodies)) {
    const rest = b.rest.map(m => Float32Array.from(m));
    const restAt = (name) => { const m = rest[J.indexOf(name)]; return [m[12], m[13], m[14]]; };
    const ys = f32(b.meshes.body.pos, b.meshes.body.count * 3);
    let top = 0;
    for (let i = 1; i < ys.length; i += 3) top = Math.max(top, ys[i]);
    const head = restAt('Head');
    const local = rest.map((m, j) => {
      const p = parents[j];
      if (p < 0) return [m[12], m[13], m[14]];
      const q = rest[p], d = [m[12] - q[12], m[13] - q[13], m[14] - q[14]];
      return [q[0] * d[0] + q[1] * d[1] + q[2] * d[2], q[4] * d[0] + q[5] * d[1] + q[6] * d[2], q[8] * d[0] + q[9] * d[1] + q[10] * d[2]];
    });
    bodies[key] = {
      rest, local, restAt, ibm: f32(b.ibm, J.length * 16), height: top,
      land: [restAt('pelvis')[1], restAt('neck_01')[1] + 0.035, restAt('upperarm_l')[1], Math.abs(restAt('hand_l')[0]) - 0.012],
      chestY: restAt('spine_03')[1], helmC: [head[0], head[1] + 0.1, head[2] + 0.025],
    };
  }
  return { J, parents, bodies };
}

function texture(gl, url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      res(t);
    };
    im.onerror = () => rej(new Error(`texture ${url}`));
    im.src = url;
  });
}

/** A mesh from the bin: its arrays where the converter put them, and its own index buffer. */
function meshVAO(gl, buf, bin, m) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, m.pos);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, m.nrm);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, m.uv);
  gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_BYTE, 0, m.joints);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 0, m.weights);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, 0, m.tags);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index32 ? new Uint32Array(bin, m.idx, m.indices) : new Uint16Array(bin, m.idx, m.indices), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: m.indices, type: m.index32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}

/** A solid made in code (the helmet, the pack), riding one joint rigidly: its vertices at rest. */
function rigid(gl, geo, joint) {
  const n = geo.pos.length / 3;
  const arrays = [
    [0, 3, gl.FLOAT, new Float32Array(geo.pos)], [1, 3, gl.FLOAT, new Float32Array(geo.nrm)], [2, 2, gl.FLOAT, new Float32Array(n * 2)],
    [3, 4, gl.UNSIGNED_BYTE, new Uint8Array(n * 4).map((_, i) => (i % 4 ? 0 : joint))], [4, 4, gl.UNSIGNED_BYTE, new Uint8Array(n * 4).map((_, i) => (i % 4 ? 0 : 255))],
    [5, 4, gl.UNSIGNED_BYTE, new Uint8Array(n * 4)],
  ];
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [loc, size, type, data] of arrays) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    if (loc === 3) gl.vertexAttribIPointer(loc, size, type, 0, 0);
    else gl.vertexAttribPointer(loc, size, type, type !== gl.FLOAT, 0, 0);
  }
  gl.bindVertexArray(null);
  return { vao, count: n, arrays: true };
}

function sphere(c, r, seg) {
  const pos = [], nrm = [];
  const v = (t, p) => [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
  for (let i = 0; i < seg; i++) for (let k = 0; k < seg * 2; k++) {
    const t0 = i / seg * Math.PI, t1 = (i + 1) / seg * Math.PI, p0 = k / (seg * 2) * Math.PI * 2, p1 = (k + 1) / (seg * 2) * Math.PI * 2;
    for (const [t, p] of [[t0, p0], [t1, p0], [t1, p1], [t0, p0], [t1, p1], [t0, p1]]) { const n = v(t, p); nrm.push(...n); pos.push(c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r); }
  }
  return { pos, nrm };
}

/** A box with rounded-off shading (its normals leaning out at the corners). */
function box(c, h) {
  const pos = [], nrm = [];
  for (const [ax, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const u = (ax + 1) % 3, w = (ax + 2) % 3;
    const corner = (a, b) => { const p = [0, 0, 0]; p[ax] = s * h[ax]; p[u] = a * h[u]; p[w] = b * h[w]; return p; };
    const quad = s > 0 ? [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]] : [[-1, -1], [1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]];
    for (const [a, b] of quad) {
      const p = corner(a, b);
      const n = [p[0] / h[0] * 0.35, p[1] / h[1] * 0.35, p[2] / h[2] * 0.35]; n[ax] = s;
      const l = Math.hypot(...n);
      pos.push(c[0] + p[0], c[1] + p[1], c[2] + p[2]); nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  return { pos, nrm };
}

// ---- POSING ----

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
/** `v` made square to unit `n`, or `alt` when it nearly lies along it. */
const square = (v, n, alt) => { const w = sub(v, mul(n, dot(v, n))); return len(w) > 1e-3 ? norm(w) : alt; };

/** A frame (3×3, columns) from a primary direction and a second one squared to it. */
function frame(a, b) {
  a = norm(a);
  b = square(b, a, Math.abs(a[1]) < 0.9 ? square([0, 1, 0], a) : square([1, 0, 0], a));
  return [a, b, cross(a, b)];
}
/** The rotation (3×3, columns) carrying frame f onto frame g: g · fᵀ. */
function carry(f, g) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c][r] = g[0][r] * f[0][c] + g[1][r] * f[1][c] + g[2][r] * f[2][c];
  return out;
}
const rot = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];
const restRot = (m) => [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
const restPos = (m) => [m[12], m[13], m[14]];
const rmul = (A, B) => [rot(A, B[0]), rot(A, B[1]), rot(A, B[2])];
const transpose = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];

/**
 * The skeleton posed to a figure's joints: per joint, its world rotation
 * and position in the room (model metres; k: tiles per model metre).
 */
export function pose(body, f, rig = R) {
  const J = rig.J, parents = rig.parents;
  const k = (HEIGHT_TILES[f.sex] || 1.15) / body.height;
  const lift = f.kind === 'lying' || f.kind === 'down' || f.kind === 'pinned' ? LIE_LIFT : 0;
  // the figure's joints, in model metres in the room
  const T = {};
  for (const n of ['hd', 'nk', 'shL', 'shR', 'elL', 'elR', 'haL', 'haR', 'hpL', 'hpR', 'knL', 'knR', 'ftL', 'ftR']) { const v = f.J[n]; T[n] = [v[0] / k, (v[1] + lift) / k, v[2] / k]; }
  const face = norm(f.face);
  const idx = (n) => J.indexOf(n);
  const rest = body.rest;
  const P = (n) => restPos(rest[idx(n)]);
  const bone = (a, b) => len(sub(P(b), P(a)));
  // the torso turns as one: up from the hips to the shoulders, facing where the person does
  const shM = mid(T.shL, T.shR), hpM = mid(T.hpL, T.hpR);
  const up = norm(sub(shM, hpM));
  const fwd = square(face, up, square([0, 1, 0], up, [1, 0, 0]));
  const Rt = carry(frame(sub(P('neck_01'), P('pelvis')), [0, 0, 1]), frame(up, fwd));
  // which of the figure's sides is the body's left (+x at rest): its L and R are only labels
  const leftW = rot(Rt, [1, 0, 0]);
  const L = dot(sub(T.hpL, T.hpR), leftW) >= 0 ? 'L' : 'R', Rr = L === 'L' ? 'R' : 'L';
  // the neck and head to the head's joints
  const restNeck = sub(add(P('Head'), [0, 0.1, 0]), P('neck_01'));
  const hup = norm(add(sub(T.hd, T.nk), mul(up, 0.3)));
  const Rh = carry(frame(restNeck, [0, 0, 1]), frame(hup, square(face, hup, fwd)));
  const nup = norm(add(up, hup));
  const Rn = carry(frame(restNeck, [0, 0, 1]), frame(nup, square(face, nup, fwd)));
  const W = new Array(J.length);
  const pos = new Array(J.length);
  const set = (n, Rw) => { W[idx(n)] = rmul(Rw, restRot(rest[idx(n)])); };
  for (const n of ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03']) set(n, Rt);
  set('neck_01', Rn); set('Head', Rh);
  // the trunk first: down from the torso (the clavicles riding the chest), at the body's own bone lengths
  const LIMB = new Set(['upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot', 'ball'].flatMap(n => [idx(`${n}_l`), idx(`${n}_r`)]));
  const trunk = (j) => !LIMB.has(j);
  for (let j = 0; j < J.length; j++) {
    const p = parents[j];
    if (p >= 0 && !trunk(p)) continue;
    if (!W[j] && trunk(j)) W[j] = rmul(W[p], rmul(transpose(restRot(rest[p])), restRot(rest[j])));
    pos[j] = p < 0 ? [0, 0, 0] : add(pos[p], rot(W[p], body.local[j]));
  }
  // placed by the hips: the thighs' heads between the figure's hips
  const shift = sub(hpM, mid(pos[idx('thigh_l')], pos[idx('thigh_r')]));
  // where each foot is to be: the ankle over the posture's foot point, as high off what it stands on as the body's ankle
  const ankleUp = P('foot_l')[1] - 0.015;
  const onFeet = f.kind === 'stand' || f.kind === 'brace' || f.kind === 'seat' || f.kind === 'fall';
  // (lying down, the posture's foot point is the ankle itself)
  const ankleOf = (s) => onFeet ? add(T['ft' + s], [0, ankleUp - 0.005 / k, 0]) : T['ft' + s];
  const legLen = bone('thigh_l', 'calf_l') + bone('calf_l', 'foot_l');
  if (f.kind === 'stand' || f.kind === 'brace') {
    // on their feet: the hips as high as legs (nearly straight standing, bent bracing) put them over their feet
    const straight = f.kind === 'brace' ? 0.8 : 0.985;
    let rise = Infinity;
    for (const side of ['l', 'r']) {
      const s = side === 'l' ? L : Rr;
      const hip = add(pos[idx(`thigh_${side}`)], shift), A = ankleOf(s);
      const h = Math.hypot(hip[0] - A[0], hip[2] - A[2]);
      rise = Math.min(rise, A[1] + Math.sqrt(Math.max(0, (straight * legLen) ** 2 - h * h)) - hip[1]);
    }
    shift[1] += rise;
  }
  for (let j = 0; j < J.length; j++) if (pos[j]) pos[j] = add(pos[j], shift);
  // the limbs, by two-bone IK: to the posture's hands and ankles at the body's own lengths, the elbow or knee
  // bending toward where the posture has it (and the way that joint bends: elbows back, knees forward)
  const solve = (rootJ, midJ, endJ, target, pole, natural, flex) => {
    const a = pos[idx(rootJ)];
    const l1 = bone(rootJ, midJ), l2 = bone(midJ, endJ);
    const d = sub(target, a), dl = len(d);
    const dir = dl > 1e-6 ? mul(d, 1 / dl) : natural;
    const reach = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-3, dl));
    const cosA = Math.max(-1, Math.min(1, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const off = (v) => sub(v, mul(dir, dot(v, dir)));
    const pp = off(sub(pole, a)), nat = off(natural);
    let b = add(pp, mul(nat, 0.35 * len(pp) + 1e-4));
    b = len(b) > 1e-6 ? norm(b) : len(nat) > 1e-6 ? norm(nat) : square([0, 1, 0], dir, [1, 0, 0]);
    const m = add(a, add(mul(dir, l1 * cosA), mul(b, l1 * sinA)));
    const e = add(a, mul(dir, reach));
    let n = cross(sub(m, a), sub(e, m));
    if (len(n) < 1e-5) n = cross(dir, mul(fwd, flex));
    const r1 = sub(P(midJ), P(rootJ)), r2 = sub(P(endJ), P(midJ));
    return [carry(frame(r1, cross(r1, [0, 0, flex])), frame(sub(m, a), n)), carry(frame(r2, cross(r2, [0, 0, flex])), frame(sub(e, m), n))];
  };
  // (a body down where it fell, pinned, thrown or adrift lies its limbs the posture's way, at their own length:
  // aimed joint to joint, not reached for)
  const aim = (rootJ, midJ, endJ, a, b, c, flex) => {
    const d1 = sub(b, a), d2 = sub(c, b);
    let n = cross(d1, d2);
    if (len(n) < 0.08 * len(d1) * len(d2)) n = cross(d1, mul(fwd, flex));
    const r1 = sub(P(midJ), P(rootJ)), r2 = sub(P(endJ), P(midJ));
    return [carry(frame(r1, cross(r1, [0, 0, flex])), frame(d1, n)), carry(frame(r2, cross(r2, [0, 0, flex])), frame(d2, n))];
  };
  const placed = !['down', 'pinned', 'fall', 'float'].includes(f.kind);
  for (const [side, s] of [['l', L], ['r', Rr]]) {
    // arms: the hand on along the forearm
    const [Ru, Rf] = placed ? solve(`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`, T['ha' + s], T['el' + s], mul(fwd, -1), 1)
      : aim(`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`, T['sh' + s], T['el' + s], T['ha' + s], 1);
    set(`upperarm_${side}`, Ru); set(`lowerarm_${side}`, Rf); set(`hand_${side}`, Rf);
    // legs: the foot pointing the way the person faces, sole-down
    const ankle = ankleOf(s);
    const [Rth, Rc] = placed ? solve(`thigh_${side}`, `calf_${side}`, `foot_${side}`, ankle, T['kn' + s], fwd, -1)
      : aim(`thigh_${side}`, `calf_${side}`, `foot_${side}`, T['hp' + s], T['kn' + s], ankle, -1);
    set(`thigh_${side}`, Rth); set(`calf_${side}`, Rc);
    // (on a floor, or a seat's footrest, sole-flat whatever the leg's angle; else along the shin, as a foot lies)
    const shin = norm(sub(ankle, T['kn' + s]));
    const down = onFeet ? [0, -1, 0] : shin;
    const footDir = norm(add(mul(square(face, down, fwd), 0.89), mul(down, 0.45)));
    const restFoot = sub(P(`ball_${side}`), P(`foot_${side}`));
    const Rfo = carry(frame(restFoot, cross(restFoot, [0, 0, -1])), frame(footDir, cross(footDir, mul(fwd, -1))));
    set(`foot_${side}`, Rfo); set(`ball_${side}`, Rfo);
  }
  for (let j = 0; j < J.length; j++) if (!trunk(j)) pos[j] = add(pos[parents[j]], rot(W[parents[j]], body.local[j]));
  return { k, W, pos };
}

/** The skinning matrices (column-major, joints × 16) for a mesh with inverse binds `ibm`: scale(k) · world · inverse bind. */
export function skinning(P, ibm, out) {
  const { k, W, pos } = P;
  for (let j = 0; j < W.length; j++) {
    const M = W[j], t = pos[j];
    const m = [k * M[0][0], k * M[0][1], k * M[0][2], 0, k * M[1][0], k * M[1][1], k * M[1][2], 0, k * M[2][0], k * M[2][1], k * M[2][2], 0, k * t[0], k * t[1], k * t[2], 1];
    const o = j * 16;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[o + c * 4 + r] = m[r] * ibm[o + c * 4] + m[4 + r] * ibm[o + c * 4 + 1] + m[8 + r] * ibm[o + c * 4 + 2] + m[12 + r] * ibm[o + c * 4 + 3];
  }
  return out;
}

// ---- THE BLANKET ----

/** A blanket over someone lying down: a grid across its footprint, lifted over the shape of the body (tiles). */
export function blanketMesh(f) {
  const q = f.cover, J = f.J;
  const e1 = sub(q[1], q[0]), e2 = sub(q[3], q[0]);
  const base = q[0][1] - 0.035;
  // the body under it, part by part (the trunk, thighs, shins, feet, arms), each as high as its joints and the flesh
  // over them; the head stays out (on their back the body lies its own thickness up from its joints: pose)
  const lift = f.kind === 'lying' || f.kind === 'down' ? LIE_LIFT : 0;
  const up = (p, flesh) => p[1] + lift + flesh - base;
  // (a foot lies the way the posing points it: on along the shin, turned the way the body faces)
  const toe = (s) => {
    const shin = norm(sub(J['ft' + s], J['kn' + s]));
    return add(J['ft' + s], mul(norm(add(mul(square(norm(f.face), shin, shin), 0.89), mul(shin, 0.45))), 0.13));
  };
  // (the trunk as high as its higher shoulder and hip: on their side, the upper ones)
  const hi = (a, b) => { const m2 = mid(a, b); m2[1] = Math.max(a[1], b[1]); return m2; };
  const parts = [[hi(J.shL, J.shR), hi(J.hpL, J.hpR), 0.1, 0.2]];
  for (const s of ['L', 'R']) parts.push(
    [J['hp' + s], J['kn' + s], 0.08, 0.13], [J['kn' + s], J['ft' + s], 0.065, 0.11], [J['ft' + s], toe(s), 0.09, 0.11],
    [J['sh' + s], J['el' + s], 0.06, 0.1], [J['el' + s], J['ha' + s], 0.05, 0.09]);
  const N = 22, M = 14, pos = [], nrm = [];
  const H = (u, v) => {
    const p = add(q[0], add(mul(e1, u), mul(e2, v)));
    let h = 0.025;
    for (const [a, b, flesh, r] of parts) {
      const ab = [b[0] - a[0], 0, b[2] - a[2]], ap = [p[0] - a[0], 0, p[2] - a[2]];
      const t = Math.max(0, Math.min(1, dot(ap, ab) / (dot(ab, ab) || 1)));
      const d = Math.hypot(ap[0] - ab[0] * t, ap[2] - ab[2] * t);
      const top = up(a, flesh) + (up(b, flesh) - up(a, flesh)) * t;
      // (flat over the part, falling away past it; a crease or two)
      h = Math.max(h, top * Math.exp(-((d / r) ** 4)) + 0.01 * Math.sin(u * 23 + v * 5));
    }
    // (it hangs a little over the edges)
    const edge = Math.min(u, 1 - u, v, 1 - v);
    return [p[0], base + h - Math.max(0, 0.05 - edge) * 0.8, p[2]];
  };
  const G = [];
  for (let i = 0; i <= N; i++) { G.push([]); for (let j = 0; j <= M; j++) G[i].push(H(i / N, j / M)); }
  const n = (i, j) => { const a = G[Math.min(N, i + 1)][j], b = G[Math.max(0, i - 1)][j], c = G[i][Math.min(M, j + 1)], d = G[i][Math.max(0, j - 1)]; const v = norm(cross(sub(c, d), sub(a, b))); return v[1] < 0 ? mul(v, -1) : v; };
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) { pos.push(...G[a][b]); nrm.push(...n(a, b)); }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm) };
}

function drawBlanket(gl, geo) {
  let b = R.blanket;
  if (!b) {
    b = R.blanket = { vao: gl.createVertexArray(), pos: gl.createBuffer(), nrm: gl.createBuffer() };
    gl.bindVertexArray(b.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    for (const l of [2, 3, 4, 5]) gl.disableVertexAttribArray(l);
  }
  gl.bindVertexArray(b.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.bufferData(gl.ARRAY_BUFFER, geo.nrm, gl.DYNAMIC_DRAW);
  gl.vertexAttrib2f(2, 0, 0); gl.vertexAttribI4ui(3, 0, 0, 0, 0); gl.vertexAttrib4f(4, 1, 0, 0, 0); gl.vertexAttrib4f(5, 0, 0, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, geo.pos.length / 3);
}

// ---- RENDERING ----

/**
 * The camera's projection for one figure's rectangle (bx, by, w, h on the
 * camera's canvas): the Lens (roomcam.js) as a matrix, world tiles → clip.
 */
function viewProj(cam, bx, by, w, h, zn, zf) {
  const { r, u, f, eye, s, ox, oy } = cam;
  const cx = 2 * (ox - bx) / w - 1, cy = 1 - 2 * (oy - by) / h;
  const A = (zf + zn) / (zf - zn), B = -2 * zf * zn / (zf - zn);
  const tx = -dot(r, eye), ty = -dot(u, eye), tz = -dot(f, eye);
  const ax = 2 * s / w, ay = 2 * s / h;
  const row0 = [ax * r[0] + cx * f[0], ax * r[1] + cx * f[1], ax * r[2] + cx * f[2], ax * tx + cx * tz];
  const row1 = [ay * u[0] + cy * f[0], ay * u[1] + cy * f[1], ay * u[2] + cy * f[2], ay * ty + cy * tz];
  const row2 = [A * f[0], A * f[1], A * f[2], A * tz + B];
  const row3 = [f[0], f[1], f[2], tz];
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) { m[c * 4] = row0[c]; m[c * 4 + 1] = row1[c]; m[c * 4 + 2] = row2[c]; m[c * 4 + 3] = row3[c]; }
  return m;
}

const hash = (n, s) => { let h = (n * 374761393 + s * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** Who someone is to look at: a body, a hair cut, a beard or not; kept by their id. */
export function lookOf(seed) {
  const sex = hash(seed, 1) < 0.5 ? 'male' : 'female';
  const cuts = HAIR_CUTS[sex];
  return { sex, cut: cuts[Math.floor(hash(seed, 2) * cuts.length)], beard: sex === 'male' && hash(seed, 3) < 0.3 };
}

/**
 * Render a camera's figures. cam: { eye (tiles), r, u, f, s, ox, oy (the
 * Lens), lights (env.lights), amb, exp, floor, tint [r, g, b] }, figs: [{
 * J, face, kind, box: { x0, y0, x1, y1 } (camera canvas px), vac, suit,
 * accent, skin, hair (sRGB 0–1), seed, cover, coverKind, coverCol,
 * outline: [r, g, b, a], outlineW (px) }]. Returns, per figure, where its
 * picture is in the GPU canvas ({ canvas, sx, sy, w, h, x, y }: copy it to
 * x, y) or null; null for all while the bodies load, or with no GPU.
 */
export function renderFigures(cam, figs) {
  if (!figs.length || !setup() || !R.ready) return null;
  const { gl, ctx, prog } = R;
  try {
    // pack the figures' rectangles in shelves
    const place = [];
    let x = 0, y = 0, shelf = 0, W = 0;
    for (const f of figs) {
      const bx = Math.floor(f.box.x0), by = Math.floor(f.box.y0);
      const w = Math.max(1, Math.ceil(f.box.x1) - bx), h = Math.max(1, Math.ceil(f.box.y1) - by);
      if (w > ATLAS_W || h > 4096) { place.push(null); continue; }
      if (x + w > ATLAS_W) { x = 0; y += shelf; shelf = 0; }
      if (y + h > 4096) { place.push(null); continue; }
      place.push({ vx: x, vy: y, w, h, bx, by });
      x += w; shelf = Math.max(shelf, h); W = Math.max(W, x);
    }
    const H = y + shelf;
    if (!W || !H) return figs.map(() => null);
    beginRender(ctx, W, H);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(prog.p);
    const u = prog.u;
    gl.uniform3fv(u.uAmb, cam.amb);
    gl.uniform1f(u.uExp, cam.exp);
    gl.uniform1f(u.uFloor, cam.floor);
    gl.uniform3fv(u.uTint, cam.tint || [1, 1, 1]);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    const skin = new Float32Array(R.J.length * 16), other = new Float32Array(R.J.length * 16);
    const out = [];
    figs.forEach((f, i) => {
      const pl = place[i];
      if (!pl) { out.push(null); return; }
      const look = lookOf(f.seed), sex = look.sex;
      const body = R.bodies[sex];
      const P = pose(body, { ...f, sex });
      skinning(P, body.ibm, skin);
      const cut = R.hair[look.cut];
      const beard = look.beard ? R.hair.beard : null;
      // the room's strongest lights at them
      const at = mid(f.J.hpL, f.J.hpR);
      const ls = cam.lights.map(l => { const d2 = (l.x - at[0]) ** 2 + (l.y - at[1]) ** 2 + (l.z - at[2]) ** 2; return { l, w: l.i / (1 + d2 / l.rad2) }; })
        .sort((a, c) => c.w - a.w).slice(0, MAX_LIGHTS);
      const LP = new Float32Array(MAX_LIGHTS * 3), LC = new Float32Array(MAX_LIGHTS * 3), LR = new Float32Array(MAX_LIGHTS), LK = new Float32Array(MAX_LIGHTS);
      ls.forEach(({ l }, k) => { LP.set([l.x, l.y, l.z], k * 3); LC.set([l.r * l.i, l.g * l.i, l.b * l.i], k * 3); LR[k] = l.rad2; LK[k] = l.cone || 0; });
      gl.uniform1i(u.uLN, ls.length);
      gl.uniform3fv(u.uLP, LP); gl.uniform3fv(u.uLC, LC); gl.uniform1fv(u.uLR2, LR); gl.uniform1fv(u.uLK, LK);
      // their rectangle, and the lens onto it
      gl.viewport(pl.vx, pl.vy, pl.w, pl.h);
      gl.scissor(pl.vx, pl.vy, pl.w, pl.h);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const zc = dot(cam.f, sub(at, cam.eye));
      gl.uniformMatrix4fv(u.uVP, false, viewProj(cam, pl.bx, pl.by, pl.w, pl.h, Math.max(0.05, zc - 2.5), zc + 2.5));
      gl.uniform3fv(u.uEye, cam.eye);
      gl.uniform4fv(u.uLand, body.land);
      gl.uniform1f(u.uChestY, body.chestY);
      gl.uniform3fv(u.uHelmC, body.helmC);
      gl.uniform3fv(u.uSuitC, f.suit); gl.uniform3fv(u.uAccC, f.accent);
      gl.uniform3fv(u.uSkinTint, [f.skin[0] / SKIN_REF[sex][0], f.skin[1] / SKIN_REF[sex][1], f.skin[2] / SKIN_REF[sex][2]]);
      gl.uniform3fv(u.uHairC, f.hair);
      gl.uniform1i(u.uVac, f.vac ? 1 : 0);
      gl.uniform1i(u.uRigid, 0);
      // wounds: how hurt each part is (0–1: head, torso, left arm, right arm; left leg, right leg, burns, dead)
      const w = f.wound || [0, 0, 0, 0, 0, 0, 0, 0];
      gl.uniform4f(u.uWoundA, w[0], w[1], w[2], w[3]);
      gl.uniform4f(u.uWoundB, w[4], w[5], w[6], w[7]);
      const vacGrow = f.vac ? 0.035 * P.k : 0;          // (a vac suit stands off the body)
      const draws = [{ m: body.meshes.body, part: 0, tex: body.skin, ibm: body.ibm }];
      if (!f.vac) {
        draws.push({ m: body.meshes.eyes, part: 1, tex: R.eyeTex, ibm: body.ibm }, { m: body.meshes.brows, part: 2, tex: null, ibm: body.ibm });
        if (cut) draws.push({ m: cut.vao, part: 3, tex: cut.tex, ibm: cut.ibm });
        if (beard) draws.push({ m: beard.vao, part: 3, tex: beard.tex, ibm: beard.ibm });
      } else draws.push({ m: body.helmet, part: 4, tex: null, ibm: body.ibm }, { m: body.pack, part: 5, tex: null, ibm: body.ibm });
      let lastIbm = null;
      const drawMesh = (d) => {
        if (d.ibm !== lastIbm) { gl.uniformMatrix4fv(u.uSkin, false, d.ibm === body.ibm ? skin : skinning(P, d.ibm, other)); lastIbm = d.ibm; }
        gl.bindVertexArray(d.m.vao);
        if (d.m.arrays) gl.drawArrays(gl.TRIANGLES, 0, d.m.count);
        else gl.drawElements(gl.TRIANGLES, d.m.count, d.m.type, 0);
      };
      // the edge: the body a little larger, behind itself (the selected one's in the selection colour)
      if (f.outline && f.outline[3] > 0) {
        gl.depthMask(false);
        gl.uniform1i(u.uPart, 7);
        gl.uniform4fv(u.uOut, f.outline);
        gl.uniform1f(u.uInflate, (f.outlineW || 1) * zc / cam.s + vacGrow);
        for (const d of draws) drawMesh(d);
        gl.depthMask(true);
      }
      for (const d of draws) {
        gl.uniform1i(u.uPart, d.part);
        gl.uniform1f(u.uInflate, d.part === 0 ? vacGrow : 0);
        if (d.tex) gl.bindTexture(gl.TEXTURE_2D, d.tex);
        drawMesh(d);
      }
      // a blanket, or the autodoc's sheet, over someone lying down
      if (f.cover) {
        gl.uniform1i(u.uRigid, 1);
        gl.uniform1i(u.uPart, 6);
        gl.uniform1f(u.uInflate, 0);
        gl.uniform3fv(u.uCovC, f.coverKind === 'sheet' ? [0.84, 0.88, 0.9] : f.coverCol || [0.4, 0.47, 0.56]);
        drawBlanket(gl, blanketMesh(f));
        gl.uniform1i(u.uRigid, 0);
      }
      out.push({ canvas: ctx.canvas, sx: pl.vx, sy: ctx.canvas.height - pl.vy - pl.h, w: pl.w, h: pl.h, x: pl.bx, y: pl.by });
    });
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    return out;
  } catch (e) {
    console.error('[figures]', e.message);
    return null;
  }
}

// ---- SHADERS ----

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
layout(location=3) in uvec4 aJ;
layout(location=4) in vec4 aW;
layout(location=5) in vec4 aTag;
uniform mat4 uSkin[23];
uniform mat4 uVP;
uniform float uInflate;
uniform int uRigid;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec4 vTag; out vec3 vRest;
void main() {
  mat4 M = mat4(1.0);
  if (uRigid == 0) {
    float ws = max(aW.x + aW.y + aW.z + aW.w, 1e-4);
    M = (uSkin[aJ.x] * aW.x + uSkin[aJ.y] * aW.y + uSkin[aJ.z] * aW.z + uSkin[aJ.w] * aW.w) / ws;
  }
  vec3 n = normalize(mat3(M) * aNrm);
  vec4 w = M * vec4(aPos, 1.0);
  w.xyz += n * uInflate;
  vW = w.xyz; vN = n; vUV = aUV; vTag = aTag; vRest = aPos;
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec2 vUV; in vec4 vTag; in vec3 vRest;
uniform int uPart, uVac;
uniform sampler2D uTex;
uniform vec3 uEye, uSuitC, uAccC, uSkinTint, uHairC, uCovC, uHelmC;
uniform vec4 uLand, uOut, uWoundA, uWoundB;
uniform float uChestY;
uniform int uLN;
uniform vec3 uLP[${MAX_LIGHTS}], uLC[${MAX_LIGHTS}];
uniform float uLR2[${MAX_LIGHTS}], uLK[${MAX_LIGHTS}];
uniform vec3 uAmb, uTint;
uniform float uExp, uFloor;
out vec4 frag;

float hash3(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float tone(float v) { return v < 0.82 ? v : 0.82 + 0.18 * (1.0 - exp(-(v - 0.82) * 5.5)); }
float band(float x, float a, float b) { float w = fwidth(x) * 0.75 + 1e-4; return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }

// the room's light on a point (as roomcam.js lights its plating, the downlights pooling below)
vec3 roomLight(vec3 p, vec3 N, vec3 V, float shin, out vec3 spec) {
  vec3 E = uAmb * (0.75 + 0.25 * N.y);
  spec = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLN) break;
    vec3 L = uLP[i] - p;
    float d2 = dot(L, L) + 1e-4, d = sqrt(d2);
    L /= d;
    float c = dot(N, L);
    float w = clamp((c + 0.25) / 1.25, 0.0, 1.0);
    float f = 1.0 / (1.0 + d2 / uLR2[i]);
    if (uLK[i] > 0.0) { float dn = L.y; if (dn <= 0.0) continue; f *= 0.6 * pow(dn, uLK[i]); }
    E += uLC[i] * w * f;
    if (c > 0.0) spec += uLC[i] * f * pow(max(dot(N, normalize(L + V)), 0.0), shin);
  }
  return E * uExp;
}

// the jumpsuit, worked from where a point lies on the body at rest (metres, the body facing +z, its left +x)
vec3 jumpsuit(vec3 q, out float ks) {
  float pelvisY = uLand.x, collarY = uLand.y, armY = uLand.z, wristX = uLand.w;
  vec3 c = uSuitC, dk = uSuitC * 0.6;
  ks = 0.05;
  float front = smoothstep(0.02, 0.06, q.z);
  float ax = abs(q.x);
  // the collar, a band round the neck
  c = mix(c, dk * 1.15, band(q.y, collarY - 0.035, collarY + 0.01));
  // a zip down the front from the collar to the belt
  float zip = band(ax, -1.0, 0.006) * band(q.y, pelvisY + 0.11, collarY) * front;
  c = mix(c, vec3(0.42), zip); ks += 0.3 * zip;
  // the belt and its buckle
  float belt = band(q.y, pelvisY + 0.065, pelvisY + 0.11) * step(ax, 0.3);
  c = mix(c, vec3(0.1, 0.1, 0.11), belt); ks += 0.1 * belt;
  float buckle = belt * band(ax, -1.0, 0.03) * front;
  c = mix(c, vec3(0.62, 0.63, 0.65), buckle); ks += 0.5 * buckle;
  // a name tape high on one side of the chest, the department's patch on the other (above the bust)
  float hi = front * step(0.05, q.z);
  c = mix(c, vec3(0.82, 0.81, 0.76), band(q.y, uChestY + 0.075, uChestY + 0.1) * hi * band(q.x, 0.04, 0.12));
  c = mix(c, uAccC, band(q.y, uChestY + 0.065, uChestY + 0.11) * hi * band(q.x, -0.11, -0.06));
  // the department's patch on each shoulder (the arm's outside: its top, at rest)
  c = mix(c, uAccC, band(ax, 0.26, 0.34) * step(armY + 0.025, q.y) * step(q.y, collarY));
  // cuffs at the wrists, panels on the thighs' outsides
  c = mix(c, dk, band(ax, wristX - 0.06, wristX + 0.01) * step(armY - 0.1, q.y));
  c = mix(c, mix(c, dk, 0.45), band(q.y, pelvisY - 0.4, pelvisY - 0.18) * step(0.15, ax) * step(q.z, 0.06));
  // seams down the sides
  c *= 1.0 - 0.25 * band(abs(q.z + 0.01), -1.0, 0.004) * step(q.y, collarY - 0.05) * step(0.12, ax);
  return c;
}

// wounds, worked from where a point lies on the body at rest: blood where a part is hurt (soaked dark into the
// cloth, bright and wet on skin), char where they were burned
float hurtAt(vec3 q) {
  float pelvisY = uLand.x, collarY = uLand.y, armY = uLand.z;
  float ax = abs(q.x);
  float head = step(collarY - 0.02, q.y);
  float arm = (1.0 - head) * step(0.2, ax) * step(armY - 0.12, q.y);
  float leg = (1.0 - head) * (1.0 - arm) * step(q.y, pelvisY - 0.05);
  float torso = (1.0 - head) * (1.0 - arm) * (1.0 - leg);
  float side = step(0.0, q.x);
  return head * uWoundA.x + torso * uWoundA.y + arm * mix(uWoundA.w, uWoundA.z, side) + leg * mix(uWoundB.y, uWoundB.x, side);
}
vec3 wounded(vec3 c, vec3 q, bool skin, inout float ks) {
  float d = hurtAt(q);
  if (d > 0.02) {
    float n = vnoise(q * 9.0) * 0.65 + vnoise(q * 26.0) * 0.35;
    float blood = smoothstep(0.05, 0.0, n - (d * 0.8 - 0.16));
    // (blood is dark: wet and deep red on skin, soaked near-black into the cloth)
    c = mix(c, skin ? vec3(0.3, 0.025, 0.02) : c * vec3(0.32, 0.07, 0.06) + vec3(0.07, 0.0, 0.0), blood * 0.85);
    ks = mix(ks, skin ? 0.35 : 0.12, blood);
  }
  if (uWoundB.z > 0.02) {
    float n = vnoise(q * 14.0 + 3.0);
    c = mix(c, vec3(0.06, 0.05, 0.045), smoothstep(0.05, 0.0, n - uWoundB.z * 0.7) * 0.85);
  }
  // the dead: no blood under the skin
  if (skin && uWoundB.w > 0.5) c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))) * vec3(0.92, 0.95, 1.0), 0.55);
  return c;
}

void main() {
  if (uPart == 7) { frag = vec4(uOut.rgb * uOut.a, uOut.a); return; }
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vW);
  if (dot(N, V) < 0.0) N = -N;
  vec3 alb = uSuitC;
  float ks = 0.05, shin = 12.0;
  float skinK = 0.0;
  if (uPart == 0) {
    float skin = smoothstep(0.35, 0.65, vTag.x), boot = smoothstep(0.35, 0.65, vTag.y), hand = smoothstep(0.35, 0.65, vTag.z);
    vec3 sk = min(texture(uTex, vUV).rgb * uSkinTint, vec3(1.0));
    if (uVac == 1) {
      // a vac suit: white, the department's band across the chest, grey gloves and boots
      alb = vec3(0.8, 0.82, 0.85);
      alb = mix(alb, uAccC, band(vRest.y, uChestY - 0.03, uChestY + 0.02) * step(0.0, vRest.z));
      alb = mix(alb, vec3(0.45, 0.47, 0.5), max(hand, boot));
      ks = 0.12; shin = 22.0;
      alb = wounded(alb, vRest, false, ks);
    } else {
      float k2;
      alb = jumpsuit(vRest, k2); ks = k2;
      skinK = max(skin, hand);
      alb = mix(alb, sk, skinK);
      alb = mix(alb, vec3(0.09, 0.09, 0.1), boot);
      if (boot > 0.5) { ks = 0.25; shin = 36.0; }
      if (skinK > 0.5) { ks = 0.08; shin = 18.0; }
      alb = wounded(alb, vRest, skinK > 0.5, ks);
      // fabric: a little creasing
      if (max(skinK, boot) < 0.5) N = normalize(N + (vec3(vnoise(vRest * 60.0), vnoise(vRest * 60.0 + 7.1), vnoise(vRest * 60.0 + 13.7)) - 0.5) * 0.12);
    }
  } else if (uPart == 1) {
    alb = texture(uTex, vUV).rgb; ks = 0.6; shin = 80.0;
  } else if (uPart == 2) {
    alb = uHairC * 0.9; ks = 0.04;
  } else if (uPart == 3) {
    float l = dot(texture(uTex, vUV).rgb, vec3(0.3, 0.55, 0.15));
    alb = mix(vec3(dot(uHairC, vec3(0.3, 0.55, 0.15))), uHairC, 0.8) * (0.5 + 1.0 * l); ks = 0.14; shin = 30.0;
  } else if (uPart == 4) {
    vec3 q = vRest - uHelmC;
    alb = vec3(0.86, 0.88, 0.9); ks = 0.35; shin = 50.0;
    if (q.z > 0.045 && q.y > -0.1 && q.y < 0.075 && abs(q.x) < 0.13) { alb = vec3(0.03, 0.04, 0.05); ks = 1.4; shin = 140.0; }
  } else if (uPart == 5) {
    alb = vec3(0.58, 0.61, 0.64); ks = 0.18; shin = 30.0;
  } else if (uPart == 6) {
    alb = uCovC * (0.92 + 0.12 * vnoise(vW * 18.0)); ks = 0.03; shin = 8.0;
  }
  vec3 spec;
  vec3 E = roomLight(vW, N, V, shin, spec);
  // the camera's gain: a person readable in a dark room, still shaped by the light
  vec3 lit;
  float form = 0.62 + 0.38 * clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  for (int i = 0; i < 3; i++) lit[i] = max(uFloor * form, min(1.0, tone(E[i])));
  lit *= uTint;
  vec3 col = alb * lit + spec * ks * uExp;
  // skin: light that soaks in round the edges
  col += alb * vec3(0.1, 0.035, 0.02) * (1.0 - abs(dot(N, V))) * skinK;
  frag = vec4(min(col, vec3(1.0)), 1.0);
}`;
