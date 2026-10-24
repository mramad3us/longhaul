// ============================================================
// LONGHAUL — The camera's own response: exposure, tone, bloom
//
// A scene (ships3d.js) is rendered in linear light, unclipped, into a
// multisampled floating-point target: a lit port, a nav light, the core
// of a plume and the Sun's glint off a tank are many times brighter than
// the plating round them, as they are. This pass is the camera: it
// exposes the picture, rolls the highlights off as film and sensors do
// (a filmic curve) and lets what is too bright for a pixel bleed into
// its neighbours (bloom: the bright parts blurred at half and quarter
// size and laid back over the picture), so a window glows and a plume
// burns. The result goes to the shared canvas (gl.js) premultiplied,
// glow and all, for the view to copy in over its background.
//
// Targets only grow (the telescope's crop changes size every frame);
// each pass works in the corner it needs.
// ============================================================

import { program } from './gl.js';

export class Post {
  constructor(gl) {
    this.gl = gl;
    this.ok = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.ok) return;
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
    this.bright = program(gl, VS, BRIGHT_FS);
    this.blur = program(gl, VS, BLUR_FS);
    this.comp = program(gl, VS, COMP_FS);
    this.vao = gl.createVertexArray();
    this.cap = { w: 0, h: 0 };
  }

  /** Make sure the targets hold a w×h picture. */
  size(w, h) {
    const gl = this.gl;
    if (w <= this.cap.w && h <= this.cap.h) return;
    const W = Math.max(w, this.cap.w, 256), H = Math.max(h, this.cap.h, 256);
    this.free();
    this.cap = { w: W, h: H };
    // the multisampled scene, and its resolve
    this.ms = gl.createFramebuffer();
    this.msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA16F, W, H);
    this.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msDepth);
    this.scene = this.target(W, H);
    this.half = [this.target(Math.ceil(W / 2), Math.ceil(H / 2)), this.target(Math.ceil(W / 2), Math.ceil(H / 2))];
    this.quarter = [this.target(Math.ceil(W / 4), Math.ceil(H / 4)), this.target(Math.ceil(W / 4), Math.ceil(H / 4))];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  target(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  free() {
    const gl = this.gl;
    if (!this.ms) return;
    gl.deleteFramebuffer(this.ms); gl.deleteRenderbuffer(this.msColor); gl.deleteRenderbuffer(this.msDepth);
    for (const t of [this.scene, ...this.half, ...this.quarter]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    this.ms = null;
  }

  /** Bind the scene target for a w×h picture, cleared. */
  begin(w, h) {
    const gl = this.gl;
    this.size(w, h);
    this.w = w; this.h = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Resolve, bloom, and expose the picture into the default framebuffer's
   * lower-left w×h. o: { exposure, bloom (strength), threshold }
   */
  finish(o = {}) {
    const gl = this.gl, w = this.w, h = this.h;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ms);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scene.fb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindVertexArray(this.vao);
    const exposure = o.exposure ?? 1;
    const bloom = o.bloom ?? 1;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2), qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
    if (bloom > 0) {
      // the bright parts, at half size
      this.pass(this.bright, this.half[0], hw, hh, this.scene, { uThresh: o.threshold ?? 1.0, uExposure: exposure });
      this.pass(this.blur, this.half[1], hw, hh, this.half[0], { uDir: [1, 0], uDown: 1 });
      this.pass(this.blur, this.half[0], hw, hh, this.half[1], { uDir: [0, 1], uDown: 1 });
      // and at quarter size, wider
      this.pass(this.blur, this.quarter[0], qw, qh, this.half[0], { uDir: [2, 0], uDown: 2 });
      this.pass(this.blur, this.quarter[1], qw, qh, this.quarter[0], { uDir: [0, 2], uDown: 1 });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const u = this.comp.u;
    gl.useProgram(this.comp.p);
    this.bind(0, this.scene.tex, u.uScene);
    this.bind(1, this.half[0].tex, u.uBloomA);
    this.bind(2, this.quarter[1].tex, u.uBloomB);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform2f(u.uScale, w / this.cap.w, h / this.cap.h);
    gl.uniform2f(u.uScaleH, hw / this.half[0].w, hh / this.half[0].h);
    gl.uniform2f(u.uScaleQ, qw / this.quarter[1].w, qh / this.quarter[1].h);
    gl.uniform1f(u.uExposure, exposure);
    gl.uniform1f(u.uBloom, bloom);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  bind(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /** One pass: `src` (a target) read, `dst` written over its lower-left w×h. */
  pass(prog, dst, w, h, src, uni) {
    const gl = this.gl, u = prog.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    this.bind(0, src.tex, u.uSrc);
    gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h);
    gl.uniform2f(u.uDstTexel, 1 / dst.w, 1 / dst.h);
    gl.uniform2f(u.uDstSize, dst.w, dst.h);
    gl.uniform2f(u.uSrcSize, src.w, src.h);
    for (const [k, v] of Object.entries(uni)) {
      if (!u[k]) continue;
      if (Array.isArray(v)) gl.uniform2f(u[k], v[0], v[1]); else gl.uniform1f(u[k], v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// a pixel of the destination reads the source at the same place (both targets start at the lower left)
const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel, uSrcSize;
uniform float uThresh, uExposure;
out vec4 frag;
void main() {
  vec2 c = gl_FragCoord.xy * 2.0 * uTexel;               // the centre of the 2×2 block below
  vec3 s = vec3(0.0);
  s += texture(uSrc, c + vec2(-0.5, -0.5) * uTexel).rgb;
  s += texture(uSrc, c + vec2(0.5, -0.5) * uTexel).rgb;
  s += texture(uSrc, c + vec2(-0.5, 0.5) * uTexel).rgb;
  s += texture(uSrc, c + vec2(0.5, 0.5) * uTexel).rgb;
  s *= 0.25 * uExposure;
  float l = max(s.r, max(s.g, s.b));
  float k = max(l - uThresh, 0.0);
  k = k * k / (k + 0.5);                                 // a soft knee
  frag = vec4(s * (k / max(l, 1e-4)), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel, uDir;
uniform float uDown;
out vec4 frag;
void main() {
  // (read from a target twice the size: the same place, in its texels)
  vec2 at = gl_FragCoord.xy * uDown * uTexel;
  vec2 d = uDir * uTexel;
  vec3 s = texture(uSrc, at).rgb * 0.2270270;
  s += (texture(uSrc, at + d * 1.3846154).rgb + texture(uSrc, at - d * 1.3846154).rgb) * 0.3162162;
  s += (texture(uSrc, at + d * 3.2307692).rgb + texture(uSrc, at - d * 3.2307692).rgb) * 0.0702703;
  frag = vec4(s, 1.0);
}`;

const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene, uBloomA, uBloomB;
uniform vec2 uSize, uScale, uScaleH, uScaleQ;
uniform float uExposure, uBloom;
out vec4 frag;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 c = texture(uScene, uv * uScale);
  vec3 b = texture(uBloomA, uv * uScaleH).rgb * 0.55 + texture(uBloomB, uv * uScaleQ).rgb * 0.75;
  vec3 col = aces(c.rgb * uExposure + b * uBloom);
  col = pow(col, vec3(1.0 / 2.2));
  // premultiplied: the glow beyond a hull's edge shows over the stars too
  float a = clamp(max(c.a, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  frag = vec4(min(col, vec3(a)), a);
}`;
