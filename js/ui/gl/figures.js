// ============================================================
// LONGHAUL — People on the room cameras, rendered on the GPU
//
// A person on a room camera (roomcam.js) is posed as a handful of joints
// (feet, knees, hips, shoulders, elbows, hands, neck, head). Here those
// joints are given a body: each figure is a distance field ray-marched per
// pixel through the camera's own lens (the same pinhole, so a figure sits
// exactly where the room puts it). The body is made the way an artist
// blocks one out: tapered limbs (thigh, calf, upper arm, forearm) from
// joint to joint, a ribcage, belly and pelvis blended into one torso,
// shoulders, a neck, a skull and jaw with a nose and ears, hands, boots.
// Hair is its own volume, in one of a few cuts. The jumpsuit carries its
// details where a camera would pick them out: the collar, a zip down the
// front, a belt and buckle, a name tape, the department's patch on chest
// and shoulder, cuffs, thigh pockets; a vac suit is bulkier, white, with
// its helmet and dark visor, the life-support pack on the back, joint
// bellows, gloves and boots. Someone asleep is under a blanket that lies
// over the shape of them.
//
// Light is the room's: its panels, strips, lamps and screens (the lights
// roomcam.js lights the plating with), the strongest few at the figure,
// with soft occlusion in the creases, a little sheen on fabric, skin and
// hair, a gleam on boots and visors, and the camera's gain that keeps a
// person readable in a dark room. A thin dark edge separates a figure
// from what is behind it; the selected one is outlined instead.
//
// Every figure a camera shows is rendered into its own rectangle of the
// shared GPU canvas (gl.js) in one pass, before the camera draws its
// rows: it then copies each in, in its place in the draw order, so the
// furniture nearer the lens still hides it. Without WebGL2 renderFigures
// answers null and the camera draws its 2D figures.
// ============================================================

import { sharedGL, beginRender, program, onContextLost } from './gl.js';

/** Metres in a room tile (roomcam.js: a person about 1.15 tiles, 1.75 m). */
export const TILE_M = 1.52;
const MAX_LIGHTS = 16;
const ATLAS_W = 2048;

let R = null;
onContextLost(() => { R = null; });

function setup() {
  const ctx = sharedGL();
  if (!ctx) return null;
  if (R && R.gl === ctx.gl) return R;
  try {
    const gl = ctx.gl;
    const prog = program(gl, VS, FS);
    const vao = gl.createVertexArray();          // (the quad is made in the vertex shader)
    R = { gl, ctx, prog, vao };
  } catch (e) {
    console.error('[figures]', e.message);
    R = null;
  }
  return R;
}

export const hasFigures3D = () => !!setup();

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
/** `v` made square to `n` (unit), or `alt` when it nearly lies along it. */
const square = (v, n, alt) => { const w = sub(v, mul(n, dot(v, n))); return len(w) > 1e-3 ? norm(w) : alt; };

const JOINTS = ['hd', 'nk', 'shL', 'shR', 'elL', 'elR', 'haL', 'haR', 'hpL', 'hpR', 'knL', 'knR', 'ftL', 'ftR'];

/**
 * The body a figure's joints make: everything the shader needs, in metres.
 * f: { J (tiles, y up), face, kind, vac, cover: [4 points] | null, coverKind }
 */
function bodyOf(f) {
  const lift = f.kind === 'lying' ? 0.07 : f.kind === 'down' ? 0.06 : 0;
  const J = {};
  for (const k of JOINTS) { const v = f.J[k]; J[k] = [v[0] * TILE_M, v[1] * TILE_M + lift, v[2] * TILE_M]; }
  const face = norm(f.face);
  const shM = mid(J.shL, J.shR), hpM = mid(J.hpL, J.hpR);
  const up = norm(sub(shM, hpM));
  const fwd0 = square(face, up, square([0, 1, 0], up, [1, 0, 0]));
  const right = norm(cross(up, fwd0));
  const fwd = cross(right, up);
  // the torso's masses: ribcage, belly, pelvis, down the spine
  const chest = add(lerp(hpM, shM, 0.74), mul(fwd, 0.01));
  const abd = add(lerp(hpM, shM, 0.36), mul(fwd, 0.005));
  const pelv = add(hpM, mul(up, 0.02));
  // the head: up the neck, looking where the face does
  const hup = norm(add(sub(J.hd, J.nk), mul(up, 0.4)));
  const hfwd = square(face, hup, fwd);
  const hright = norm(cross(hup, hfwd));
  const headBase = add(J.hd, mul(hup, -0.07));
  // feet: the ankle above the floor point, the boot along the way the person faces
  const ank = [], heel = [], toe = [], handE = [];
  for (const s of ['L', 'R']) {
    const ft = J['ft' + s], kn = J['kn' + s];
    const legUp = norm(sub(kn, ft));
    const fd = square(face, legUp, fwd);
    const a = add(ft, mul(legUp, 0.075));
    ank.push(a);
    heel.push(add(add(a, mul(fd, -0.04)), mul(legUp, -0.045)));
    toe.push(add(add(a, mul(fd, 0.16)), mul(legUp, -0.055)));
    const ha = J['ha' + s], el = J['el' + s];
    handE.push(add(ha, mul(norm(sub(ha, el)), 0.075)));
  }
  const pts = Object.values(J);
  const c = pts.reduce((a, b) => add(a, mul(b, 1 / pts.length)), [0, 0, 0]);
  const rad = Math.max(...pts.map(p => len(sub(p, c)))) + (f.vac ? 0.36 : 0.26);
  return { J, chest, abd, pelv, tor: [...right, ...up, ...fwd], hd: [...hright, ...hup, ...hfwd], headBase, ank, heel, toe, handE, c, rad, lift };
}

/**
 * Render a camera's figures. cam: { eye (tiles), r, u, f, s, ox, oy (the
 * Lens), lights (env.lights), amb, exp, floor, tint [r, g, b] }, figs: [{
 * J, face, kind, box: { x0, y0, x1, y1 } (camera canvas px), vac, suit, accent,
 * skin, hair (rgb 0–1), hairStyle, build, cover, coverKind, coverCol,
 * outline: [r, g, b, a], outlineW (px), dead }]. Returns, per figure, where
 * its picture is in the GPU canvas ({ canvas, sx, sy, w, h, x, y }: copy
 * it to x, y) or null; null for all when there is no GPU.
 */
export function renderFigures(cam, figs) {
  if (!figs.length || !setup()) return null;
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
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(prog.p);
    const u = prog.u;
    const T = TILE_M;
    gl.uniform3fv(u.uEye, mul(cam.eye, T));
    gl.uniform3fv(u.uR, cam.r); gl.uniform3fv(u.uU, cam.u); gl.uniform3fv(u.uF, cam.f);
    gl.uniform1f(u.uS, cam.s);
    gl.uniform2f(u.uO, cam.ox, cam.oy);
    gl.uniform3fv(u.uAmb, cam.amb);
    gl.uniform1f(u.uExp, cam.exp);
    gl.uniform1f(u.uFloor, cam.floor);
    gl.uniform3fv(u.uTint, cam.tint || [1, 1, 1]);
    gl.bindVertexArray(R.vao);
    const out = [];
    figs.forEach((f, i) => {
      const pl = place[i];
      if (!pl) { out.push(null); return; }
      const b = bodyOf(f);
      // the room's strongest lights at this figure
      const at = [b.c[0] / T, b.c[1] / T, b.c[2] / T];
      const ls = cam.lights.map(l => { const d2 = (l.x - at[0]) ** 2 + (l.y - at[1]) ** 2 + (l.z - at[2]) ** 2; return { l, w: l.i / (1 + d2 / l.rad2) }; })
        .sort((a, c) => c.w - a.w).slice(0, MAX_LIGHTS);
      const LP = new Float32Array(MAX_LIGHTS * 3), LC = new Float32Array(MAX_LIGHTS * 3), LR = new Float32Array(MAX_LIGHTS), LK = new Float32Array(MAX_LIGHTS);
      ls.forEach(({ l }, k) => { LP.set([l.x * T, l.y * T, l.z * T], k * 3); LC.set([l.r * l.i, l.g * l.i, l.b * l.i], k * 3); LR[k] = l.rad2 * T * T; LK[k] = l.cone || 0; });
      gl.uniform1i(u.uLN, ls.length);
      gl.uniform3fv(u.uLP, LP); gl.uniform3fv(u.uLC, LC); gl.uniform1fv(u.uLR2, LR); gl.uniform1fv(u.uLK, LK);
      gl.viewport(pl.vx, pl.vy, pl.w, pl.h);
      gl.scissor(pl.vx, pl.vy, pl.w, pl.h);
      gl.uniform4f(u.uBox, pl.bx, pl.by, pl.w, pl.h);
      gl.uniform2f(u.uVP, pl.vx, pl.vy);
      gl.uniform3fv(u.uJ, new Float32Array(JOINTS.flatMap(k => b.J[k])));
      gl.uniformMatrix3fv(u.uTor, false, new Float32Array(b.tor));
      gl.uniformMatrix3fv(u.uHd, false, new Float32Array(b.hd));
      gl.uniform3fv(u.uChest, b.chest); gl.uniform3fv(u.uAbd, b.abd); gl.uniform3fv(u.uPelv, b.pelv);
      gl.uniform3fv(u.uHeadBase, b.headBase);
      gl.uniform3fv(u.uAnk, new Float32Array([...b.ank[0], ...b.ank[1]]));
      gl.uniform3fv(u.uHeel, new Float32Array([...b.heel[0], ...b.heel[1]]));
      gl.uniform3fv(u.uToe, new Float32Array([...b.toe[0], ...b.toe[1]]));
      gl.uniform3fv(u.uHandE, new Float32Array([...b.handE[0], ...b.handE[1]]));
      gl.uniform4f(u.uBound, b.c[0], b.c[1], b.c[2], b.rad);
      gl.uniform3fv(u.uSuitC, f.suit); gl.uniform3fv(u.uAccC, f.accent);
      gl.uniform3fv(u.uSkinC, f.skin); gl.uniform3fv(u.uHairC, f.hair);
      gl.uniform1i(u.uVac, f.vac ? 1 : 0);
      gl.uniform1i(u.uHairStyle, f.hairStyle | 0);
      gl.uniform1f(u.uBuild, f.build ?? 0.5);
      gl.uniform1f(u.uSeed, f.seed ?? 0);
      gl.uniform4fv(u.uOut, f.outline || [0, 0, 0, 0]);
      gl.uniform1f(u.uOutW, f.outlineW || 0);
      // a blanket (or the autodoc's sheet) over someone lying down: its footprint and height
      if (f.cover) {
        const P = f.cover.map(p => [p[0] * T, p[1] * T + b.lift, p[2] * T]);
        const eu = sub(P[1], P[0]), ev = sub(P[3], P[0]);
        gl.uniform1i(u.uCover, f.coverKind === 'sheet' ? 2 : 1);
        gl.uniform3fv(u.uCov0, P[0]); gl.uniform3fv(u.uCovU, norm(eu)); gl.uniform3fv(u.uCovV, norm(ev));
        gl.uniform2f(u.uCovL, len(eu), len(ev));
        gl.uniform1f(u.uCovY, P[0][1] - 0.05);
        gl.uniform3fv(u.uCovC, f.coverCol || [0.4, 0.47, 0.56]);
      } else gl.uniform1i(u.uCover, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
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
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec3 uEye, uR, uU, uF;
uniform float uS;
uniform vec2 uO;
uniform vec4 uBox;
uniform vec2 uVP;
uniform vec3 uJ[14];
uniform mat3 uTor, uHd;
uniform vec3 uChest, uAbd, uPelv, uHeadBase;
uniform vec3 uAnk[2], uHeel[2], uToe[2], uHandE[2];
uniform vec4 uBound;
uniform vec3 uSuitC, uAccC, uSkinC, uHairC;
uniform int uVac, uHairStyle, uCover;
uniform float uBuild, uSeed;
uniform vec4 uOut;
uniform float uOutW;
uniform vec3 uCov0, uCovU, uCovV, uCovC;
uniform vec2 uCovL;
uniform float uCovY;
uniform int uLN;
uniform vec3 uLP[${MAX_LIGHTS}], uLC[${MAX_LIGHTS}];
uniform float uLR2[${MAX_LIGHTS}], uLK[${MAX_LIGHTS}];
uniform vec3 uAmb, uTint;
uniform float uExp, uFloor;
out vec4 frag;

// joints
#define HD uJ[0]
#define NK uJ[1]
#define SHL uJ[2]
#define SHR uJ[3]
#define ELL uJ[4]
#define ELR uJ[5]
#define HAL uJ[6]
#define HAR uJ[7]
#define HPL uJ[8]
#define HPR uJ[9]
#define KNL uJ[10]
#define KNR uJ[11]

// materials
const float M_SUIT = 1.0, M_SKIN = 2.0, M_HAIR = 3.0, M_BOOT = 4.0, M_HELM = 5.0, M_PACK = 6.0, M_GLOVE = 7.0, M_COVER = 8.0;

float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float sdEll(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
// a cone with round ends between a (radius r1) and b (radius r2)
float sdRC(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a; float l2 = dot(ba, ba); float rr = r1 - r2; float a2 = l2 - rr * rr; float il2 = 1.0 / l2;
  vec3 pa = p - a; float y = dot(pa, ba); float z = y - l2;
  vec3 xv = pa * l2 - ba * y; float x2 = dot(xv, xv);
  float y2 = y * y * l2; float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdRBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float hash3(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// where a point is along a segment (0 at a, 1 at b)
float along(vec3 p, vec3 a, vec3 b) { vec3 ba = b - a; return clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0); }

float LS, TS;     // limb and torso scale (a vac suit is bulkier)

float headD(vec3 p, out float hairD) {
  vec3 q = transpose(uHd) * (p - HD);
  float cran = sdEll(q - vec3(0.0, 0.012, -0.012), vec3(0.077, 0.097, 0.098));
  float jaw = sdEll(q - vec3(0.0, -0.046, 0.024), vec3(0.058, 0.056, 0.066));
  float d = smin(cran, jaw, 0.04);
  d = smin(d, length((q - vec3(0.0, -0.012, 0.093)) * vec3(1.5, 1.0, 1.0)) / 1.5 - 0.013, 0.014);
  vec3 e = vec3(abs(q.x), q.y, q.z) - vec3(0.078, -0.006, -0.008);
  d = smin(d, length(e * vec3(2.2, 1.0, 1.4)) / 2.2 - 0.02 / 2.2 * 2.0, 0.01);
  // hair: a cap above a hairline that runs from the brow down to the nape, by cut
  hairD = 1e9;
  if (uHairStyle != 3 || uVac == 1) {
    float grow = uHairStyle == 4 ? 0.016 : uHairStyle == 3 ? 0.002 : 0.008;
    vec3 c = q - vec3(0.0, 0.016, -0.016);
    float cap = sdEll(c, vec3(0.077, 0.097, 0.098) + grow);
    if (uHairStyle == 4) cap -= 0.006 * vnoise(q * 90.0);
    float cut = (q.y - 0.042 - 0.55 * (q.z - 0.09)) * 0.87;
    float h = max(cap, -cut);
    if (uHairStyle == 1) h = smin(h, sdRC(q, vec3(0.0, 0.01, -0.1), vec3(0.0, -0.13, -0.115), 0.03, 0.016), 0.02);
    if (uHairStyle == 2) h = smin(h, length(q - vec3(0.0, 0.045, -0.105)) - 0.038, 0.015);
    hairD = h;
  }
  return d;
}

// the scene: distance and material
vec2 map(vec3 p) {
  // the torso
  mat3 iT = transpose(uTor);
  // a ribcage that tapers to the waist, the belly, the pelvis; the shoulders' caps a little inside the joints
  float dT = sdEll(iT * (p - uChest), vec3(0.158 + 0.024 * uBuild, 0.15, 0.105) * TS);
  dT = smin(dT, sdEll(iT * (p - uAbd), vec3(0.128 + 0.016 * uBuild, 0.13, 0.092) * TS), 0.045);
  dT = smin(dT, sdEll(iT * (p - uPelv), vec3(0.148 + 0.014 * (1.0 - uBuild), 0.095, 0.098) * TS), 0.045);
  vec3 cL = mix(SHL, uChest, 0.12), cR = mix(SHR, uChest, 0.12);
  dT = smin(dT, length(p - cL) - 0.049 * LS, 0.04);
  dT = smin(dT, length(p - cR) - 0.049 * LS, 0.04);
  // arms and legs: tapered from joint to joint
  float dA = smin(sdRC(p, SHL, ELL, 0.043 * LS, 0.034 * LS), sdRC(p, ELL, HAL, 0.035 * LS, 0.025 * LS), 0.015);
  dA = min(dA, smin(sdRC(p, SHR, ELR, 0.043 * LS, 0.034 * LS), sdRC(p, ELR, HAR, 0.035 * LS, 0.025 * LS), 0.015));
  float dL = smin(sdRC(p, HPL, KNL, 0.072 * LS, 0.048 * LS), sdRC(p, KNL, uAnk[0], 0.05 * LS, 0.034 * LS), 0.025);
  dL = min(dL, smin(sdRC(p, HPR, KNR, 0.072 * LS, 0.048 * LS), sdRC(p, KNR, uAnk[1], 0.05 * LS, 0.034 * LS), 0.025));
  float dHand = min(sdRC(p, HAL, uHandE[0], 0.026 * LS, 0.019 * LS), sdRC(p, HAR, uHandE[1], 0.026 * LS, 0.019 * LS));
  float dBoot = min(sdRC(p, uHeel[0], uToe[0], 0.046 * LS, 0.038 * LS), sdRC(p, uHeel[1], uToe[1], 0.046 * LS, 0.038 * LS));
  float dNeck = sdRC(p, NK - uTor[1] * 0.05, uHeadBase, 0.052, 0.046);
  float hairD;
  float dHead = headD(p, hairD);
  float body = smin(dT, dA, 0.025);
  body = smin(body, dL, 0.03);
  float d = body, m = M_SUIT;
  float sk = smin(dNeck, dHead, 0.03);
  if (uVac == 1) {
    // the helmet over the head, the pack on the back
    float helm = length(p - HD - uHd[1] * 0.012 - uHd[2] * 0.012) - 0.158;
    helm = smin(helm, sdRC(p, NK - uTor[1] * 0.03, HD - uHd[1] * 0.06, 0.1, 0.11), 0.03);
    float pack = sdRBox(iT * (p - uChest) - vec3(0.0, -0.06, -0.185 * TS), vec3(0.15, 0.24, 0.075), 0.035);
    d = smin(d, pack, 0.02); if (pack < body) m = M_PACK;
    if (helm < d) { d = min(d, helm); m = M_HELM; } else d = smin(d, helm, 0.015);
    if (dHand < d) m = M_GLOVE; d = smin(d, dHand, 0.02);
    if (dBoot < d) m = M_BOOT; d = smin(d, dBoot, 0.03);
  } else {
    if (sk < d) m = M_SKIN; d = smin(d, sk, 0.025);
    if (hairD < d) m = M_HAIR; d = min(d, hairD);
    if (dHand < d) m = M_SKIN; d = smin(d, dHand, 0.015);
    if (dBoot < d + 0.004) m = M_BOOT; d = smin(d, dBoot, 0.025);
  }
  if (uCover > 0) {
    // the blanket lies over the shape of them, inside its footprint
    vec3 v = p - uCov0;
    vec2 ab = vec2(dot(v, uCovU), dot(v, uCovV));
    vec2 q = abs(ab - uCovL * 0.5) - (uCovL * 0.5 - 0.03);
    float foot = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.03;
    float slab = abs(p.y - uCovY) - 0.015;
    float drape = smin(slab, body - (uCover == 1 ? 0.04 : 0.02), 0.09);
    drape += 0.006 * sin(ab.x * 38.0 + 2.0 * sin(ab.y * 11.0)) * smoothstep(0.0, 0.1, ab.x);
    float cv = max(drape, foot);
    if (cv < d) m = M_COVER;
    d = min(d, cv);
  }
  return vec2(d, m);
}

vec3 normalAt(vec3 p, float e) {
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x + k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
}

float tone(float v) { return v < 0.82 ? v : 0.82 + 0.18 * (1.0 - exp(-(v - 0.82) * 5.5)); }

// the light the room throws on a point: as roomcam.js lights its plating, with the downlights pooling below
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

void main() {
  LS = uVac == 1 ? 1.38 : 1.0;
  TS = uVac == 1 ? 1.16 : 1.0;
  vec2 px = vec2(uBox.x + gl_FragCoord.x - uVP.x, 0.0);
  px.y = uBox.y + uBox.w - (gl_FragCoord.y - uVP.y);
  vec3 rd = normalize(uR * ((px.x - uO.x) / uS) + uU * ((uO.y - px.y) / uS) + uF);
  vec3 ro = uEye;
  // into the figure's bounding sphere
  vec3 oc = ro - uBound.xyz;
  float b = dot(oc, rd), c = dot(oc, oc) - uBound.w * uBound.w;
  float disc = b * b - c;
  if (disc <= 0.0) { frag = vec4(0.0); return; }
  float sq = sqrt(disc);
  float t = max(-b - sq, 0.0), tEnd = -b + sq;
  float minA = 1e9, tMin = t;
  bool hit = false;
  vec2 res = vec2(0.0);
  for (int i = 0; i < 110; i++) {
    vec3 p = ro + rd * t;
    res = map(p);
    float a = res.x / t;
    if (a < minA) { minA = a; tMin = t; }
    if (res.x < 0.25 * t / uS) { hit = true; break; }
    t += res.x * 0.92;
    if (t > tEnd) break;
  }
  float pxd = hit ? 0.0 : minA * uS;              // pixels from the silhouette
  float cov = clamp(1.0 - pxd, 0.0, 1.0);
  float outA = uOut.a * clamp(uOutW + 0.5 - pxd, 0.0, 1.0);
  if (cov <= 0.0 && outA <= 0.0) { frag = vec4(0.0); return; }
  vec3 col = vec3(0.0);
  if (cov > 0.0) {
    float th = hit ? t : tMin;
    vec3 p = ro + rd * th;
    if (!hit) res = map(p);
    float mat = res.y;
    vec3 N = normalAt(p, max(0.0012, 0.6 * th / uS));
    vec3 V = -rd;
    mat3 iT = transpose(uTor);
    vec3 qt = iT * (p - uChest), qp = iT * (p - uPelv);
    vec3 alb = uSuitC;
    float shin = 14.0, ks = 0.05;
    float bump = 0.0;
    if (mat == M_SUIT) {
      if (uVac == 1) {
        alb = vec3(0.78, 0.8, 0.83);
        // the department's band across the chest; bellows at the knees and elbows; a dark seal ring at the neck
        if (abs(qt.y + 0.01) < 0.03 && qt.z > -0.02) alb = uAccC;
        float bel = 0.0;
        bel = max(bel, 1.0 - smoothstep(0.0, 0.05, min(length(p - ELL), length(p - ELR))));
        bel = max(bel, 1.0 - smoothstep(0.0, 0.07, min(length(p - KNL), length(p - KNR))));
        alb *= 1.0 - 0.35 * bel * step(0.5, fract(dot(p, vec3(1.0)) * 45.0));
        ks = 0.12; shin = 22.0;
      } else {
        // the jumpsuit: collar, zip, belt and buckle, a name tape, the department's patches, cuffs, pockets
        vec3 dk = uSuitC * 0.62;
        float front = step(0.04, qt.z);
        if (front > 0.0 && abs(qt.x) < 0.0055 && qt.y > -0.36 && qt.y < 0.13) { alb = mix(dk, vec3(0.7), 0.25); ks = 0.25; shin = 40.0; }
        if (length(p - NK) < 0.085 && qt.y > 0.07) alb = dk * 1.1;
        if (qp.y > 0.055 && qp.y < 0.095) { alb = vec3(0.12, 0.12, 0.13); ks = 0.12; if (abs(qp.x) < 0.024 && qp.z > 0.05) { alb = vec3(0.62, 0.64, 0.66); ks = 0.6; shin = 60.0; } }
        if (front > 0.0 && qt.z > 0.07 && qt.x < -0.035 && qt.x > -0.125 && qt.y > -0.012 && qt.y < 0.022) alb = vec3(0.86, 0.85, 0.8);
        if (front > 0.0 && qt.z > 0.07 && qt.x > 0.045 && qt.x < 0.105 && qt.y > -0.02 && qt.y < 0.04) alb = uAccC;
        for (int s = 0; s < 2; s++) {
          vec3 sh = s == 0 ? SHL : SHR, el = s == 0 ? ELL : ELR, ha = s == 0 ? HAL : HAR, hp = s == 0 ? HPL : HPR, kn = s == 0 ? KNL : KNR;
          vec3 out3 = normalize(sh - uChest);
          float ua = along(p, sh, el);
          if (ua > 0.15 && ua < 0.4 && dot(p - mix(sh, el, ua), out3) > 0.02 && length(p - mix(sh, el, ua)) < 0.07) alb = uAccC;
          float fa = along(p, el, ha);
          if (fa > 0.84 && length(p - mix(el, ha, fa)) < 0.06) alb = dk;
          float th2 = along(p, hp, kn);
          vec3 outL = normalize(hp - uPelv);
          if (th2 > 0.4 && th2 < 0.68 && dot(p - mix(hp, kn, th2), outL) > 0.035) alb = mix(alb, dk, 0.55);
        }
        ks = 0.04; shin = 10.0;
        bump = 1.0;
      }
    } else if (mat == M_SKIN) {
      alb = uSkinC; ks = 0.07; shin = 18.0;
      // the face: brows, eyes, the mouth, when it shows
      vec3 q = transpose(uHd) * (p - HD);
      if (q.z > 0.045 && length(p - HD) < 0.13) {
        vec2 e = vec2(abs(q.x) - 0.031, q.y - 0.006);
        float eye = length(e * vec2(1.0, 1.8));
        if (eye < 0.011) alb = mix(alb * 0.25, vec3(0.06), 0.5);
        if (abs(q.y - 0.026) < 0.006 && abs(q.x) > 0.012 && abs(q.x) < 0.05) alb = mix(alb, uHairC, 0.75);
        if (abs(q.y + 0.052) < 0.004 && abs(q.x) < 0.022) alb *= 0.6;
      }
    } else if (mat == M_HAIR) {
      alb = uHairC; ks = 0.12; shin = 28.0;
      vec3 q = transpose(uHd) * (p - HD);
      alb *= 0.85 + 0.3 * vnoise(vec3(q.x * 180.0, q.y * 30.0, q.z * 180.0));
    } else if (mat == M_BOOT) {
      alb = uVac == 1 ? vec3(0.42, 0.44, 0.47) : vec3(0.1, 0.1, 0.11); ks = 0.25; shin = 36.0;
    } else if (mat == M_GLOVE) {
      alb = vec3(0.46, 0.48, 0.5); ks = 0.1;
    } else if (mat == M_PACK) {
      alb = vec3(0.58, 0.61, 0.64); ks = 0.18; shin = 30.0;
      if (abs(qt.y + 0.06) < 0.02) alb = uAccC * 0.8;
    } else if (mat == M_HELM) {
      vec3 q = transpose(uHd) * (p - HD);
      alb = vec3(0.86, 0.88, 0.9); ks = 0.35; shin = 50.0;
      if (q.z > 0.035 && q.y > -0.095 && q.y < 0.075 && abs(q.x) < 0.125) { alb = vec3(0.03, 0.04, 0.05); ks = 1.4; shin = 140.0; }
      if (length(p - NK) < 0.12 && q.y < -0.09) alb = vec3(0.4, 0.42, 0.45);
    } else if (mat == M_COVER) {
      alb = uCover == 2 ? vec3(0.84, 0.88, 0.9) : uCovC; ks = 0.03; shin = 8.0;
      bump = 0.6;
    }
    if (bump > 0.0) {
      // fabric: a little creasing
      vec3 g = vec3(vnoise(p * 26.0), vnoise(p * 26.0 + 7.1), vnoise(p * 26.0 + 13.7)) - 0.5;
      N = normalize(N + g * 0.14 * bump);
    }
    // soft occlusion in the creases (armpits, between the legs, under the chin)
    float occ = 0.0, w = 1.0;
    for (int i = 1; i <= 5; i++) { float h = 0.014 * float(i); occ += (h - map(p + N * h).x) * w; w *= 0.72; }
    float ao = clamp(1.0 - 3.2 * occ, 0.35, 1.0);
    vec3 spec;
    vec3 E = roomLight(p, N, V, shin, spec);
    // the camera's gain: a person readable in a dark room, still shaped by the light
    vec3 lit;
    float form = 0.62 + 0.38 * clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    for (int i = 0; i < 3; i++) lit[i] = max(uFloor * form, min(1.0, tone(E[i])));
    lit *= uTint;
    col = alb * lit * ao + spec * ks * uExp * ao;
    // skin and the blanket: light that soaks in round the edges
    if (mat == M_SKIN) col += alb * vec3(0.12, 0.04, 0.02) * (1.0 - abs(dot(N, V)));
    col = min(col, vec3(1.0));
  }
  // premultiplied: the figure over its outline
  vec3 pre = col * cov + uOut.rgb * outA * (1.0 - cov);
  float a = cov + outA * (1.0 - cov);
  frag = vec4(pre, a);
}`;
