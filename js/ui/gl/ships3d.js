// ============================================================
// LONGHAUL — Hulls and stations rendered on the GPU
//
// The drone's view and the telescope show ships and stations as what they
// are: lit solids (hullmesh.js) in sunlight. The Sun is the only real
// light out here; it casts shadows (a shadow map fitted to what is in the
// picture: a module's shadow on the next, a station's on the ships in its
// berths), and a rock close by lends a little bounce from below. Surfaces
// shade by what they are made of: bevelled plating with its panel seams
// (each panel a shade apart), armour plates, radiator fins (glowing dull
// red when the drive runs hot), gold foil, polished tanks, a bell of dark
// alloy with a white-hot throat when lit, the faction's band, lit ports and
// nav lights. A lit drive's plume is a volume of light along the ship's axis:
// a hot narrow core off the throat inside a faint sheath that flares, as
// exhaust does in vacuum, out past the hull's own breadth within a few bell
// lengths aft. It is drawn twice over, added: a strip along the axis turned
// to the camera (what a plume seen from the side is), fading as the axis
// turns toward the camera, and a stack of soft round glows along the axis,
// each as wide as the plume is there, that perspective piles up seen down
// the axis into the round glow round the stern a camera on our own hull sees
// looking aft (the near glows large, the far ones small toward the axis'
// vanishing point). Far off, the jet thinner than a pixel, its core and
// sheath are blurred to a pixel's footprint with their light kept (a far
// jet a pixel wide and dimmer, not a broken thread), and its shock
// diamonds smoothed away once finer than the picture holds; its glare
// through the lens is the cameras' (exterior.js driveGlare). Damage (damage.js) is cut and painted into the surface: holes
// (discarded, the dark inside of the hull seen through them), their torn
// edges bent out, scorching, pits, hot metal; a broken hull keeps its side
// of a ragged tear (the clip, in the shadow pass too). The plume is its own pass: light added, a bright core
// fraying out along the axis. Colours are worked in linear light, exposed
// and tone mapped (a filmic curve) like a camera's.
//
// renderScene() draws a scene (objects with their model matrices, a
// camera, the Sun) into the shared GPU canvas (gl.js) and returns the
// rectangle to copy out; null when there is no GPU. The drone and the
// telescope look with parallel rays (obliqueCamera, orthoCamera); a hull
// camera through a wide lens (perspectiveCamera): the eye a few metres off
// our plating, everything from our hull to a station kilometres off in one
// picture. Then the shading looks from the eye to each point (the light it
// sees off a surface, the detail a pixel can hold at that distance), the
// plume is turned to face the eye, and the rock's rays fan out from it.
// ============================================================

import { sharedGL, beginRender, program, vertexArray, drawArray, onContextLost, mat4, norm, linear } from './gl.js';
import { buildHullMesh, buildStationMesh, buildDebrisMesh } from './hullmesh.js';
import { Post } from './post.js';
import { drawWorld } from './world3d.js';
import { drawTown } from './town3d.js';

const LAYOUT = [['aPos', 3], ['aNrm', 3], ['aCol', 3], ['aMat', 1]];
const MAX_SCARS = 16;
const GLOWS = 22;                // the round glows a plume's volume is built of, along its axis

// A broken hull's tear: the plane it keeps one side of, made ragged (shared by the shadow and the picture)
const CLIP_GLSL = `
float hn(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float nz(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hn(i), hn(i + vec3(1,0,0)), f.x), mix(hn(i + vec3(0,1,0)), hn(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hn(i + vec3(0,0,1)), hn(i + vec3(1,0,1)), f.x), mix(hn(i + vec3(0,1,1)), hn(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float clipSide(vec3 p) { return dot(uClip.xyz, p) - uClip.w + (nz(p * 0.9) - 0.5) * 2.4 + (nz(p * 3.7) - 0.5) * 0.7; }`;
const SHADOW_SIZE = 2048;

let R = null;                     // { gl, lit, depth, plume, meshes: Map, shadow: { fb, tex } }

onContextLost(() => { R = null; });

function setup() {
  const ctx = sharedGL();
  if (!ctx) return null;
  if (R && R.gl === ctx.gl) return R;
  const gl = ctx.gl;
  try {
    const lit = program(gl, LIT_VS, LIT_FS, LAYOUT.map(a => a[0]));
    const depth = program(gl, DEPTH_VS, DEPTH_FS, LAYOUT.map(a => a[0]));
    const plume = program(gl, PLUME_VS, PLUME_FS, ['aPos']);
    const rock = program(gl, ROCK_VS, ROCK_FS);
    // the shadow map: a depth texture compared in the shader
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // the plume: a strip along −x (s 0 → 1) and across it (t −1 → 1), turned to face the camera in the shader
    const cone = [];
    const N = 48;
    for (let i = 0; i < N; i++) {
      const s0 = i / N, s1 = (i + 1) / N;
      cone.push(s0, -1, 0, s1, -1, 0, s1, 1, 0, s0, -1, 0, s1, 1, 0, s0, 1, 0);
    }
    const plumeVA = vertexArray(gl, new Float32Array(cone), [['aPos', 3]]);
    // …and the glows along it: GLOWS camera-facing quads (s, corner), closer together near the throat
    const quads = [];
    for (let i = 0; i < GLOWS; i++) {
      const sv = (i / (GLOWS - 1)) ** 2;
      quads.push(sv, -1, -1, sv, 1, -1, sv, 1, 1, sv, -1, -1, sv, 1, 1, sv, -1, 1);
    }
    const glowVA = vertexArray(gl, new Float32Array(quads), [['aPos', 3]]);
    const glow = program(gl, GLOW_VS, GLOW_FS, ['aPos']);
    let post = new Post(gl);
    if (!post.ok) post = null;
    R = { gl, ctx, lit, depth, plume, plumeVA, glow, glowVA, rock, post, empty: gl.createVertexArray(), meshes: new Map(), shadow: { fb, tex } };
  } catch (e) {
    console.error('[ships3d]', e.message);
    R = null;
  }
  return R;
}

/** A mesh for a hull class or a station, built once. */
function meshFor(kind, key, model, tl) {
  const id = `${kind}:${key}`;
  let m = R.meshes.get(id);
  if (m) return m;
  const built = kind === 'hull' ? buildHullMesh(model, tl, key) : kind === 'debris' ? buildDebrisMesh(key) : buildStationMesh(model, key);
  const va = vertexArray(R.gl, built.data, LAYOUT);
  m = { va, info: built };
  R.meshes.set(id, m);
  return m;
}

/** Is the GPU path there? */
export const has3D = () => !!setup();

/** The model matrix of a hull posed in a plane at (x, y), facing `facing`, rolled by its view ('top' | 'side' | …). */
export function hullMatrix(x, y, facing, view = 'top', z = 0) {
  const c = Math.cos(facing), s = Math.sin(facing);
  const fwd = [c, s, 0], lat = [-s, c, 0], up = [0, 0, 1];
  // roll about the hull's own axis: top (dorsal toward us), top-flip (belly), side (port flank), side-flip
  let ay, az;
  if (view === 'top-flip') { ay = lat.map(v => -v); az = [0, 0, -1]; }
  else if (view === 'side') { ay = [0, 0, -1]; az = lat; }
  else if (view === 'side-flip') { ay = [0, 0, 1]; az = lat.map(v => -v); }
  else { ay = lat; az = up; }
  return mat4.basis(fwd, ay, az, [x, y, z]);
}

/** A station's model matrix: its frame turned by `angle` in the plane, at (x, y). */
export function stationMatrix(x, y, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return mat4.basis([c, s, 0], [-s, c, 0], [0, 0, 1], [x, y, 0]);
}

/**
 * Render a scene. scene: {
 *   w, h (device px), view, proj (mat4: the camera), viewDir (unit, the camera's look, world),
 *   sun: unit vector toward the Sun (world), sunI (intensity), bounce: { dir, col } | null,
 *   exposure, objects: [{ kind: 'hull'|'station', key, model, tl, m (mat4), tint (hex),
 *     plume (G), heat (0–1), lights (bool) }], shadowBox: { cx, cy, cz, half, depth } (world), t (s)
 * } → { canvas, sx, sy, w, h } or null.
 */
export function renderScene(scene) {
  if (!setup()) return null;
  const { gl } = R;
  try {
    // ---- the shadow map, fitted to the picture
    const lightVP = shadowCamera(scene);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.shadow.fb);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.0, 4.0);
    gl.useProgram(R.depth.p);
    gl.uniformMatrix4fv(R.depth.u.uLight, false, lightVP);
    const drawn = [];
    for (const o of scene.objects) {
      const m = meshFor(o.kind, o.key, o.model, o.tl || 2);
      drawn.push({ o, m });
      gl.uniformMatrix4fv(R.depth.u.uModel, false, o.m);
      gl.uniform4fv(R.depth.u.uClip, o.clip || [1, 0, 0, -1e9]);
      gl.uniform1f(R.depth.u.uClipOn, o.clip ? 1 : 0);
      drawArray(gl, m.va);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- the picture
    const rect = beginRender(R.ctx, scene.w, scene.h);
    // (in linear light into the camera's target, exposed and bloomed after: post.js; without float targets, exposed here)
    const post = R.post && scene.post !== false ? R.post : null;
    if (post) post.begin(rect.w, rect.h);
    const tonemap = post ? 0 : 1;
    gl.enable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.shadow.tex);
    const rk = scene.rock;
    scene.$tonemap = tonemap;
    if (rk && scene.ray) drawRock(gl, scene, lightVP);
    if (scene.world && scene.ray) drawWorld(gl, scene, R.empty);     // (a world from close: a shuttle's cameras, world3d.js)
    if (scene.world && scene.ray) drawTown(gl, scene);               // (and its spaceport and town, near the ground: town3d.js)
    gl.useProgram(R.lit.p);
    const u = R.lit.u;
    gl.uniformMatrix4fv(u.uView, false, scene.view);
    gl.uniformMatrix4fv(u.uProj, false, scene.proj);
    gl.uniformMatrix4fv(u.uLight, false, lightVP);
    gl.uniform3fv(u.uViewDir, scene.viewDir);
    // (a wide lens: the eye, and its focal length in device px, for what each point shows of itself)
    gl.uniform3fv(u.uEye, scene.eye || [0, 0, 0]);
    gl.uniform1f(u.uPersp, scene.persp ? 1 : 0);
    gl.uniform1f(u.uFocal, scene.focalPx || 1);
    gl.uniform3fv(u.uSun, norm(scene.sun));
    gl.uniform1f(u.uSunI, scene.sunI ?? 3.2);
    gl.uniform3fv(u.uBounceDir, scene.bounce ? norm(scene.bounce.dir) : [0, 0, 1]);
    gl.uniform3fv(u.uBounceCol, scene.bounce ? scene.bounce.col : [0, 0, 0]);
    gl.uniform1f(u.uExposure, scene.exposure ?? 1);
    gl.uniform1f(u.uTime, scene.t || 0);
    gl.uniform1f(u.uPxPerM, scene.pxPerM || 4);
    gl.uniform2f(u.uShadowTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
    gl.uniform1f(u.uShadowOn, scene.shadows === false ? 0 : 1);
    gl.uniform1f(u.uTonemap, tonemap);
    gl.uniform3fv(u.uFillDir, norm(scene.fill?.dir || [0, 0, 1]));
    gl.uniform3fv(u.uFillCol, scene.fill?.col || [0, 0, 0]);
    gl.uniform3fv(u.uRockS, rk ? rk.S : [0, 0, 0]);
    gl.uniform3fv(u.uRockN, rk ? rk.n : [0, 0, 1]);
    gl.uniform1f(u.uRockR, rk ? rk.R : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.shadow.tex);
    gl.uniform1i(u.uShadow, 0);
    for (const { o, m } of drawn) {
      gl.uniformMatrix4fv(u.uModel, false, o.m);
      gl.uniformMatrix3fv(u.uNrmM, false, mat4.normal3(o.m));
      gl.uniform3fv(u.uTint, linear(o.tint || '#8FA6BC'));
      gl.uniform1f(u.uPlume, o.plume || 0);
      gl.uniform1f(u.uHeat, o.heat ?? Math.min(1, (o.plume || 0) * 0.35));
      const dmg = o.damage;
      gl.uniform1f(u.uLights, o.lights === false ? 0 : dmg ? dmg.lights : 1);
      gl.uniform1f(u.uFlicker, dmg?.flicker ? 1 : 0);
      gl.uniform1f(u.uWear, o.tl <= 1 ? 1 : o.tl === 2 ? 0.6 : 0.3);
      gl.uniform1f(u.uWorn, o.kind === 'debris' ? 1 : dmg ? dmg.worn : 0);
      gl.uniform4fv(u.uClip, o.clip || [1, 0, 0, -1e9]);
      gl.uniform1f(u.uClipOn, o.clip ? 1 : 0);
      gl.uniform1f(u.uClipHeat, o.clipHeat || 0);
      const sc = dmg?.scars || [];
      gl.uniform1i(u.uScarN, sc.length);
      if (sc.length) {
        const A = new Float32Array(MAX_SCARS * 4), K = new Float32Array(MAX_SCARS * 4);
        sc.forEach((x, i) => { A.set([x.p[0], x.p[1], x.p[2], x.r], i * 4); K.set([x.hole, x.heat, x.kind, x.seed], i * 4); });
        gl.uniform4fv(u.uScar, A); gl.uniform4fv(u.uScarK, K);
      }
      const inf = m.info;
      gl.uniform2f(u.uStern, o.kind === 'hull' ? (inf.bell ? inf.bell.xT : -inf.L / 2) : -1e9, o.kind === 'hull' ? inf.L : 1);
      drawArray(gl, m.va);
    }
    // ---- plumes, light added
    const lit = drawn.filter(d => d.o.kind === 'hull' && d.o.plume > 0.01 && d.m.info.bell);
    if (lit.length) {
      gl.useProgram(R.plume.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.uniformMatrix4fv(R.plume.u.uView, false, scene.view);
      gl.uniformMatrix4fv(R.plume.u.uProj, false, scene.proj);
      gl.uniform1f(R.plume.u.uTime, scene.t || 0);
      gl.uniform1f(R.plume.u.uExposure, tonemap ? scene.exposure ?? 1 : 1);
      for (const { o, m } of lit) {
        const b = m.info.bell, g = o.plume;
        const len = m.info.L * Math.min(14, 2.2 + Math.sqrt(g) * 3.2);
        const rad = b.r * (0.9 + Math.min(1.5, g * 0.12));
        gl.uniformMatrix4fv(R.plume.u.uModel, false, o.m);
        gl.uniform3f(R.plume.u.uShape, b.x, len, rad);
        // (the sheath flares past the hull's breadth: half-width ~1.1 of its largest side)
        gl.uniform1f(R.plume.u.uSpread, 1.1 * Math.max(m.info.W || 0, m.info.H || 0, rad));
        gl.uniform3fv(R.plume.u.uViewDir, scene.viewDir);
        gl.uniform3fv(R.plume.u.uEye, scene.eye || [0, 0, 0]);
        gl.uniform1f(R.plume.u.uPersp, scene.persp ? 1 : 0);
        gl.uniform1f(R.plume.u.uFocal, scene.focalPx || 1);
        gl.uniform1f(R.plume.u.uPxPerM, scene.pxPerM || 1);
        gl.uniform1f(R.plume.u.uG, g);
        drawArray(gl, R.plumeVA);
      }
      // the volume's glows along the axis (the round glow seen down it)
      const G = R.glow.u;
      gl.useProgram(R.glow.p);
      gl.uniformMatrix4fv(G.uView, false, scene.view);
      gl.uniformMatrix4fv(G.uProj, false, scene.proj);
      gl.uniform1f(G.uExposure, tonemap ? scene.exposure ?? 1 : 1);
      gl.uniform3fv(G.uViewDir, scene.viewDir);
      gl.uniform3fv(G.uEye, scene.eye || [0, 0, 0]);
      gl.uniform1f(G.uPersp, scene.persp ? 1 : 0);
      gl.uniform1f(G.uFocal, scene.focalPx || 1);
      gl.uniform1f(G.uPxPerM, scene.pxPerM || 1);
      for (const { o, m } of lit) {
        const b = m.info.bell, g = o.plume;
        const len = m.info.L * Math.min(14, 2.2 + Math.sqrt(g) * 3.2);
        const rad = b.r * (0.9 + Math.min(1.5, g * 0.12));
        gl.uniformMatrix4fv(G.uModel, false, o.m);
        gl.uniform3f(G.uShape, b.x, len, rad);
        gl.uniform1f(G.uSpread, 1.1 * Math.max(m.info.W || 0, m.info.H || 0, rad));
        gl.uniform1f(G.uG, g);
        drawArray(gl, R.glowVA);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    if (post) post.finish({ exposure: scene.exposure ?? 1, bloom: scene.bloom ?? 1, threshold: scene.bloomFrom ?? 1 });
    return { canvas: R.ctx.canvas, ...rect };
  } catch (e) {
    console.error('[ships3d]', e.message);
    return null;
  }
}

/**
 * The rock a surface port stands on: a sphere, ray-cast per pixel along the
 * camera's (parallel) rays, its ground made of craters and regolith at every
 * scale the picture shows, lit by the Sun, shadowed by what stands on it.
 * It writes its depth, so the station and the ships hide it and it hides
 * what is behind its limb.
 */
function drawRock(gl, scene, lightVP) {
  const rk = scene.rock, ray = scene.ray, u = R.rock.u;
  gl.useProgram(R.rock.p);
  gl.depthFunc(gl.ALWAYS);
  gl.uniform3fv(u.uP0, ray.P0); gl.uniform3fv(u.uAx, ray.Ax); gl.uniform3fv(u.uAy, ray.Ay); gl.uniform3fv(u.uW, ray.W);
  gl.uniform4fv(u.uDepth, ray.depth || [0, 0, 0, 0]);
  gl.uniform1f(u.uPersp, scene.persp ? 1 : 0);
  gl.uniformMatrix4fv(u.uVP, false, ray.VP || mat4.identity());
  gl.uniform1f(u.uFocal, scene.focalPx || 1);
  gl.uniform3fv(u.uS, rk.S); gl.uniform3fv(u.uN, rk.n); gl.uniform3fv(u.uAlong, rk.along);
  gl.uniform1f(u.uR, rk.R);
  gl.uniform3fv(u.uAlb, rk.albedo);
  gl.uniform1f(u.uSeed, rk.seed || 0);
  gl.uniform3fv(u.uSun, norm(scene.sun));
  gl.uniform1f(u.uSunI, scene.sunI ?? 3.2);
  gl.uniform1f(u.uExposure, scene.exposure ?? 1);
  gl.uniform1f(u.uPxPerM, scene.pxPerM || 1);
  gl.uniform1f(u.uTonemap, scene.$tonemap);
  gl.uniform3fv(u.uFillDir, norm(scene.fill?.dir || [0, 0, 1]));
  gl.uniform3fv(u.uFillCol, scene.fill?.col || [0, 0, 0]);
  gl.uniformMatrix4fv(u.uLight, false, lightVP);
  gl.uniform1i(u.uShadow, 0);
  gl.uniform2f(u.uShadowTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
  gl.bindVertexArray(R.empty);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.depthFunc(gl.LEQUAL);
}

/**
 * The drone's camera: it looks down on the plane from above and to one side,
 * its picture plane kept parallel to the plane (as a view camera's is), so
 * the plane maps to the screen exactly as the 2D overlays have it (toS in
 * exterior.js: centre cx, cy in metres, turned by rot, sc device px per
 * metre), and a thing `z` metres out of the plane shows `k·z` to the right:
 * the tops of hulls and their flanks on one side. Returns the scene's
 * camera (view: world → clip; proj: identity) and the per-pixel rays.
 */
export function obliqueCamera(W, H, sc, rot, cx, cy, k, depthM) {
  const cr = Math.cos(-rot), sr = Math.sin(-rot);
  const er = [cr, -sr, 0], eu = [sr, cr, 0];
  const a = 2 * sc / W, b = 2 * sc / H;
  const wl = Math.hypot(1, k);
  const w = [-k * er[0] / wl, -k * er[1] / wl, 1 / wl];          // toward the camera
  const D = depthM;
  const ox = -(cx * er[0] + cy * er[1]), oy = -(cx * eu[0] + cy * eu[1]);
  const view = new Float32Array([
    er[0] * a, eu[0] * b, -w[0] / D, 0,
    er[1] * a, eu[1] * b, -w[1] / D, 0,
    k * a, 0, -w[2] / D, 0,
    ox * a, oy * b, (cx * w[0] + cy * w[1]) / D, 1,
  ]);
  return {
    view, proj: mat4.identity(), viewDir: [-w[0], -w[1], -w[2]],
    ray: { P0: [cx, cy, 0], Ax: [er[0] / a, er[1] / a, 0], Ay: [eu[0] / b, eu[1] / b, 0], W: [-k * er[0], -k * er[1], 1], depth: [-w[0] / D, -w[1] / D, -w[2] / D, (cx * w[0] + cy * w[1]) / D] },
  };
}

/** The light's camera: an orthographic box along the Sun's direction holding the scene's shadow box. */
function shadowCamera(scene) {
  const sb = scene.shadowBox;
  const L = norm(scene.sun);
  const up = Math.abs(L[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
  const c = [sb.cx, sb.cy, sb.cz];
  const reach = Math.hypot(sb.half, sb.half, sb.depth) + 10;
  const eye = [c[0] + L[0] * reach * 2, c[1] + L[1] * reach * 2, c[2] + L[2] * reach * 2];
  const view = mat4.lookDir(eye, [-L[0], -L[1], -L[2]], up);
  const proj = mat4.ortho(-reach, reach, -reach, reach, 0.1, reach * 4.2);
  return mat4.mul(proj, view);
}

/**
 * A hull camera's lens: from `eye`, looking along `fwd` with `up` the
 * screen's up, a vertical field `fovy` (rad) over w×h device px, the depth
 * from `near` to `far` (m). Returns the scene's camera with what the shading
 * needs (the eye, the focal length in px) and the rock's rays: from the eye
 * through each pixel (ROCK_FS, uPersp), toward the camera as the parallel
 * cameras' are.
 */
export function perspectiveCamera(eye, fwd, up, w, h, fovy, near, far) {
  const f = norm(fwd);
  const r = norm(cross3(f, up)), u = cross3(r, f);
  const view = mat4.lookDir(eye, f, u);
  const proj = mat4.perspective(fovy, w / h, near, far);
  const tv = Math.tan(fovy / 2), th = tv * w / h;
  return {
    view, proj, viewDir: f, eye: [...eye], persp: true, focalPx: h / 2 / tv,
    ray: { P0: [...eye], Ax: r.map(v => -v * th), Ay: u.map(v => -v * tv), W: f.map(v => -v), VP: mat4.mul(proj, view) },
  };
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** An orthographic camera looking along `dir` at `center`, `up` the screen's up; w×h device px at `scale` px/m. */
export function orthoCamera(center, dir, up, w, h, scale, depth) {
  const d = norm(dir);
  const eye = [center[0] - d[0] * depth, center[1] - d[1] * depth, center[2] - d[2] * depth];
  const view = mat4.lookDir(eye, d, up);
  const hw = w / 2 / scale, hh = h / 2 / scale;
  const proj = mat4.ortho(-hw, hw, -hh, hh, 0.01, depth * 2);
  return { view, proj, viewDir: d };
}


// ---- SHADERS ----

const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel, uLight;
out vec3 vObj;
void main() { vObj = aPos; gl_Position = uLight * uModel * vec4(aPos, 1.0); }`;
const DEPTH_FS = `#version 300 es
precision highp float;
in vec3 vObj;
uniform vec4 uClip;
uniform float uClipOn;
${CLIP_GLSL}
void main() { if (uClipOn > 0.5 && clipSide(vObj) < 0.0) discard; }`;

const LIT_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in float aMat;
uniform mat4 uModel, uView, uProj, uLight;
uniform mat3 uNrmM;
out vec3 vObj; out vec3 vONrm; out vec3 vNrm; out vec3 vCol; out vec4 vLight; out vec3 vWorld;
flat out int vMat;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz; vObj = aPos; vONrm = aNrm; vNrm = uNrmM * aNrm; vCol = aCol;
  vMat = int(aMat + 0.5);
  vLight = uLight * w;
  gl_Position = uProj * uView * w;
}`;

const LIT_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vObj; in vec3 vONrm; in vec3 vNrm; in vec3 vCol; in vec4 vLight; in vec3 vWorld;
flat in int vMat;
uniform vec3 uViewDir, uSun, uBounceDir, uBounceCol, uTint, uEye;
uniform float uSunI, uExposure, uTime, uPlume, uHeat, uLights, uWear, uPxPerM, uTonemap, uFlicker, uWorn, uClipOn, uClipHeat, uPersp, uFocal;
uniform vec4 uClip;
uniform int uScarN;
uniform vec4 uScar[${MAX_SCARS}], uScarK[${MAX_SCARS}];
uniform vec2 uStern;
uniform vec3 uFillDir, uFillCol;
uniform sampler2DShadow uShadow;
uniform vec2 uShadowTexel;
uniform float uShadowOn;
uniform vec3 uRockS, uRockN;
uniform float uRockR;
out vec4 frag;

float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }

// The face's own 2D coordinates: the two axes across its dominant normal
vec2 faceUV(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.x > a.y && a.x > a.z) return p.yz;
  if (a.y > a.z) return p.xz;
  return p.xy;
}
// Device px a metre of this surface covers: one figure for a parallel camera; through a wide lens, by its distance from the eye
float pxPerM() { return uPersp > 0.5 ? uFocal / max(length(uEye - vWorld), 0.05) : uPxPerM; }
// Panel seams: dark lines on a grid (size in m), antialiased by the pixel's footprint; .x the line, .y a per-panel value
vec2 panels(vec2 uv, vec2 size, float lw) {
  vec2 g = uv / size;
  vec2 cell = floor(g);
  vec2 f = abs(fract(g) - 0.5) * size;          // metres from the panel's centre lines
  vec2 dist = size * 0.5 - f;                    // metres from the nearest seam
  vec2 fw = fwidth(uv) * 0.8 + 1e-4;
  vec2 l = 1.0 - smoothstep(vec2(lw) - fw, vec2(lw) + fw, dist);
  return vec2(max(l.x, l.y) * clamp(0.02 * pxPerM() / max(lw, 0.01), 0.0, 1.0), hash2(cell));
}

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
${CLIP_GLSL}
// the nearest of a lattice of jittered points (pits from gunfire)
float cells(vec3 p) {
  vec3 i = floor(p), f = fract(p); float m = 1.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(hash(i + g), hash(i + g + 11.3), hash(i + g + 27.1));
    m = min(m, length(g + o - f));
  }
  return m;
}
// each panel set a hair off true, as real plating is: it catches the light a little differently
vec3 panelTilt(vec2 uv, vec2 size, vec3 N, float k) {
  vec2 c = floor(uv / size);
  vec3 j = vec3(hash2(c + 1.3), hash2(c + 7.1), hash2(c + 3.7)) - 0.5;
  return normalize(N + (j - N * dot(j, N)) * k);
}

float shadowAt(vec3 N) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 p = vLight.xyz / vLight.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float bias = 0.0007 + 0.002 * (1.0 - max(dot(N, uSun), 0.0));
  float s = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) s += texture(uShadow, vec3(p.xy + vec2(float(i), float(j)) * uShadowTexel * 1.25, p.z - bias));
  return s / 25.0;
}

// GGX specular with Schlick Fresnel and a Smith visibility
vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 alb, float rough, float metal) {
  vec3 H = normalize(L + V);
  float NL = max(dot(N, L), 0.0), NV = max(dot(N, V), 1e-3), NH = max(dot(N, H), 0.0), VH = max(dot(V, H), 0.0);
  float a = rough * rough, a2 = a * a;
  float d = NH * NH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * d * d);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (NV / (NV * (1.0 - k) + k)) * (NL / (NL * (1.0 - k) + k));
  vec3 F0 = mix(vec3(0.04), alb, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VH, 5.0);
  vec3 spec = D * G * F / (4.0 * NV * max(NL, 1e-3) + 1e-4);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * alb / 3.14159 + spec) * NL;
}

void main() {
  vec3 N = normalize(vNrm);
  vec3 V = uPersp > 0.5 ? normalize(uEye - vWorld) : -normalize(uViewDir);
  // a broken hull keeps its side of the tear
  float cut = 1e9;
  if (uClipOn > 0.5) { cut = clipSide(vObj); if (cut < 0.0) discard; }
  // a closed hull's inside is only seen through a hole or a tear: the faces turned away, of its solid parts
  bool solid = vMat == 0 || vMat == 1 || vMat == 2 || vMat == 4 || vMat == 9 || vMat == 10 || vMat == 16 || vMat == 17 || vMat == 21 || vMat == 22;
  bool inside = solid && dot(N, V) < 0.0;
  if (dot(N, V) < 0.0) N = -N;                   // (thin and open parts are seen from either side)
  // ---- the scars: holes (cut through, their edges torn and curled out), peppering, scorching, scrapes
  float scorch = 0.0, rim = 0.0, glow = 0.0, pits = 0.0, scrape = 0.0;
  vec3 bend = vec3(0.0);
  for (int i = 0; i < ${MAX_SCARS}; i++) {
    if (i >= uScarN) break;
    vec3 d = vObj - uScar[i].xyz;
    float r = uScar[i].w, dist = length(d) / r;
    if (dist > 3.4) continue;
    vec4 K = uScarK[i];
    float jag = vnoise(d / r * 2.6 + K.w * 37.0) - 0.5;
    if (K.z < 0.5) {
      float hr = 0.5 + 0.4 * jag;
      if (dist < hr && !inside) discard;
      float rr = smoothstep(hr + 0.4, hr, dist);
      rim = max(rim, rr);
      bend += normalize(d) * rr;
      // (the torn edge itself white-hot, cooling; the plating round it only warmed)
      glow = max(glow, K.y * (smoothstep(hr + 0.16, hr, dist) + 0.25 * smoothstep(hr + 0.7, hr, dist)));
      scorch = max(scorch, smoothstep(2.9 + jag, 0.4, dist));
    } else if (K.z < 1.5) {
      float area = smoothstep(1.0, 0.55, dist + jag * 0.35);
      if (area > 0.0) {
        // (rounds of a few centimetres: pits a hand across, with a bright lip where the plate splashed)
        vec3 q = vObj * 2.2 + K.w * 19.0;
        float c = cells(q);
        float pit = smoothstep(0.3, 0.16, c) * step(0.35, hash(floor(q))) * area;
        rim = max(rim, smoothstep(0.42, 0.3, c) * (1.0 - smoothstep(0.3, 0.2, c)) * step(0.35, hash(floor(q))) * area * 0.8);
        pits = max(pits, pit);
        scorch = max(scorch, area * 0.45);
        glow = max(glow, K.y * pit * 0.6);
      }
    } else if (K.z < 2.5) {
      scorch = max(scorch, smoothstep(1.15, 0.15, dist + jag * 0.6) * 0.9);
    } else {
      float a = smoothstep(1.0, 0.35, dist + jag * 0.3);
      scrape = max(scrape, a * step(0.55, fract(dot(vObj, vec3(0.3, 2.1, 1.7)) * 3.0 + jag)));
    }
  }
  // the tear of a broken hull: torn metal along it, scorched back from it
  if (uClipOn > 0.5) {
    rim = max(rim, smoothstep(0.7, 0.0, cut));
    scorch = max(scorch, smoothstep(5.0, 0.0, cut) * 0.9);
    glow = max(glow, uClipHeat * smoothstep(0.9, 0.0, cut));
  }
  vec3 on = normalize(vONrm);
  vec3 p = vObj;
  vec3 alb = vCol;
  float rough = 0.5, metal = 0.2, ao = 1.0;
  vec3 emis = vec3(0.0);
  vec2 uv = faceUV(p, on);
  float grime = fbm(p * 0.35) * uWear;
  // soot from the drive and the RCS, heaviest toward the stern
  float soot = uStern.x > -1e8 ? exp(-max(p.x - uStern.x, 0.0) / (0.14 * uStern.y)) * (0.55 + 0.45 * fbm(p * 1.3)) : 0.0;

  if (vMat == 0) {                               // plating: panels a shade apart, seams, a little grime
    vec2 pn = panels(uv, vec2(1.6, 1.1), 0.025);
    N = panelTilt(uv, vec2(1.6, 1.1), N, 0.07);
    alb *= 0.9 + 0.2 * pn.y - 0.12 * grime;
    alb *= 1.0 - 0.55 * pn.x;
    rough = 0.42 + 0.25 * grime + 0.1 * pn.y; metal = 0.35;
  } else if (vMat == 1) {                        // armour: big dark plates, worn bright at the edges
    vec2 pn = panels(uv, vec2(3.2, 2.2), 0.04);
    N = panelTilt(uv, vec2(3.2, 2.2), N, 0.05);
    alb *= 0.85 + 0.25 * pn.y - 0.15 * grime;
    alb *= 1.0 - 0.6 * pn.x;
    rough = 0.6 + 0.2 * grime; metal = 0.45;
  } else if (vMat == 2) {                        // machinery: smaller panels, vents
    vec2 pn = panels(uv, vec2(0.9, 0.7), 0.02);
    alb *= 0.88 + 0.18 * pn.y - 0.15 * grime;
    alb *= 1.0 - 0.5 * pn.x;
    float vent = step(0.86, pn.y) * step(0.5, fract(uv.x * 6.0));
    alb *= 1.0 - 0.6 * vent;
    rough = 0.5 + 0.2 * grime; metal = 0.5;
  } else if (vMat == 3) {                        // radiator: fins along the panel, warm when the drive runs hot
    float fin = 0.5 + 0.5 * sin(p.x * 18.0);
    N = normalize(N + vec3(0.0, 0.0, 0.0) + on * 0.0 + vec3(0.35 * cos(p.x * 18.0), 0.0, 0.0) * step(0.5, abs(on.z) + abs(on.y)));
    alb *= 0.75 + 0.35 * fin;
    rough = 0.35; metal = 0.75;
    emis = vec3(1.0, 0.24, 0.05) * uHeat * uHeat * (0.6 + 0.4 * fin) * 0.22;
  } else if (vMat == 4) {                        // tank: polished, a faint brushed grain
    rough = 0.22 + 0.08 * vnoise(vec3(p.x * 0.5, p.y * 40.0, p.z * 40.0)); metal = 0.85;
    alb *= 0.95 + 0.1 * vnoise(p * 0.8) - 0.1 * grime;
  } else if (vMat == 5) {                        // truss
    rough = 0.45; metal = 0.8; alb *= 0.9 + 0.2 * hash(floor(p * 2.0));
  } else if (vMat == 6) {                        // the bell's outside: dark refractory alloy, blued by heat toward the throat
    rough = 0.38; metal = 0.9;
    float t = clamp((p.x - uStern.x) / (0.06 * uStern.y) + 1.0, 0.0, 1.0);
    alb = mix(alb * vec3(0.95, 0.85, 0.7), alb * vec3(0.7, 0.75, 1.15), t);
    alb *= 0.9 + 0.2 * vnoise(vec3(p.x * 6.0, atan(p.y, p.z) * 4.0, 0.0));
  } else if (vMat == 7) {                        // the bell's inside: bright, white-hot with the drive lit
    rough = 0.3; metal = 0.9;
    emis = vec3(0.75, 0.85, 1.0) * uPlume * 1.6 + vec3(1.0, 0.55, 0.25) * uHeat * 0.6;
  } else if (vMat == 8) {                        // ports: lit from inside, not every one; the dark ones glass
    float h = hash(floor(p * 1.1 + 0.5));
    float on2 = step(1.0 - 0.7 * uLights, h) * step(0.01, uLights);
    if (uFlicker > 0.5) on2 *= step(0.3, fract(sin(floor(uTime * 6.0 + h * 50.0)) * 43758.5));
    emis = mix(vec3(1.0, 0.7, 0.4), vec3(0.75, 0.85, 1.0), step(0.8, h)) * (0.5 + 0.9 * h) * on2 * 2.4;
    alb = vec3(0.03, 0.035, 0.04); rough = 0.06; metal = 0.0;
  } else if (vMat == 9) {                        // dark recesses, hatches
    rough = 0.75; metal = 0.1;
  } else if (vMat == 10) {                       // the faction's band
    alb = uTint * (0.9 - 0.1 * grime); rough = 0.45; metal = 0.1;
  } else if (vMat == 11) { emis = vec3(1.0, 0.06, 0.04) * 6.0 * uLights; alb = vec3(0.2, 0.02, 0.02); }
  else if (vMat == 12) { emis = vec3(0.1, 1.0, 0.25) * 6.0 * uLights; alb = vec3(0.02, 0.2, 0.05); }
  else if (vMat == 13) {
    float strobe = step(0.92, fract(uTime * 0.8));
    emis = vec3(1.0) * 14.0 * strobe * uLights; alb = vec3(0.4);
  } else if (vMat == 14) {                       // foil: gold, crinkled
    float c = vnoise(p * 9.0);
    N = normalize(N + (vec3(vnoise(p * 9.0 + 3.1), vnoise(p * 9.0 + 7.3), vnoise(p * 9.0 + 1.7)) - 0.5) * 0.9);
    alb = vec3(0.82, 0.6, 0.22) * (0.8 + 0.4 * c); rough = 0.32; metal = 1.0;
  } else if (vMat == 15) {                       // ice: frost and cracks, a glint
    float f = fbm(p * 0.6);
    N = normalize(N + (vec3(fbm(p * 1.3 + 2.0), fbm(p * 1.3 + 5.0), fbm(p * 1.3 + 9.0)) - 0.5) * 0.7);
    alb *= 0.8 + 0.3 * f; rough = 0.3 + 0.3 * f; metal = 0.0;
  } else if (vMat == 16) {                       // containers: corrugated sides, painted
    float rib = 0.5 + 0.5 * sin((abs(on.z) > 0.5 ? p.x : p.x) * 9.0);
    alb *= 0.85 + 0.2 * rib - 0.2 * grime; rough = 0.6; metal = 0.2;
  } else if (vMat == 17) {                       // ceramic tiles
    vec2 pn = panels(uv, vec2(0.32, 0.32), 0.008);
    alb *= 0.85 + 0.3 * pn.y; alb *= 1.0 - 0.4 * pn.x; rough = 0.85; metal = 0.0;
  } else if (vMat == 18) { rough = 0.55; metal = 0.05; alb *= 0.95 - 0.1 * grime; }
  else if (vMat == 19) {                         // a pad on the rock: slabs and regolith
    vec2 pn = panels(uv, vec2(24.0, 24.0), 0.2);
    alb *= 0.75 + 0.35 * fbm(p * 0.05) + 0.1 * pn.y; alb *= 1.0 - 0.3 * pn.x; rough = 0.92; metal = 0.0;
  } else if (vMat == 20) { emis = vec3(1.0, 0.9, 0.7) * 3.0 * uLights; alb = vec3(0.6); }
  else if (vMat == 22) {                         // insulation blanket: white, quilted, crinkled
    vec2 q = fract(uv * 3.0) - 0.5;
    N = normalize(N + (vec3(vnoise(p * 14.0), vnoise(p * 14.0 + 4.1), vnoise(p * 14.0 + 8.3)) - 0.5) * 0.5);
    alb *= 0.9 + 0.12 * vnoise(p * 3.0) - 0.15 * grime - 0.1 * smoothstep(0.42, 0.5, max(abs(q.x), abs(q.y))); rough = 0.55; metal = 0.15;
  }
  else if (vMat == 21) {                         // hazard stripes
    float s = step(0.5, fract((uv.x + uv.y) * 1.4));
    alb = mix(vec3(0.02), vec3(0.75, 0.52, 0.06), s); rough = 0.6; metal = 0.1;
  }

  alb *= 1.0 - 0.6 * soot * step(float(vMat), 4.5);
  // ---- damage on the surface
  if (uWorn > 0.0) {
    // a hull that has been through it: streaked with soot, its paint dulled
    float w = uWorn * smoothstep(0.45, 0.8, fbm(p * 0.22 + 4.0));
    alb = mix(alb, alb * vec3(0.45, 0.43, 0.4), w * 0.6);
    rough = mix(rough, 0.85, w * 0.6);
  }
  if (scorch > 0.0) {
    float s = scorch * (0.75 + 0.25 * fbm(p * 2.3));
    alb = mix(alb, vec3(0.018, 0.016, 0.014), s * 0.92);
    rough = mix(rough, 0.95, s); metal = mix(metal, 0.1, s);
  }
  if (rim > 0.0) {
    // torn plating: bright where it tore, bent out round the hole
    alb = mix(alb, vec3(0.5, 0.49, 0.47) * (0.7 + 0.5 * vnoise(p * 23.0)), rim * 0.75);
    metal = mix(metal, 0.95, rim); rough = mix(rough, 0.32, rim);
    if (length(bend) > 1e-3) N = normalize(N + normalize(bend) * rim * 1.3 + (vec3(vnoise(p * 9.0), vnoise(p * 9.0 + 3.3), vnoise(p * 9.0 + 6.1)) - 0.5) * rim * 1.2);
  }
  if (pits > 0.0) { alb = mix(alb, vec3(0.01), pits * 0.85); N = normalize(N + (vec3(hash(floor(p * 40.0)), hash(floor(p * 40.0) + 3.0), 0.5) - 0.5) * pits); }
  if (scrape > 0.0) { alb = mix(alb, vec3(0.62, 0.62, 0.6), scrape * 0.7); metal = mix(metal, 1.0, scrape); rough = mix(rough, 0.25, scrape); }
  float fl = 0.8 + 0.2 * sin(uTime * 13.0 + p.x * 2.0) * sin(uTime * 7.3 + p.z);
  // (hot steel: dull red cooling, orange, white only in the first moments)
  emis += mix(vec3(0.9, 0.22, 0.05), vec3(1.0, 0.8, 0.55), smoothstep(0.75, 1.0, glow)) * glow * glow * 1.7 * fl;
  if (inside) {
    // the inside, through the hole: dark, charred, lit by what light gets in and the glow of the fire
    alb = vec3(0.03, 0.028, 0.026) * (0.6 + 0.8 * fbm(p * 1.7)); metal = 0.15; rough = 0.9;
    emis = vec3(1.0, 0.38, 0.1) * glow * 0.08 * fl;
  }
  float sh = shadowAt(N) * (inside ? 0.25 : 1.0);
  if (uRockR > 0.0) {
    // the rock between this and the Sun (its night side, or its shadow across the field)
    vec3 q0 = vWorld - uRockS;
    float Bh = dot(uSun, q0) + uRockR * dot(uSun, uRockN);
    float Cq = dot(q0, q0) + 2.0 * uRockR * dot(q0, uRockN);
    float disc = Bh * Bh - Cq;
    if (Bh < 0.0) sh *= 1.0 - smoothstep(0.0, uRockR * 4.0, disc);
  }
  vec3 col = brdf(N, V, uSun, alb, rough, metal) * uSunI * sh;
  // what little light there is besides: the rock's bounce from below, starlight
  float bn = max(dot(N, uBounceDir), 0.0);
  col += alb * (1.0 - metal * 0.6) * (uBounceCol * bn + vec3(0.012, 0.014, 0.02));
  // a port's floodlights (and, far from one, the faint light of everything else in the sky)
  col += brdf(N, V, uFillDir, alb, max(rough, 0.35), metal) * uFillCol + alb * uFillCol * 0.08;
  // a metal shows the sky it faces: black, and the rock's glow toward it
  vec3 Rf = reflect(-V, N);
  col += mix(vec3(0.04), alb, metal) * uBounceCol * 0.6 * max(dot(Rf, uBounceDir), 0.0) * (1.0 - rough);
  col += emis;
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  frag = vec4(col, 1.0);
}`;

const ROCK_VS = `#version 300 es
out vec2 vClip;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vClip = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const ROCK_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec2 vClip;
uniform vec3 uP0, uAx, uAy, uW, uS, uN, uAlong, uSun, uAlb;
uniform vec4 uDepth;
uniform float uR, uSunI, uExposure, uPxPerM, uSeed, uTonemap, uPersp, uFocal;
uniform mat4 uVP;
float gPx;                                         // device px per metre where this ray meets the ground (set in main)
uniform vec3 uFillDir, uFillCol;
uniform mat4 uLight;
uniform sampler2DShadow uShadow;
uniform vec2 uShadowTexel;
out vec4 frag;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
// how much of a feature size metres across the picture can show (none below a few pixels)
float lod(float size) { return smoothstep(1.5, 5.0, size * gPx); }
float fbm(vec2 p, float size) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * (vn(p) - 0.5) * lod(size); p = p * 2.03 + 17.1; a *= 0.5; size *= 0.5; }
  return s;
}
// craters in a grid of cells: one in some cells, a bowl with a raised rim and its ejecta
float craters(vec2 x, float cell, float chance) {
  vec2 c = floor(x / cell);
  float hs = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = c + vec2(float(i), float(j)) + uSeed;
    if (h21(id) > chance) continue;
    vec2 ctr = (id - uSeed + vec2(h21(id + 3.1), h21(id + 7.7))) * cell;
    float rad = cell * (0.16 + 0.34 * h21(id + 11.3));
    float d = length(x - ctr) / rad;
    float bowl = d < 1.0 ? (d * d - 1.0) * 0.2 : 0.0;
    float rim = exp(-pow((d - 1.0) / 0.2, 2.0)) * 0.06;
    float ej = d > 1.0 ? 0.025 * exp(-(d - 1.0) * 2.0) : 0.0;
    hs += (bowl + rim + ej) * rad;
  }
  return hs;
}
float height(vec2 x) {
  float h = fbm(x / 900.0, 900.0) * 60.0 + fbm(x / 60.0, 60.0) * 3.0 + fbm(x / 6.0, 6.0) * 0.35;
  h += craters(x, 2400.0, 0.5) * lod(800.0) + craters(x, 420.0, 0.55) * lod(140.0) + craters(x, 70.0, 0.6) * lod(24.0) + craters(x, 12.0, 0.6) * lod(4.0);
  return h;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  // the ray toward the camera through this pixel: parallel (the drone), or from a wide lens' eye
  bool persp = uPersp > 0.5;
  vec3 W = persp ? uW + vClip.x * uAx + vClip.y * uAy : uW;
  vec3 p0 = persp ? uP0 : uP0 + vClip.x * uAx + vClip.y * uAy;
  vec3 q0 = p0 - uS;
  float A = dot(W, W);
  float Bh = dot(W, q0) + uR * dot(W, uN);
  float Cq = dot(q0, q0) + 2.0 * uR * dot(q0, uN);
  float disc = Bh * Bh - A * Cq;
  float t;
  if (disc >= 0.0) { float sq = sqrt(disc); t = Bh <= 0.0 ? (-Bh + sq) / A : Cq / (-Bh - sq); }
  else t = -Bh / A;
  // (through a lens, ground behind the eye is not in the picture; the detail a pixel holds goes by the distance)
  if (persp && t > 0.0) discard;
  gPx = persp ? uFocal / max(abs(t) * sqrt(A), 0.05) : uPxPerM;
  float edge = -disc / (2.0 * A * uR);                 // metres outside the limb
  float cov = clamp(0.5 - edge * gPx, 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec3 h = q0 + t * W;
  vec3 ng = normalize(h + uR * uN);
  // the ground's own coordinates (metres along the surface round the port), and its relief
  vec3 ta = normalize(uAlong - ng * dot(uAlong, ng)), tz = normalize(cross(ng, ta));
  vec2 x = vec2(dot(h, uAlong), h.z);
  float e = max(0.25, 0.6 / gPx);
  float h0 = height(x), hx = height(x + vec2(e, 0.0)), hy = height(x + vec2(0.0, e));
  vec3 N = normalize(ng - ta * (hx - h0) / e - tz * (hy - h0) / e);
  vec3 V = normalize(W);
  // regolith: dark, mottled; the craters' floors a shade apart
  float mott = 0.75 + 0.5 * vn(x / 1500.0 + 3.0) * lod(1500.0) + 0.25 * (vn(x / 90.0) - 0.5) * lod(90.0) + 0.2 * (vn(x / 7.0) - 0.5) * lod(7.0);
  vec3 alb = uAlb * mott;
  // lit as dust is (lunar-Lambert: bright toward the Sun, flat at full phase), shadowed by what stands on it
  float ci = dot(N, uSun), ce = max(dot(N, V), 0.05);
  float lam = max(ci, 0.0);
  float lr = lam > 0.0 ? 2.0 * lam / (lam + ce) : 0.0;
  vec3 wp = uS + h;
  vec4 lp = uLight * vec4(wp, 1.0);
  vec3 sp = lp.xyz / lp.w * 0.5 + 0.5;
  float sh = 1.0;
  if (sp.x > 0.0 && sp.x < 1.0 && sp.y > 0.0 && sp.y < 1.0 && sp.z < 1.0) {
    sh = 0.0;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) sh += texture(uShadow, vec3(sp.xy + vec2(float(i), float(j)) * uShadowTexel * 1.5, sp.z - 0.0015));
    sh /= 9.0;
  }
  // (the terminator: the ground's own relief shadows itself as the Sun goes low)
  float self = smoothstep(-0.05, 0.12, dot(ng, uSun));
  vec3 col = alb * uSunI * mix(lam, lr, 0.55) * sh * self / 3.14159 * 2.2 + alb * vec3(0.012, 0.014, 0.02);
  // the port's floodlights on the ground round it
  col += alb * uFillCol * max(dot(N, uFillDir), 0.0) * 1.4 * exp(-length(h) / 1800.0);
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  vec4 cp = uVP * vec4(wp, 1.0);
  float z = persp ? cp.z / cp.w : dot(uDepth.xyz, wp) + uDepth.w;
  gl_FragDepth = clamp(z * 0.5 + 0.5, 0.0, 1.0);
  frag = vec4(col * cov, cov);
}`;

const PLUME_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel, uView, uProj;
uniform vec3 uShape, uViewDir, uEye;    // the bell's exit (x, ship frame), the plume's length and radius (m); the camera's look (a wide lens: its eye)
uniform float uPersp, uSpread;          // (the sheath's half-width once it has flared, m)
uniform float uFocal, uPxPerM;          // the lens' focal length (device px), or a parallel camera's scale (px/m)
out vec2 vST;                           // along (0–1) and across (m from the axis)
out float vPxM;                         // metres a pixel spans there
out float vHalf;                        // the strip's drawn half-width (m)
out float vEnd;                         // how nearly end-on the camera sees the axis (the glows take over)
void main() {
  float s = aPos.x, t = aPos.y;
  // along the axis in the world, turned across it to face the camera
  vec3 a0 = (uModel * vec4(uShape.x, 0.0, 0.0, 1.0)).xyz;
  vec3 ax = normalize((uModel * vec4(-1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 vdir = uPersp > 0.5 ? normalize(a0 - uEye) : normalize(uViewDir);
  vec3 side = cross(ax, vdir);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : normalize(cross(ax, vec3(0.0, 0.0, 1.0)));
  vEnd = 1.0 - sl;
  vec3 c = a0 + ax * (s * uShape.y);
  float pxM = uPersp > 0.5 ? max(length(c - uEye), 0.05) / uFocal : 1.0 / max(uPxPerM, 1e-6);
  // the core widens slowly off the throat; the sheath flares out past the hull within the first stretch aft;
  // never drawn narrower than a few pixels (far off, the light a pixel takes in is spread over it: the fragment's blur)
  float wCore = uShape.z * (1.0 + 2.6 * s) * 1.8;
  float w = max(max(wCore, mix(wCore, uSpread, smoothstep(0.0, 0.3, s))), 3.0 * pxM);
  vST = vec2(s, t * w);
  vPxM = pxM;
  vHalf = w;
  gl_Position = uProj * uView * vec4(c + side * t * w, 1.0);
}`;

const PLUME_FS = `#version 300 es
precision highp float;
in vec2 vST;
in float vPxM;
in float vHalf;
in float vEnd;
uniform vec3 uShape;
uniform float uTime, uG, uExposure, uSpread;
out vec4 frag;
float h(float x) { return fract(sin(x * 91.7) * 47453.3); }
void main() {
  float s = vST.x, y = vST.y;
  // light through a glowing column: a hot narrow core off the throat (its width its own, however far the
  // sheath has flared), a wide faint sheath, both fading down the plume; each as wide as it is or as a
  // pixel's footprint blurs it, whichever is more, its light kept (a far jet thin as a thread is a pixel wide, dimmer)
  float wCore = uShape.z * (1.0 + 2.6 * s) * 1.8;
  float w = max(wCore, mix(wCore, uSpread, smoothstep(0.0, 0.3, s)));
  float wc = (0.09 + 0.25 * s) * wCore, ws = (0.45 + 0.3 * s) * w, px = 0.75 * vPxM;
  float wcE = sqrt(wc * wc + px * px), wsE = sqrt(ws * ws + px * px);
  float core = (wc / wcE) * exp(-y * y / (wcE * wcE)) * (exp(-s * 7.0) * 3.0 + exp(-s * 2.2) * 0.5);
  float sheath = (ws / wsE) * exp(-y * y / (wsE * wsE)) * (exp(-s * 2.6) * 0.38 + 0.05 * exp(-s * 0.8));
  // shock diamonds near the bell (smoothed away where they are finer than the picture holds)
  float period = uShape.y * 0.0898 / vPxM;
  float dia = 0.5 + 0.5 * cos(s * 70.0 - uTime * 2.0);
  core *= 1.0 + 0.7 * dia * exp(-s * 10.0) * smoothstep(2.0, 6.0, period);
  float fl = 0.9 + 0.1 * h(floor(uTime * 30.0));
  vec3 col = vec3(1.0, 0.97, 0.95) * core * 2.4 + vec3(0.42, 0.58, 1.0) * sheath;
  col *= fl * clamp(0.35 + uG * 0.25, 0.0, 2.2) * uExposure * smoothstep(1.0, 0.75, s) * smoothstep(1.0, 0.8, abs(y) / vHalf);
  // (seen down its axis the strip is edge-on: the glows carry the plume there)
  col *= pow(1.0 - vEnd, 1.5);
  frag = vec4(col, 0.0);
}`;

// The plume's volume: round glows along its axis, each facing the camera, as wide as the plume there
const GLOW_VS = `#version 300 es
layout(location=0) in vec3 aPos;        // s along the plume (0 the bell, 1 its end), the quad's corner
uniform mat4 uModel, uView, uProj;
uniform vec3 uShape, uViewDir, uEye;
uniform float uPersp, uSpread, uFocal, uPxPerM;
out vec2 vUV;
out float vS;
out float vEnd;
out float vBlur;                        // a pixel's footprint against the glow's radius
void main() {
  float s = aPos.x;
  vec3 a0 = (uModel * vec4(uShape.x, 0.0, 0.0, 1.0)).xyz;
  vec3 ax = normalize((uModel * vec4(-1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 c = a0 + ax * (s * uShape.y);
  vec3 vdir = uPersp > 0.5 ? normalize(c - uEye) : normalize(uViewDir);
  vec3 up0 = abs(vdir.z) < 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 right = normalize(cross(vdir, up0)), up = cross(right, vdir);
  float pxM = uPersp > 0.5 ? max(length(c - uEye), 0.05) / uFocal : 1.0 / max(uPxPerM, 1e-6);
  // (the glows' sheath spreads wider than the strip's: the faint outer light of exhaust in vacuum, round the stern)
  float wCore = uShape.z * (1.0 + 2.6 * s) * 1.8;
  float w = max(max(wCore, mix(wCore, 2.0 * uSpread, smoothstep(0.0, 0.35, s))), 3.0 * pxM);
  vEnd = 1.0 - length(cross(ax, vdir));
  vUV = aPos.yz; vS = s;
  vBlur = 0.75 * pxM / w;
  gl_Position = uProj * uView * vec4(c + (right * aPos.y + up * aPos.z) * w, 1.0);
}`;

const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vS;
in float vEnd;
in float vBlur;
uniform float uG, uExposure;
out vec4 frag;
void main() {
  float r2 = dot(vUV, vUV);
  if (r2 > 1.0) discard;
  // a hot centre near the throat, the blue sheath round it, both thinning down the plume (the centre
  // no smaller than a pixel blurs it, its light kept)
  float b2 = vBlur * vBlur, kc = 1.0 / 30.0, kcE = kc + b2;
  float core = (kc / kcE) * exp(-r2 / kcE) * exp(-vS * 5.0) * 2.4;
  float sheath = exp(-r2 * 2.6) * (exp(-vS * 2.0) * 0.85 + 0.06);
  vec3 col = vec3(1.0, 0.97, 0.95) * core + vec3(0.42, 0.58, 1.0) * sheath;
  // one of a stack: seen down the axis they pile up into the round glow; from the side the strip carries most of it
  col *= (0.12 + 0.88 * vEnd) * (5.0 / float(${GLOWS})) * clamp(0.35 + uG * 0.25, 0.0, 2.2) * uExposure * smoothstep(1.0, 0.7, vS) * (1.0 - smoothstep(0.6, 1.0, r2));
  frag = vec4(col, 0.0);
}`;

