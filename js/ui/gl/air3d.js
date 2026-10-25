// ============================================================
// LONGHAUL — The air of a world, for what is drawn in it
//
// One model of a world's air for everything a shuttle's cameras show in
// it (the ground: world3d.js; a spaceport's buildings, its lights and the
// pools they throw: town3d.js), so they are blued and dimmed alike by
// what lies between them and the eye: its density falling off with its
// scale height, the light it scatters toward the eye summed along each
// ray (Rayleigh's, blue out of white, and a haze's), the Sun's light
// reaching each point through the air above it, none in the world's
// shadow. AIR_GLSL is spliced into each shader; setAir sets its uniforms.
// ============================================================

/**
 * Its uniforms, the noise (hcell: a lattice hashed as integers, for noise
 * taken in metres round a world), and the light the air scatters toward
 * the eye along a ray and what gets through (airAlong, skyOf).
 */
export const AIR_GLSL = `
uniform vec3 uP0;                    // the eye (m from the scene's origin)
uniform vec3 uS, uN;                 // the ground under the eye (m from the scene's origin), and up there
uniform float uR;                    // the world's radius (m)
uniform vec4 uAir;                   // top of the air (m), its scale height (m), on, the haze's scale height (m)
uniform vec3 uRay, uHaze;            // vertical optical depth at the ground, by colour: the air's own, its haze's
uniform float uHazeG, uSkyK;         // the haze's forward throw; the sky's brightness against the Sun's
uniform vec3 uSun;
uniform float uSunI, uExposure, uTonemap, uTime;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// a lattice cell's own value, hashed as integers: the ground's noise is taken in metres round a world
// (to ten million and more), where a float hash would come apart into stripes
float hcell(vec2 i) {
  uvec2 q = uvec2(ivec2(i)) * uvec2(1664525u, 1013904223u);
  q.x += q.y * 1664525u; q.y += q.x * 1664525u;
  q ^= q >> 16u;
  q.x += q.y * 1664525u; q.y += q.x * 1664525u;
  q ^= q >> 16u;
  return float(q.x) * (1.0 / 4294967296.0);
}
float vn(vec2 p) {
  vec2 i = floor(p), f = p - i; f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hcell(i), hcell(i + vec2(1, 0)), f.x), mix(hcell(i + vec2(0, 1)), hcell(i + vec2(1, 1)), f.x), f.y);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// a ray from p (m from the ground under the eye) along d against a sphere of radius r whose surface
// passes through o·n above that point: the near and far t (both < 0 when it misses or lies behind)
vec2 shell(vec3 q, vec3 d, float r, float off) {
  vec3 qa = q - off * uN;
  float b = dot(qa, d) + r * dot(d, uN);
  float c = dot(qa, qa) + 2.0 * r * dot(qa, uN);
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  if (c < 0.0) return vec2(0.0, -b + sq);              // (inside it)
  if (b >= 0.0) return vec2(-1.0);
  return vec2(c / (-b + sq), -b + sq);
}
// how far up a point is (from the ground under the eye: p), and its up
float heightOf(vec3 p, out vec3 up) {
  float k = dot(p, p) + 2.0 * uR * dot(p, uN);
  float r = sqrt(uR * uR + k);
  up = (p + uR * uN) / r;
  return k / (r + uR);
}
// the air a ray from a point toward the Sun goes through, as airmasses (Kasten–Young), none past the world's edge
float airmass(float mu) {
  float z = degrees(acos(clamp(mu, -1.0, 1.0)));
  return 1.0 / max(mu + 0.15 * pow(max(93.885 - z, 0.05), -1.253), 0.025);
}
// along a ray from the eye (q: from the ground under it) between t0 and t1: the optical depth, and
// the light the air (Lr) and its haze (Lm) scatter toward the eye, before their phase functions
void airAlong(vec3 q, vec3 dir, float t0, float t1, out vec3 tauV, out vec3 Lr, out vec3 Lm) {
  tauV = vec3(0.0); Lr = vec3(0.0); Lm = vec3(0.0);
  const int NS = 14;
  float ds = (t1 - t0) / float(NS);
  for (int i = 0; i < NS; i++) {
    float t = t0 + (float(i) + 0.5) * ds;
    vec3 up;
    float h = heightOf(q + t * dir, up);
    float rho = exp(-max(h, 0.0) / uAir.y), rhoH = exp(-max(h, 0.0) / uAir.w);
    vec3 dTau = (uRay * rho / uAir.y + uHaze * rhoH / uAir.w) * ds;
    float mu = dot(up, uSun), r = uR + max(h, 0.0);
    float edge = -sqrt(max(0.0, 1.0 - (uR / r) * (uR / r)));
    float lit = smoothstep(edge - 0.03, edge + 0.02, mu);
    vec3 Ts = exp(-(uRay * rho + uHaze * rhoH) * min(airmass(mu), 40.0)) * lit;
    vec3 Tv = exp(-(tauV + 0.5 * dTau));
    Lr += uRay * rho / uAir.y * ds * Ts * Tv;
    Lm += uHaze * rhoH / uAir.w * ds * Ts * Tv;
    tauV += dTau;
  }
}
// what the air scattered toward the eye, in its colour (the phase functions for this ray)
vec3 skyOf(vec3 dir, vec3 Lr, vec3 Lm) {
  float cs = dot(dir, uSun), g = uHazeG;
  float phR = 0.0596831 * (1.0 + cs * cs);
  float phM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cs, 1.5);
  return uSunI * uSkyK * (Lr * phR + Lm * phM);
}
`;


/** The air's uniforms (AIR_GLSL), for the ground and whatever stands on it. */
export function setAir(gl, u, scene) {
  const w = scene.world, a = w.air;
  gl.uniform3fv(u.uP0, scene.ray.P0);
  gl.uniform3fv(u.uS, w.S); gl.uniform3fv(u.uN, w.n);
  gl.uniform1f(u.uR, w.R);
  gl.uniform4f(u.uAir, a ? a.topM : 0, a ? a.H : 1, a ? 1 : 0, a ? a.hazeH : 1);
  gl.uniform3fv(u.uRay, a ? a.ray : [0, 0, 0]);
  gl.uniform3fv(u.uHaze, a ? a.haze : [0, 0, 0]);
  gl.uniform1f(u.uHazeG, a ? a.g : 0.7);
  gl.uniform1f(u.uSkyK, a ? a.skyK : 1);
  gl.uniform3fv(u.uSun, scene.sun);
  gl.uniform1f(u.uSunI, scene.sunI ?? 3.2);
  gl.uniform1f(u.uExposure, scene.exposure ?? 1);
  gl.uniform1f(u.uTonemap, scene.$tonemap);
  gl.uniform1f(u.uTime, scene.t || 0);
}
