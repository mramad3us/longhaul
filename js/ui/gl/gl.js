// ============================================================
// LONGHAUL — The shared GPU canvas (WebGL2)
//
// The 3D pictures (hulls and stations in the drone's view and the
// telescope, people on the room cameras) are rendered on the GPU into one
// offscreen canvas, then copied onto the 2D canvases that show them,
// between their background and their overlays. One context serves every
// view: each render takes the lower left of the canvas it needs (the
// canvas only grows), draws, and the caller copies that rectangle out at
// once, before the next render reuses it. Nothing is loaded: geometry and
// surfaces are made in code.
//
// Without WebGL2 (or once the context is lost) `sharedGL()` answers null
// and the views draw their 2D pictures as before.
// ============================================================

let shared;                       // undefined: not tried · null: unavailable · { gl, canvas, w, h }
const MAX_SIDE = 4096;

/** The shared context, made on first use; null where there is none. */
export function sharedGL() {
  if (shared !== undefined) return shared;
  shared = null;
  if (typeof document === 'undefined') return shared;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, depth: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return shared;
    gl.getExtension('EXT_color_buffer_float');
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); shared = null; lost.forEach(f => f()); });
    shared = { gl, canvas, w: 16, h: 16, gen: 1 };
  } catch {
    shared = null;
  }
  return shared;
}

const lost = new Set();
/** Called when the context goes (caches of GPU objects must be dropped). */
export function onContextLost(f) { lost.add(f); }

/**
 * Make room for a w×h render (device pixels) and set the viewport to it, at
 * the canvas's lower left. Returns the source rectangle to copy it out from
 * (canvas pixel coordinates, top-left origin), or null when it can't be had.
 */
export function beginRender(ctx, w, h) {
  const { gl, canvas } = ctx;
  w = Math.max(1, Math.min(MAX_SIDE, Math.ceil(w)));
  h = Math.max(1, Math.min(MAX_SIDE, Math.ceil(h)));
  if (canvas.width < w || canvas.height < h) {
    canvas.width = ctx.w = Math.min(MAX_SIDE, Math.max(canvas.width, w, 256));
    canvas.height = ctx.h = Math.min(MAX_SIDE, Math.max(canvas.height, h, 256));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  return { sx: 0, sy: canvas.height - h, w, h };
}

// ---- PROGRAMS ----

/** Compile and link a program; attributes bound by name in order. Throws with the log on failure. */
export function program(gl, vs, fs, attribs = []) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error(`shader: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  const u = {};
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/**
 * A vertex array from interleaved float data: layout [[name, size], ...]
 * in attribute-location order, and optional 32-bit indices.
 */
export function vertexArray(gl, data, layout, indices = null) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = layout.reduce((s, [, n]) => s + n, 0) * 4;
  let off = 0;
  layout.forEach(([, n], i) => {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride, off);
    off += n * 4;
  });
  let ib = null, count = data.length / (stride / 4);
  if (indices) {
    ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    count = indices.length;
  }
  gl.bindVertexArray(null);
  return { vao, vb, ib, count, indexed: !!indices };
}

export function drawArray(gl, va, mode) {
  gl.bindVertexArray(va.vao);
  if (va.indexed) gl.drawElements(mode ?? gl.TRIANGLES, va.count, gl.UNSIGNED_INT, 0);
  else gl.drawArrays(mode ?? gl.TRIANGLES, 0, va.count);
  gl.bindVertexArray(null);
}

export function deleteArray(gl, va) {
  if (!va) return;
  gl.deleteVertexArray(va.vao);
  gl.deleteBuffer(va.vb);
  if (va.ib) gl.deleteBuffer(va.ib);
}

// ---- MATRICES (column-major, as GL takes them) ----

export const mat4 = {
  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b, out = new Float32Array(16)) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  },
  /** Columns: the images of the basis vectors, and a translation. */
  basis(ax, ay, az, t = [0, 0, 0]) {
    return new Float32Array([ax[0], ax[1], ax[2], 0, ay[0], ay[1], ay[2], 0, az[0], az[1], az[2], 0, t[0], t[1], t[2], 1]);
  },
  /** An orthographic projection of the box [l, r] × [b, t] × [n, f] (looking down −z). */
  ortho(l, r, b, t, n, f) {
    return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
  },
  /** A perspective projection: a vertical field `fovy` (rad), `aspect` w/h, the depth from `n` to `f` (looking down −z). */
  perspective(fovy, aspect, n, f) {
    const k = 1 / Math.tan(fovy / 2);
    return new Float32Array([k / aspect, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  },
  /** A view matrix: eye, looking along `fwd`, with `up` (orthonormalised). */
  lookDir(eye, fwd, up) {
    const f = norm(fwd), s = norm(cross(f, up)), u = cross(s, f);
    return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
  },
  /** Normal matrix (upper 3×3 of a rigid transform's rotation). */
  normal3(m) { return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]); },
};

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Hex colour → linear RGB (the shaders light in linear space). */
export function linear(hex) {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return v.map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}
