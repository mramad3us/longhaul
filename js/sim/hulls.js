// ============================================================
// LONGHAUL — Hull models: what a ship physically is
//
// Every class has a hull: a set of parts in metres, built the way real
// spacecraft are built. Nothing here is streamlined. Pressure hulls are
// boxes and short cylinders stacked along the thrust axis (a torch ship
// is a tower: its decks are floors when the drive is lit), tanks are
// cylinders, radiators are flat panels edge-on to the drive, and the
// drive bell is at the stern. A ship rated for atmospheric entry is
// still a box: a flat-bottomed lifting body with a ceramic belly, or a
// tail-sitter with a shield ring round its drive, on legs.
//
// Ship frame: x along the thrust axis (bow +x, stern −x, the origin at
// mid-length), y to starboard, z dorsal. Parts:
//   box   { x0, x1, y0, y1, z0, z1 }        pressure hulls, holds, armor
//   cyl   { x0, x1, r, y, z }               tanks along the axis
//   bell  { x0, x1, r0, r1 }                the drive (x1 the throat, x0 the exit)
//   ring  { x, r, w, d, n }                 a spin ring of n box segments
// Every part has a role (hab, command, cargo, tank, radiator, drive,
// armor, pdc, tube, rail, sensor, shield, leg, gear, truss, ice, …) that
// the renderer colours and the library describes.
//
// Ports are where a ship can mate with another hull or a station: a
// collar on the hull surface with a size (S crew hatch, M docking
// collar, L cargo cradle), a normal (the face it is on: x+ the nose,
// y± the flanks, z± dorsal and ventral), and what it is for. Collars
// of one size are androgynous: any two S, M or L collars mate; station
// berths carry adaptors and list what they accept (stations.js). On our
// own ship each port opens onto a deck of the interior, where the
// airlock is (ship-layout.js): the interior and the hull are built from
// the same deck program, so the airlock on the deck plan is where the
// collar is on the hull.
//
// Hulls are built once per class and cached; they are plain data the
// UI draws (exterior.js) and the docking model flies to (docking.js).
// ============================================================

import { CLASSES } from './ship-classes.js';
import { deckSpans, DECK_PROGRAMS } from './ship-layout.js';

/** Docking collar sizes and the soft-capture envelope of each (docking.js). */
export const COLLARS = {
  S: { label: 'S crew hatch', diaM: 1.0, captureMS: 0.3, missM: 0.15, angleDeg: 4, rollDeg: 6 },
  M: { label: 'M docking collar', diaM: 2.2, captureMS: 0.25, missM: 0.3, angleDeg: 3, rollDeg: 5 },
  L: { label: 'L cargo cradle', diaM: 6, captureMS: 0.15, missM: 0.5, angleDeg: 2, rollDeg: 4 },
};

/** Unit vectors of the faces a port can sit on. */
export const FACES = {
  'x+': [1, 0, 0], 'x-': [-1, 0, 0], 'y+': [0, 1, 0], 'y-': [0, -1, 0], 'z+': [0, 0, 1], 'z-': [0, 0, -1],
};

/**
 * RCS authority by size: translation (m/s², per axis) and the rotation rate
 * the attitude thrusters hold a big hull to (deg/s). Better yards fit more
 * thrust for the mass.
 */
const RCS_ACCEL = { S: 0.25, M: 0.12, L: 0.05, XL: 0.02 };
const RCS_ROT_DEG = { S: 3, M: 2, L: 1, XL: 0.5 };
const RCS_TL = { 1: 0.8, 2: 1, 3: 1.1, 4: 1.2 };

/** Beam and height as fractions of length, by kind (box hulls are rarely square). */
const PROPORTIONS = {
  prospector: [0.36, 0.3], courier: [0.18, 0.16], shuttle: [0.42, 0.24], 'light-freighter': [0.26, 0.22],
  freighter: [0.17, 0.17], hauler: [0.12, 0.12], tanker: [0.12, 0.11], liner: [0.16, 0.15], miner: [0.3, 0.2],
  cutter: [0.24, 0.2], corvette: [0.22, 0.18], frigate: [0.16, 0.14], destroyer: [0.14, 0.12], battleship: [0.15, 0.13],
  gunship: [0.24, 0.2], raider: [0.17, 0.15],
};

// ---- BUILDER ----

class HullBuilder {
  constructor(c) {
    const [wf, hf] = c.dims || PROPORTIONS[c.kind] || [0.2, 0.18];
    this.c = c;
    this.L = c.lengthM;
    this.W = Math.max(4, c.lengthM * wf);
    this.H = Math.max(3.5, c.lengthM * hf);
    this.parts = [];
    this.ports = [];
    this.hatches = [];
  }

  /** Bow fraction (0 at the bow, 1 at the stern) → x in metres. */
  X(f) { return this.L / 2 - f * this.L; }

  /** A box between bow fractions f0 < f1, width w and height h (m), centred on (y, z). */
  box(f0, f1, w, h, role, o = {}) {
    const y = o.y || 0, z = o.z || 0;
    const p = { k: 'box', x0: this.X(f1), x1: this.X(f0), y0: y - w / 2, y1: y + w / 2, z0: z - h / 2, z1: z + h / 2, role };
    if (o.tag) p.tag = o.tag;
    if (o.deck) p.deck = o.deck;
    this.parts.push(p);
    return p;
  }

  cyl(f0, f1, r, role, o = {}) {
    const p = { k: 'cyl', x0: this.X(f1), x1: this.X(f0), r, y: o.y || 0, z: o.z || 0, role };
    this.parts.push(p);
    return p;
  }

  /** The drive bell: throat at f0, exit at f1 (the stern). */
  bell(f0, f1, r0, r1) {
    const p = { k: 'bell', x0: this.X(f1), x1: this.X(f0), r0: r1, r1: r0, role: 'drive' };
    this.parts.push(p);
    return p;
  }

  /** Radiator panels to port and starboard: thin, broad, edge-on to the plume. */
  radiators(f0, f1, span, o = {}) {
    const t = Math.max(0.3, this.W * 0.02);
    const root = o.root ?? this.W / 2;
    for (const s of [-1, 1]) this.box(f0, f1, span, t, 'radiator', { y: s * (root + span / 2), z: o.z || 0 });
    if (o.vertical) for (const s of [-1, 1]) this.box(f0, f1, t, span, 'radiator', { z: s * (this.H / 2 + span / 2) });
  }

  /** A spin ring of n flat box segments round the axis at f (radius r to the deck, width w, depth d). */
  ring(f, r, w, d, n = 12) {
    this.parts.push({ k: 'ring', x: this.X(f), r, w, d, n, role: 'hab' });
  }

  /** Landing legs (or skids) at the stern, four of them. */
  legs(f, len, spread) {
    for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      this.box(f, Math.min(1.04, f + len / this.L), 0.6, 0.6, 'leg', { y: sy * spread, z: sz * spread * 0.7 });
    }
  }

  /** Point-defense turrets spread along both flanks between f0 and f1. */
  pdcs(n, f0, f1, o = {}) {
    const s = Math.max(1.2, Math.min(4, this.W * 0.09));
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const k = Math.floor(i / 2), m = Math.ceil(n / 2);
      const f = f0 + (f1 - f0) * (m > 1 ? k / (m - 1) : 0.5);
      const top = i % 4 >= 2 ? 1 : -1;
      const yEdge = this.extentAt(f, 'y') * side;
      this.box(f, f + s / this.L, s, s, 'pdc', { y: yEdge + side * s * 0.3, z: top * (o.z ?? this.H * 0.2) });
    }
  }

  /** How far the pressure hull reaches on an axis at bow fraction f (m from the centreline). */
  extentAt(f, axis) {
    const x = this.X(f);
    let best = 0;
    for (const p of this.parts) {
      if (p.k !== 'box' || !SOLID.has(p.role)) continue;
      if (x < p.x0 - 1e-6 || x > p.x1 + 1e-6) continue;
      best = Math.max(best, axis === 'y' ? Math.max(-p.y0, p.y1) : Math.max(-p.z0, p.z1));
    }
    return best || (axis === 'y' ? this.W / 2 : this.H / 2);
  }

  /**
   * A collar on the hull surface at bow fraction f, on `face`.
   * The nose port sits on the bow; flank ports on the outer skin there.
   */
  port(id, f, face, size, use, o = {}) {
    const n = FACES[face];
    let x = this.X(f), y = 0, z = 0;
    if (face === 'x+') x = this.bow();
    else if (face === 'x-') x = -this.L / 2;
    else if (face[0] === 'y') { y = n[1] * this.extentAt(f, 'y'); z = o.z || 0; }
    else { z = n[2] * this.extentAt(f, 'z'); y = o.y || 0; }
    const p = { id, label: o.label || PORT_LABEL[use] || 'Collar', x, y, z, face, size, use, deck: o.deck || null };
    this.ports.push(p);
    return p;
  }

  /** A hatch that isn't a docking collar (a cargo door, a ramp, an EVA hatch). */
  hatch(id, f, face, kind, o = {}) {
    const n = FACES[face];
    const p = { id, kind, x: this.X(f), y: face[0] === 'y' ? n[1] * this.extentAt(f, 'y') : 0, z: face[0] === 'z' ? n[2] * this.extentAt(f, 'z') : 0, face, deck: o.deck || null };
    this.hatches.push(p);
    return p;
  }

  bow() {
    let x = -Infinity;
    for (const p of this.parts) if (p.k === 'box' && SOLID.has(p.role)) x = Math.max(x, p.x1);
    return x === -Infinity ? this.L / 2 : x;
  }
}

/** Roles that are pressure hull or structure (ports sit on these). */
const SOLID = new Set(['hab', 'command', 'cargo', 'armor', 'machinery', 'reactor', 'hold', 'container', 'ice', 'tank-block']);

const PORT_LABEL = { crew: 'Crew collar', cargo: 'Cargo cradle', fuel: 'Fuel manifold', both: 'Docking collar' };

// ---- ARCHETYPES ----
// Each builds the parts and ports of one kind of hull from the class. The
// classes a small crew can fly are built from their deck program instead
// (tower(), below), so their interiors and exteriors agree.

const ARCH = {
  prospector(b, c) {
    const { W, H } = b;
    b.box(0, 0.22, W * 0.62, H * 0.7, 'command');
    b.box(0.03, 0.2, W * 0.08, H * 0.25, 'sensor', { z: H * 0.47 });
    b.box(0.22, 0.56, W, H, 'hab');
    b.box(0.56, 0.8, W * 0.78, H * 0.8, 'machinery');
    b.radiators(0.58, 0.8, W * 0.5);
    b.box(0.8, 0.88, W * 0.5, H * 0.5, 'drive');
    b.bell(0.88, 1, W * 0.12, W * 0.26);
    if (c.gear) b.box(0.24, 0.5, W * 0.14, H * 0.22, 'gear', { y: W * 0.57 });
    b.legs(0.86, 3, W * 0.42);
    b.port('crew', 0.12, 'y-', 'S', 'crew');
    b.hatch('hold', 0.4, 'z-', 'cargo door');
  },

  courier(b, c) {
    const { W, H } = b;
    b.box(0, 0.16, W * 0.82, H * 0.8, 'command');
    b.box(0.16, 0.36, W, H, 'hab');
    b.cyl(0.38, 0.74, W * 0.24, 'tank', { y: -W * 0.27 });
    b.cyl(0.38, 0.74, W * 0.24, 'tank', { y: W * 0.27 });
    b.box(0.36, 0.76, W * 0.14, H * 0.14, 'truss');
    b.box(0.74, 0.88, W * 0.8, H * 0.8, 'machinery');
    b.radiators(0.76, 0.88, W * 0.6);
    b.bell(0.88, 1, W * 0.14, W * 0.3);
    b.port('nose', 0, 'x+', 'S', 'crew');
    b.port('crew', 0.26, 'y-', 'S', 'crew');
    if (c.tubes) b.box(0.2, 0.5, W * 0.18, H * 0.18, 'tube', { z: -H * 0.55 });
    if (c.pdc) b.pdcs(c.pdc, 0.3, 0.6);
  },

  shuttle(b, c) {
    const { W, H } = b;
    b.box(0, 0.18, W * 0.56, H * 0.74, 'command');
    b.box(0.18, 0.78, W, H, 'cargo');
    b.box(0.78, 0.9, W * 0.7, H * 0.8, 'machinery');
    b.bell(0.9, 1, W * 0.08, W * 0.18);
    if (!c.atmo) { b.radiators(0.8, 0.9, W * 0.35); b.cyl(0.25, 0.7, H * 0.3, 'tank', { z: H * 0.7 }); }
    b.port('crew', 0.12, 'y-', 'M', 'crew');
    b.port('cargo', 0.5, 'y+', 'L', 'cargo');
    b.hatch('ramp', 0.7, 'z-', 'cargo ramp');
  },

  'light-freighter'(b, c) {
    const { W, H } = b;
    b.box(0, 0.12, W * 0.7, H * 0.7, 'command');
    b.box(0.12, 0.45, W * 0.86, H * 0.86, 'hab');
    b.box(0.45, 0.66, W, H, 'cargo');
    b.box(0.66, 0.88, W * 0.8, H * 0.8, 'machinery');
    b.radiators(0.68, 0.88, W * 0.55);
    b.bell(0.88, 1, W * 0.12, W * 0.26);
    b.port('nose', 0, 'x+', 'M', 'crew');
    b.port('crew', 0.55, 'y-', 'M', 'crew');
    b.hatch('hold', 0.55, 'y+', 'cargo door');
    if (c.pdc) b.pdcs(c.pdc, 0.5, 0.75);
    if (c.tubes) b.box(0.4, 0.64, W * 0.14, H * 0.14, 'tube', { z: -H * 0.5 });
  },

  freighter(b, c) {
    const { W, H } = b;
    b.box(0, 0.06, W * 0.5, H * 0.5, 'command');
    b.box(0.06, 0.82, W * 0.1, H * 0.1, 'truss');
    const n = 4;
    for (let i = 0; i < n; i++) {
      const f0 = 0.1 + i * 0.175, f1 = f0 + 0.16;
      for (const s of [-1, 1]) for (const t of [-1, 1]) b.box(f0, f1, W * 0.44, H * 0.44, 'container', { y: s * W * 0.27, z: t * H * 0.27 });
    }
    b.box(0.82, 0.9, W * 0.6, H * 0.6, 'machinery');
    b.radiators(0.82, 0.9, W * 0.5, { vertical: true });
    b.bell(0.9, 1, W * 0.12, W * 0.26);
    b.port('crew', 0.03, 'y-', 'M', 'crew');
    b.port('cargo', 0.45, 'y+', 'L', 'cargo');
  },

  hauler(b) {
    const { W, H } = b;
    b.box(0, 0.025, W * 0.12, H * 0.1, 'command');
    b.box(0.025, 0.06, W * 0.04, H * 0.04, 'truss');
    // A berg is never square: the blocks are cut and strapped as they come
    const cuts = [[0.06, 0.3, 0.95, 0.9], [0.3, 0.55, 1, 1], [0.55, 0.72, 0.9, 0.96], [0.72, 0.88, 0.82, 0.86]];
    for (const [f0, f1, w, h] of cuts) b.box(f0, f1, W * w, H * h, 'ice');
    b.box(0.06, 0.9, W * 0.03, H * 1.04, 'truss');
    b.box(0.88, 0.94, W * 0.24, H * 0.24, 'machinery');
    b.radiators(0.88, 0.94, W * 0.35, { root: W * 0.12 });
    b.bell(0.94, 1, W * 0.05, W * 0.11);
    b.port('crew', 0.012, 'y-', 'M', 'crew');
  },

  tanker(b) {
    const { W, H } = b;
    b.box(0, 0.06, W * 0.5, H * 0.5, 'command');
    b.box(0.06, 0.86, W * 0.12, H * 0.12, 'truss');
    for (let i = 0; i < 6; i++) {
      const f0 = 0.08 + i * 0.13, f1 = f0 + 0.12;
      for (const s of [-1, 1]) b.cyl(f0, f1, W * 0.22, 'tank', { y: s * W * 0.25 });
    }
    b.box(0.86, 0.93, W * 0.5, H * 0.5, 'machinery');
    b.radiators(0.86, 0.93, W * 0.4);
    b.bell(0.93, 1, W * 0.1, W * 0.22);
    b.port('crew', 0.03, 'y-', 'M', 'crew');
    b.port('fuel', 0.5, 'y+', 'L', 'fuel');
  },

  liner(b, c) {
    const { W, H } = b;
    const rough = c.builder === 'Belt';
    b.box(0, 0.07, W * 0.5, H * 0.5, 'command');
    b.box(0.07, 0.22, W * 0.72, H * 0.72, 'hab');
    b.ring(0.26, b.L * 0.19, b.L * 0.05, b.L * 0.025, rough ? 10 : 16);
    b.box(0.22, 0.3, W * 0.2, H * 0.2, 'truss');
    if (rough) {
      // a refit: habitat cans bolted on where they fit
      for (let i = 0; i < 5; i++) b.box(0.3 + i * 0.08, 0.37 + i * 0.08, W * (0.8 + 0.2 * (i % 2)), H * (0.9 - 0.15 * (i % 3)), 'hab', { y: (i % 2 ? 1 : -1) * W * 0.05 });
    } else b.box(0.3, 0.7, W, H, 'hab');
    b.box(0.7, 0.78, W * 0.8, H * 0.8, 'cargo');
    b.box(0.78, 0.9, W * 0.6, H * 0.6, 'machinery');
    b.radiators(0.78, 0.9, W * 0.6, { vertical: true });
    b.bell(0.9, 1, W * 0.12, W * 0.24);
    b.port('crew', 0.15, 'y-', 'M', 'crew');
    b.port('pax', 0.15, 'y+', 'M', 'crew', { label: 'Passenger collar' });
    b.port('cargo', 0.74, 'y+', 'L', 'cargo');
    if (c.pdc) b.pdcs(c.pdc, 0.08, 0.7);
  },

  miner(b, c) {
    const { W, H } = b;
    b.box(0, 0.1, W * 0.45, H * 0.6, 'command');
    b.box(0.1, 0.6, W, H, 'hold');
    b.box(0.6, 0.86, W * 0.7, H * 0.7, 'machinery');
    b.radiators(0.62, 0.86, W * 0.45);
    b.bell(0.86, 1, W * 0.1, W * 0.2);
    const drivers = c.gear?.mounts || 0;
    for (let i = 0; i < drivers; i++) b.box(0.02, 0.6, W * 0.06, H * 0.08, 'gear', { y: (i % 2 ? 1 : -1) * W * 0.56 });
    for (const s of [-1, 1]) b.box(-0.03, 0.06, W * 0.05, H * 0.05, 'gear', { y: s * W * 0.3 });   // grapple arms
    b.port('crew', 0.05, 'y-', 'M', 'crew');
    b.port('cargo', 0.35, 'y+', 'L', 'cargo');
  },

  cutter(b, c) {
    const { W, H } = b;
    b.box(0, 0.15, W * 0.7, H * 0.7, 'command');
    b.box(0.15, 0.6, W, H, 'hab');
    b.box(0.17, 0.58, W * 1.06, H * 0.8, 'armor');
    b.box(0.6, 0.86, W * 0.82, H * 0.82, 'machinery');
    b.radiators(0.64, 0.84, W * 0.3);
    b.bell(0.86, 1, W * 0.12, W * 0.26);
    if (c.tubes) b.box(0.3, 0.6, W * 0.12, H * 0.12, 'tube', { z: -H * 0.52 });
    b.pdcs(c.pdc, 0.2, 0.75);
    b.port('nose', 0, 'x+', 'M', 'crew', { label: 'Boarding collar' });
    b.port('crew', 0.4, 'y-', 'S', 'crew');
  },

  corvette(b, c) {
    const { W, H } = b;
    b.box(0, 0.1, W * 0.6, H * 0.6, 'command');
    b.box(0.1, 0.5, W * 0.86, H * 0.86, 'hab');
    b.box(0.5, 0.7, W, H, 'machinery');
    b.box(0.12, 0.68, W * 0.92, H * 0.92, 'armor');
    b.box(0.7, 0.88, W * 0.8, H * 0.8, 'reactor');
    b.radiators(0.72, 0.86, W * 0.28);
    b.bell(0.88, 1, W * 0.14, W * 0.3);
    if (c.tubes) b.box(0.25, 0.7, W * 0.14, H * 0.14, 'tube', { z: -H * 0.52 });
    b.pdcs(c.pdc, 0.15, 0.8);
    b.port('nose', 0, 'x+', 'M', 'crew', { label: 'Boarding collar' });
    b.port('crew', 0.58, 'y-', 'M', 'crew');
  },

  frigate(b, c) {
    const { W, H } = b;
    b.box(0, 0.08, W * 0.5, H * 0.5, 'command');
    b.box(0.08, 0.4, W * 0.82, H * 0.82, 'hab');
    b.box(0.4, 0.62, W, H, 'machinery');
    b.box(0.1, 0.84, W * 0.9, H * 0.9, 'armor');
    b.box(0.62, 0.88, W * 0.84, H * 0.84, 'reactor');
    b.radiators(0.66, 0.86, W * 0.25);
    b.bell(0.88, 1, W * 0.13, W * 0.27);
    if (c.railgun) b.box(0.0, 0.86, W * 0.12, H * 0.12, 'rail', { z: -H * 0.5 });
    if (c.tubes) for (const s of [-1, 1]) b.box(0.3, 0.6, W * 0.1, H * 0.1, 'tube', { y: s * W * 0.32, z: -H * 0.47 });
    b.pdcs(c.pdc, 0.1, 0.85);
    b.port('nose', 0, 'x+', 'M', 'crew', { label: 'Boarding collar' });
    b.port('crew', 0.3, 'y-', 'M', 'crew');
    b.port('stores', 0.5, 'y+', 'M', 'cargo', { label: 'Stores collar' });
  },

  destroyer(b, c) {
    ARCH.frigate(b, c);
    b.box(0.2, 0.5, b.W * 0.6, b.H * 0.3, 'sensor', { z: b.H * 0.55 });
  },

  battleship(b, c) {
    const { W, H } = b;
    b.box(0, 0.06, W * 0.4, H * 0.4, 'sensor');
    b.box(0.06, 0.3, W * 0.8, H * 0.8, 'hab');
    b.box(0.3, 0.62, W, H, 'machinery');
    b.box(0.08, 0.84, W * 0.94, H * 0.94, 'armor');
    b.box(0.38, 0.52, W * 0.34, H * 0.3, 'command', { z: H * 0.6 });
    b.box(0.62, 0.88, W * 0.86, H * 0.86, 'reactor');
    b.radiators(0.66, 0.86, W * 0.2);
    b.bell(0.88, 1, W * 0.16, W * 0.32);
    for (let i = 0; i < (c.railgun || 0); i++) b.box(0.0, 0.8, W * 0.08, H * 0.08, 'rail', { y: (i - (c.railgun - 1) / 2) * W * 0.3, z: -H * 0.5 });
    for (const s of [-1, 1]) b.box(0.2, 0.7, W * 0.08, H * 0.08, 'tube', { y: s * W * 0.4, z: -H * 0.48 });
    b.pdcs(c.pdc, 0.05, 0.86);
    for (const [id, f, face] of [['crew-p', 0.18, 'y-'], ['crew-s', 0.18, 'y+'], ['stores', 0.45, 'y+'], ['nose', 0, 'x+']]) b.port(id, f, face, 'M', id === 'stores' ? 'cargo' : 'crew');
    b.port('bay', 0.45, 'y-', 'L', 'cargo', { label: 'Boat bay' });
  },

  gunship(b, c) {
    ARCH['light-freighter'](b, c);
    // weapons welded on where there was room: not symmetric, not pretty
    b.box(0.2, 0.36, b.W * 0.24, b.H * 0.3, 'armor', { y: b.W * 0.55 });
    b.box(0.5, 0.7, b.W * 0.2, b.H * 0.26, 'tube', { y: -b.W * 0.56, z: b.H * 0.1 });
  },

  raider(b, c) {
    ARCH.courier(b, c);
    b.box(0.74, 0.88, b.W * 1.05, b.H * 1.05, 'reactor');
  },
};

/**
 * The hab tower of a class with an interior: one box per deck, in the deck
 * program's order and proportions, as wide as the deck plan says.
 */
function tower(b, c, spans) {
  const { W, H } = b;
  for (const s of spans) b.box(s.f0, s.f1, W * s.width, H * Math.min(1, s.width + 0.05), DECK_ROLE[s.zone] || 'hab', { deck: s.id });
  const last = spans[spans.length - 1];
  const bellLen = 1 - last.f1;
  if (bellLen > 0.01) b.bell(last.f1, 1, W * 0.12, W * Math.min(0.3, 0.12 + bellLen * 1.6));
  // Ports where the program puts the airlocks
  for (const s of spans) {
    for (const p of s.ports) b.port(p.id, p.face === 'x+' ? 0 : (s.f0 + s.f1) / 2, p.face, p.size, p.use, { deck: s.id, label: p.label });
    if (s.cargoDoor) b.hatch('hold', (s.f0 + s.f1) / 2, s.cargoDoor, 'cargo door', { deck: s.id });
  }
}

const DECK_ROLE = { command: 'command', crew: 'hab', pax: 'hab', cargo: 'cargo', machinery: 'machinery', reactor: 'reactor' };

/** External fittings on a tower hull, by kind (what the deck plan doesn't show). */
function fittings(b, c, spans) {
  const { W, H } = b;
  const span = (id) => spans.find(s => s.id === id);
  const machine = span('engineering') || spans[spans.length - 2];
  const reactor = span('reactor') || spans[spans.length - 1];
  const command = spans[0];
  // Radiators off the reactor and engine decks, smaller (and retractable) on hulls rated for atmosphere
  b.radiators(machine.f0, reactor.f1, W * (c.atmo ? 0.22 : c.kind === 'courier' || c.kind === 'raider' ? 0.5 : 0.45), { root: W * reactor.width / 2 });
  b.box(command.f0 + 0.01, command.f0 + 0.06, W * 0.08, H * 0.2, 'sensor', { z: H * 0.5 });
  if (c.pdc) b.pdcs(c.pdc, machine.f0, Math.min(0.85, machine.f1 + 0.1));
  if (c.tubes) { const hold = span('cargo') || machine; b.box(hold.f0, hold.f1, W * 0.14, H * 0.14, 'tube', { z: -H * 0.52 }); }
  if (c.railgun) b.box(0.02, machine.f1, W * 0.1, H * 0.1, 'rail', { z: -H * 0.5 });
  if (c.gear) b.box(span('cargo')?.f0 ?? 0.3, (span('cargo')?.f1 ?? 0.5), W * 0.14, H * 0.2, 'gear', { y: W * 0.56 });
  if (c.kind === 'cutter' || c.kind === 'corvette' || c.category === 'military') {
    const hab = spans.filter(s => s.zone === 'crew' || s.zone === 'pax');
    if (hab.length) b.box(hab[0].f0, machine.f1, W * 1.02, H * 0.92, 'armor');
  }
  if (c.kind === 'shuttle' && !c.atmo) b.cyl(0.25, 0.7, H * 0.28, 'tank', { z: H * 0.66 });
  if (c.kind === 'prospector' && c.builder === 'Belt') b.legs(reactor.f1 - 0.02, 2.5, W * 0.4);
  if (c.kind === 'gunship') {
    b.box(0.2, 0.36, W * 0.24, H * 0.3, 'armor', { y: W * 0.55 });
    b.box(0.5, 0.7, W * 0.2, H * 0.26, 'tube', { y: -W * 0.56, z: H * 0.1 });
  }
  // Atmospheric entry: a ceramic belly and skids for a lifting body, a shield
  // ring round the drive and legs for a tail-sitter
  if (c.atmo?.entry === 'belly') {
    b.box(0, 0.92, W * 1.04, H * 0.08, 'shield', { z: -H / 2 - H * 0.04 });
    for (const s of [-1, 1]) b.box(0.15, 0.85, 0.5, 0.8, 'leg', { y: s * W * 0.38, z: -H / 2 - H * 0.12 });
  } else if (c.atmo?.entry === 'tail') {
    b.box(reactor.f1 - 0.03, reactor.f1, W * 0.96, H * 0.96, 'shield');
    b.legs(reactor.f1 - 0.04, 4, W * 0.36);
  }
}

// ---- THE CATALOG ----

const _cache = new Map();

/** The hull of a class (cached). */
export function hullOf(classId) {
  let h = _cache.get(classId);
  if (h) return h;
  const c = CLASSES[classId];
  if (!c) return null;
  const b = new HullBuilder(c);
  if (DECK_PROGRAMS[classId]) {
    const spans = deckSpans(classId);
    tower(b, c, spans);
    fittings(b, c, spans);
  } else (ARCH[c.hull || c.kind] || ARCH.freighter)(b, c);
  h = finish(b, c, classId);
  _cache.set(classId, h);
  return h;
}

function finish(b, c, classId) {
  const bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of b.parts) {
    const e = partExtent(p);
    bounds.x0 = Math.min(bounds.x0, e.x0); bounds.x1 = Math.max(bounds.x1, e.x1);
    bounds.y0 = Math.min(bounds.y0, e.y0); bounds.y1 = Math.max(bounds.y1, e.y1);
    bounds.z0 = Math.min(bounds.z0, e.z0); bounds.z1 = Math.max(bounds.z1, e.z1);
  }
  const tl = RCS_TL[c.tl] ?? 1;
  return {
    classId, L: b.L, W: b.W, H: b.H,
    parts: b.parts, ports: b.ports, hatches: b.hatches,
    bounds,
    radiusM: Math.hypot(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, bounds.z1 - bounds.z0) / 2,
    rcs: { accel: RCS_ACCEL[c.size] * tl, rotDeg: RCS_ROT_DEG[c.size] * tl },
    atmo: c.atmo || null,
  };
}

/** Axis-aligned extent of a part in the ship frame. */
export function partExtent(p) {
  if (p.k === 'box') return p;
  if (p.k === 'cyl') return { x0: p.x0, x1: p.x1, y0: p.y - p.r, y1: p.y + p.r, z0: p.z - p.r, z1: p.z + p.r };
  if (p.k === 'bell') { const r = Math.max(p.r0, p.r1); return { x0: p.x0, x1: p.x1, y0: -r, y1: r, z0: -r, z1: r }; }
  const R = p.r + p.d;
  return { x0: p.x - p.w / 2, x1: p.x + p.w / 2, y0: -R, y1: R, z0: -R, z1: R };
}

/** A class's port by id (or its first crew port). */
export function portOf(classId, id = null) {
  const h = hullOf(classId);
  if (!h) return null;
  return (id && h.ports.find(p => p.id === id)) || h.ports.find(p => p.use === 'crew') || h.ports[0] || null;
}

/** Ports on a hull that can mate with a collar of `size` (androgynous: same size only). */
export const matingPorts = (classId, size) => (hullOf(classId)?.ports || []).filter(p => p.size === size);

/** Is a class rated for atmospheric entry? */
export const atmoRated = (c) => !!c?.atmo;

/** Human words for a hull's collars: "M nose · M port flank · L starboard cradle". */
export function portSummary(classId) {
  const FACE = { 'x+': 'nose', 'x-': 'tail', 'y-': 'port flank', 'y+': 'starboard flank', 'z+': 'dorsal', 'z-': 'ventral' };
  return (hullOf(classId)?.ports || []).map(p => `${p.size} ${FACE[p.face]}`).join(' · ');
}
