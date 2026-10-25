// ============================================================
// LONGHAUL — A world seen from close: its ground, its air, its pad
//
// What a shuttle's cameras see of the world under them (shuttlecam.js),
// drawn on the GPU in the same pass as the hulls (ships3d.js renderScene,
// scene.world), so a hull in front of it hides it and its limb hides what
// is behind:
//
//   THE GROUND   a sphere at the world's radius, ray-cast through the lens
//                from the point under the eye (the numbers stay small
//                close to the ground: a 6,400 km sphere resolves a pad from
//                fifty metres in 32-bit floats). Its colours are the
//                telescope's own map of the world (scope-sky.js
//                surfaceMap), turned with it (worlds.js worldAngle, as its
//                airspaces are), with detail at every scale the picture
//                shows; lit by the Sun through the air, the sea glinting;
//                on the night side its cities (Earth's map has them) and
//                the lights round every spaceport.
//   THE AIR      a shell to the top of the air (its entry interface,
//                worlds.js), its density falling off with its scale height;
//                along each ray the light it scatters toward the eye is
//                summed (Rayleigh's, blue out of white, and a haze's: dust,
//                smog, Titan's orange), the Sun's light reaching each point
//                through the air above it, none in the world's shadow. From
//                orbit it is the limb's glow and the day side's haze; from
//                inside it the sky, bright enough to hide the stars, and the
//                distance blued.
//   ITS CLOUDS   (Earth's: the telescope's map has them painted on) a layer
//                of their own some kilometres up, lit from above, so a
//                shuttle comes down through them and the sea shows under
//                them; the ground under a cloud on the map is taken as sea.
//   THE PAD      the spaceport a run lands at: an apron of slabs, the pad
//                ringed and marked, its rim lights blinking, floodlit by
//                night.
// ============================================================

import { program } from './gl.js';

const VS = `#version 300 es
out vec2 vClip;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vClip = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const MAX_PORTS = 12;

const FS = `#version 300 es
precision highp float;
in vec2 vClip;
uniform vec3 uP0, uAx, uAy, uW;      // the lens' rays (ships3d.js perspectiveCamera: W toward the eye)
uniform mat4 uVP;
uniform float uFocal;                // device px per unit of tangent
uniform vec3 uS, uN;                 // the ground under the eye (m from the scene's origin), and up there
uniform float uR;                    // the world's radius (m)
uniform vec3 uEx, uEy;               // the world's own axes now (its turn), in the plane
uniform sampler2D uMap, uLights, uCloud;
uniform float uHasLights, uHasClouds, uCloudH;
uniform vec4 uAir;                   // top of the air (m), its scale height (m), on, the haze's scale height (m)
uniform vec3 uRay, uHaze;            // vertical optical depth at the ground, by colour: the air's own, its haze's
uniform float uHazeG, uSkyK;         // the haze's forward throw; the sky's brightness against the Sun's
uniform vec3 uSun;
uniform float uSunI, uExposure, uTonemap, uTime;
uniform vec3 uPadP;                  // the pad (m from the origin)
uniform vec4 uPad;                   // its up, its radius (m; 0: none)
uniform vec3 uPorts[${MAX_PORTS}];   // spaceports, as directions from the world's centre (lights by night)
uniform int uPortN;
uniform vec4 uTer;                   // its ground's make: craters, ridged hills, how high its relief stands, dunes (0–1 each)
out vec4 frag;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float gPx;
// how much of a feature this size (m) the picture can show here (none under a few pixels)
float lod(float size) { return smoothstep(1.5, 5.0, size * gPx); }
float fbm(vec2 p, float size) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (vn(p) - 0.5) * lod(size); p = p * 2.03 + 17.1; a *= 0.5; size *= 0.5; }
  return s;
}
// craters in a grid of cells (the rock shader's, ships3d.js): a bowl, its raised rim, its ejecta. x: m
vec2 craters(vec2 x, float cell, float chance) {
  vec2 c = floor(x / cell);
  float hs = 0.0, am = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = c + vec2(float(i), float(j));
    if (h21(id + 0.37) > chance) continue;
    vec2 ctr = (id + vec2(h21(id + 3.1), h21(id + 7.7))) * cell;
    float rad = cell * (0.12 + 0.3 * h21(id + 11.3));
    float d = length(x - ctr) / rad;
    hs += ((d < 1.0 ? (d * d - 1.0) * 0.22 : 0.0) + exp(-pow((d - 1.0) / 0.22, 2.0)) * 0.07 + (d > 1.0 ? 0.03 * exp(-(d - 1.0) * 2.5) : 0.0)) * rad;
    am += (d < 0.85 ? -0.18 : 0.0) + exp(-pow((d - 1.0) / 0.25, 2.0)) * 0.22 + (d > 1.0 ? 0.12 * exp(-(d - 1.0) * 1.6) : 0.0);
  }
  return vec2(hs, am);
}
// ridged hills: sharp crests where the noise folds
float ridged(vec2 p, float size) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * (1.0 - abs(2.0 * vn(p) - 1.0) - 0.5) * lod(size); p = p * 2.07 + 31.7; a *= 0.5; size *= 0.5; }
  return s;
}
// the ground's relief (m): hills to pebbles, each scale only where the picture shows it, in the world's own make
float relief(vec2 x) {
  float k = uTer.z;
  float h = (fbm(x / 7000.0, 7000.0) * 700.0 + fbm(x / 800.0, 800.0) * 80.0 + fbm(x / 90.0, 90.0) * 7.0 + fbm(x / 9.0, 9.0) * 0.6) * k;
  h += uTer.y * ridged(x / 12000.0, 12000.0) * 1800.0 * k;
  if (uTer.x > 0.0) h += (craters(x, 9000.0, 0.45 * uTer.x).x * lod(2500.0) + craters(x, 1500.0, 0.5 * uTer.x).x * lod(400.0) + craters(x, 220.0, 0.5 * uTer.x).x * lod(60.0)) * 1.0;
  if (uTer.w > 0.0) h += uTer.w * sin(dot(x, vec2(0.0062, 0.0021)) + 3.0 * vn(x / 2500.0)) * 14.0 * lod(400.0);
  return h;
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

void main() {
  vec3 dir = normalize(-(uW + vClip.x * uAx + vClip.y * uAy));   // from the eye into the scene
  vec3 q = uP0 - uS;                                               // the eye, from the ground under it
  bool air = uAir.z > 0.5;
  // the ground
  float b = dot(q, dir) + uR * dot(dir, uN);
  float c = dot(q, q) + 2.0 * uR * dot(q, uN);
  float disc = b * b - c;
  float tG = (disc >= 0.0 && c > 0.0 && b < 0.0) ? c / (-b + sqrt(disc)) : -1.0;
  // (an airless limb, smoothed over a pixel: the ray's nearest pass outside it)
  float cov = 1.0;
  if (tG < 0.0 && !air && b < 0.0) {
    float tc = -b, edge = -disc / (2.0 * uR);
    gPx = uFocal / max(tc, 1.0);
    cov = clamp(0.5 - edge * gPx, 0.0, 1.0);
    if (cov > 0.0) tG = tc;
  }
  vec2 ta = air ? shell(q, dir, uR + uAir.x, uAir.x) : vec2(-1.0);
  if (tG < 0.0 && ta.y <= 0.0) discard;
  // the cloud deck: where this ray meets it, if before the ground (from under it, going up; from over it, coming down)
  float tC = -1.0;
  if (uHasClouds > 0.5) {
    vec2 tc = shell(q, dir, uR + uCloudH, uCloudH);
    float cand = tc.x > 0.0 ? tc.x : tc.y;
    if (cand > 0.0 && (tG < 0.0 || cand < tG)) tC = cand;
  }

  // ---- the light the air scatters toward the eye, and how much of what is behind it gets through
  vec3 tauV = vec3(0.0), Lr = vec3(0.0), Lm = vec3(0.0);
  if (air && ta.y > 0.0) {
    float t0 = max(ta.x, 0.0), t1 = tG > 0.0 ? min(ta.y, tG) : ta.y;
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
  float cs = dot(dir, uSun), g = uHazeG;
  float phR = 0.0596831 * (1.0 + cs * cs);
  float phM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cs, 1.5);
  vec3 sky = uSunI * uSkyK * (Lr * phR + Lm * phM);
  vec3 Tview = exp(-tauV);

  // the cloud there: its cover off the map, broken up; lit from above, through the air over it
  vec4 cloud = vec4(0.0);
  if (tC > 0.0) {
    vec3 pc = q + tC * dir, nc;
    heightOf(pc, nc);
    gPx = uFocal / max(tC, 0.5);
    float lonc = atan(dot(nc, uEy), dot(nc, uEx)), latc = asin(clamp(nc.z, -1.0, 1.0));
    vec2 uvc = vec2(fract(lonc / 6.2831853 + 1.0), 0.5 - latc / 3.14159265);
    vec2 xc = vec2(lonc * uR * cos(latc), latc * uR);
    float cover = texture(uCloud, uvc).r;
    float dens = cover * (0.55 + 0.9 * (fbm(xc / 5000.0, 5000.0) + 0.5)) + 0.35 * fbm(xc / 600.0, 600.0) * cover;
    float a = smoothstep(0.32, 0.72, dens);
    float muc = dot(nc, uSun);
    vec3 sunC = exp(-(uRay + uHaze) * 0.35 * airmass(muc));
    float lightC = uSunI * 0.62 * max(muc, 0.0) * (0.75 + 0.25 * smoothstep(0.3, 0.9, dens)) + 0.05;
    cloud = vec4(vec3(0.92, 0.93, 0.95) * lightC * sunC, a);
  }
  vec3 col;
  float alpha;
  if (tG > 0.0) {
    vec3 p = q + tG * dir;
    vec3 ng;
    heightOf(p, ng);
    gPx = uFocal / max(tG, 0.5);
    // the map, in the world's own turn
    float lon = atan(dot(ng, uEy), dot(ng, uEx));
    float lat = asin(clamp(ng.z, -1.0, 1.0));
    vec2 uv = vec2(fract(lon / 6.2831853 + 1.0), 0.5 - lat / 3.14159265);
    vec3 alb = pow(texture(uMap, uv).rgb, vec3(2.2));
    float sea = smoothstep(0.02, 0.09, alb.b - alb.r) * smoothstep(0.25, 0.1, alb.r + alb.g);
    // detail at every scale the picture shows (the map is forty kilometres a texel): the ground's
    // colour broken up, and its relief, lit through its own slopes (the sea flat)
    vec2 xm = vec2(lon * uR * cos(lat), lat * uR);
    float det = 1.0 + (0.9 * fbm(xm / 6000.0, 6000.0) + 0.6 * fbm(xm / 600.0, 600.0) + 0.4 * fbm(xm / 60.0, 60.0) + 0.25 * fbm(xm / 6.0, 6.0)) * (1.0 - 0.85 * sea);
    // (its rocks: dark and pale ground in patches; the craters' floors darker, their rims and rays brighter)
    float rocks = smoothstep(-0.12, 0.12, fbm(xm / 14000.0 + 9.0 * vn(xm / 40000.0), 14000.0));
    det *= mix(1.0, mix(0.62, 1.22, rocks), 0.55 * (1.0 - sea));
    if (uTer.x > 0.0) det *= 1.0 + (craters(xm, 9000.0, 0.45 * uTer.x).y * lod(2500.0) + craters(xm, 1500.0, 0.5 * uTer.x).y * lod(400.0)) * (1.0 - sea);
    alb *= clamp(det, 0.3, 1.9);
    vec3 te = normalize(cross(vec3(0.0, 0.0, 1.0), ng)), tn = cross(ng, te);
    vec3 N = ng;
    if (sea < 0.5) {
      float e = max(0.6, 1.2 / gPx);
      float h0 = relief(xm), hx = relief(xm + vec2(e, 0.0)), hy = relief(xm + vec2(0.0, e));
      N = normalize(ng - te * (hx - h0) / e - tn * (hy - h0) / e);
    }
    // the pad and its apron
    vec3 hw = uS + p;
    vec3 lightsAdd = vec3(0.0);
    if (uPad.w > 0.0) {
      vec3 pu = uPad.xyz, e1 = normalize(cross(pu, vec3(0.0, 0.0, 1.0))), e2 = cross(pu, e1);
      vec3 dv = hw - uPadP;
      vec2 lp = vec2(dot(dv, e1), dot(dv, e2));
      float d = length(lp), R = uPad.w;
      if (d < R * 4.0) {
        float slab = step(0.06, fract(lp.x / 9.0)) * step(0.06, fract(lp.y / 9.0));
        vec3 apron = vec3(0.11, 0.108, 0.104) * (0.88 + 0.12 * slab) * (0.92 + 0.16 * vn(lp / 3.0));
        alb = mix(alb, apron, smoothstep(R * 4.0, R * 3.6, d));
        if (d < R) {
          alb = vec3(0.17, 0.166, 0.16) * (0.92 + 0.08 * slab) * (0.94 + 0.12 * vn(lp / 1.5));
          float ring = smoothstep(0.03, 0.0, abs(d / R - 0.84) - 0.02);
          float cross_ = (abs(lp.x) < R * 0.02 || abs(lp.y) < R * 0.02) && d < R * 0.42 && d > R * 0.08 ? 1.0 : 0.0;
          alb = mix(alb, vec3(0.42, 0.34, 0.1), ring * 0.8);
          alb = mix(alb, vec3(0.3, 0.3, 0.29), cross_ * 0.7);
        }
        // its rim lights, blinking; its floodlights
        float ang = atan(lp.y, lp.x), k = floor(ang / 6.2831853 * 16.0 + 0.5);
        vec2 lc = vec2(cos(k / 16.0 * 6.2831853), sin(k / 16.0 * 6.2831853)) * R * 1.02;
        float blink = 0.6 + 0.4 * step(0.5, fract(uTime * 0.8 + k * 0.0625));
        lightsAdd += vec3(1.0, 0.8, 0.5) * 6.0 * blink * exp(-dot(lp - lc, lp - lc) / 0.6);
        lightsAdd += vec3(0.9, 0.92, 1.0) * 0.05 * smoothstep(R * 1.6, R * 0.6, d) * (1.0 - smoothstep(-0.05, 0.1, dot(uPad.xyz, uSun)));
      }
    }
    // lit by the Sun through the air above it (on its slopes), and the sky's own light
    float mu0 = dot(ng, uSun);
    vec3 sunT = air ? exp(-(uRay + uHaze) * airmass(mu0)) : vec3(1.0);
    vec3 skyAmb = air ? (uRay * 0.35 + uHaze * 0.25) * clamp(mu0 * 2.0 + 0.4, 0.0, 1.0) * uSunI * 0.25 : vec3(0.004);
    float self = smoothstep(-0.04, 0.1, mu0);
    col = alb * (uSunI * 0.7 * max(dot(N, uSun), 0.0) * self * sunT + skyAmb * (0.6 + 0.4 * N.z * 0.0 + 0.4 * dot(N, ng)));
    // the sea's glint
    vec3 hv = normalize(uSun - dir);
    col += sea * sunT * uSunI * 0.6 * pow(max(dot(ng, hv), 0.0), 180.0) * step(0.0, mu0);
    // night: the cities, and the lights round the spaceports
    float night = 1.0 - smoothstep(-0.12, 0.05, mu0);
    if (night > 0.0) {
      float city = uHasLights > 0.5 ? texture(uLights, uv).r : 0.0;
      // (a spaceport's town round it, thinning out a few kilometres off: lit blocks, not a glow)
      for (int i = 0; i < ${MAX_PORTS}; i++) {
        if (i >= uPortN) break;
        float dk = length(ng - uPorts[i]) * uR / 1000.0;       // km from the port
        city += exp(-dk * dk / 30.0) * 0.9 + exp(-dk * dk / 160.0) * 0.25;
      }
      // (close to, single lamps on dark ground; farther, lit blocks; farther still, their average)
      float blocks = smoothstep(0.55, 0.75, vn(xm / 260.0)) * (0.4 + 0.8 * vn(xm / 31.0));
      float lamps = smoothstep(0.84, 0.93, vn(xm / 14.0)) * 3.0;
      float lit = mix(mix(0.12, blocks, lod(260.0)), blocks * lamps, lod(14.0));
      lightsAdd += vec3(1.0, 0.74, 0.44) * 0.22 * city * lit * night;
    }
    col += lightsAdd;
    col = mix(col, cloud.rgb, cloud.a);
    col = col * Tview + sky;
    alpha = cov;
    vec4 cp = uVP * vec4(hw, 1.0);
    gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
  } else {
    // the sky: what is behind it (the stars, a far world) shows through as much as gets through
    col = cloud.rgb * cloud.a * Tview + sky;
    alpha = clamp(max(1.0 - dot(Tview, vec3(0.333)), cloud.a), 0.0, 1.0);
    gl_FragDepth = 1.0;
  }
  if (uTonemap > 0.5) col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  frag = vec4(col * cov, alpha);
}`;

let P = null;
const textures = new Map();      // world name → { map, lights }

function setup(gl) {
  if (P && P.gl === gl) return P;
  P = { gl, prog: program(gl, VS, FS), black: null };
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  P.black = t;
  textures.clear();
  return P;
}

function texOf(gl, key, surf) {
  let tx = textures.get(key);
  if (tx) return tx;
  const mk = (data, fmt, ifmt) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, surf.w, surf.h, 0, fmt, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return t;
  };
  // (a map with its clouds painted on gives them up: the cover a layer of its own, the ground under it sea)
  let rgb = surf.rgb, cover = null;
  if (surf.clouds) {
    const n = surf.w * surf.h, sea = surf.sea || [32, 64, 128];
    rgb = new Uint8Array(surf.rgb);
    cover = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2], lo = Math.min(r, g, b);
      const k = Math.max(0, Math.min(1, (lo - 120) / 90));
      cover[i] = Math.round(k * 255);
      if (k > 0) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c] * (1 - k) + sea[c] * k);
    }
  }
  tx = { map: mk(rgb, gl.RGB, gl.RGB8), lights: surf.lights ? mk(surf.lights, gl.RED, gl.R8) : null, cloud: cover ? mk(cover, gl.RED, gl.R8) : null };
  textures.set(key, tx);
  return tx;
}

/**
 * Draw scene.world in the current pass (depth written where the ground is,
 * far for the sky). w: { name, surf ({ rgb, lights, w, h }), S, n, R, ex,
 * ey, air: { topM, H, hazeH, ray [3], haze [3], g, skyK } | null, pad:
 * { p, up, r } | null, ports: [[x, y, z]] }.
 */
export function drawWorld(gl, scene, empty) {
  const w = scene.world, ray = scene.ray;
  if (!w || !ray) return;
  const p = setup(gl), u = p.prog.u;
  gl.useProgram(p.prog.p);
  gl.depthFunc(gl.ALWAYS);
  gl.uniform3fv(u.uP0, ray.P0); gl.uniform3fv(u.uAx, ray.Ax); gl.uniform3fv(u.uAy, ray.Ay); gl.uniform3fv(u.uW, ray.W);
  gl.uniformMatrix4fv(u.uVP, false, ray.VP);
  gl.uniform1f(u.uFocal, scene.focalPx || 1);
  gl.uniform3fv(u.uS, w.S); gl.uniform3fv(u.uN, w.n);
  gl.uniform1f(u.uR, w.R);
  gl.uniform3fv(u.uEx, w.ex); gl.uniform3fv(u.uEy, w.ey);
  const tx = texOf(gl, w.name, w.surf);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tx.map); gl.uniform1i(u.uMap, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tx.lights || p.black); gl.uniform1i(u.uLights, 2);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tx.cloud || p.black); gl.uniform1i(u.uCloud, 3);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1f(u.uHasLights, tx.lights ? 1 : 0);
  gl.uniform1f(u.uHasClouds, tx.cloud ? 1 : 0);
  gl.uniform1f(u.uCloudH, w.cloudH || 6000);
  const a = w.air;
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
  gl.uniform3fv(u.uPadP, w.pad ? w.pad.p : [0, 0, 0]);
  gl.uniform4f(u.uPad, ...(w.pad ? [...w.pad.up, w.pad.r] : [0, 0, 1, 0]));
  const ports = new Float32Array(MAX_PORTS * 3);
  const pn = Math.min(MAX_PORTS, w.ports?.length || 0);
  for (let i = 0; i < pn; i++) ports.set(w.ports[i], i * 3);
  gl.uniform3fv(u.uPorts, ports);
  gl.uniform1i(u.uPortN, pn);
  gl.uniform4fv(u.uTer, w.ter || [0.8, 0.3, 1, 0]);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(empty);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
  gl.depthFunc(gl.LEQUAL);
}
