// ============================================================
// LONGHAUL — Mating geometry: how two hulls meet at a collar
//
// The world is flown in a plane, but hulls are solid: a ship latched to
// a gantry arm by its port-flank collar hangs nose-up beside the tower,
// its dorsal side facing out of the plane. This module works the pose
// of a hull in three dimensions (a rotation R from the ship frame to the
// solar frame, with the plane's normal as Z) from the frame of the collar
// it mates with, and what the plane shows of it: the facing of its nose,
// and whether we look down on its back (top), its belly (top, mirrored),
// or along its flank (side).
//
// A collar frame is { pos (AU), normal, up } with normal and up unit
// vectors in the plane: the collar faces out along `normal`, and `up` is
// the way a mated hull's axis lies (a gantry arm: away from the rock; a
// ship's flank collar: along that ship's axis).
//
// Mating rule: the two collar normals oppose. For a flank or dorsal
// collar the ship's axis lies along `up`; for a nose collar the nose goes
// into the collar and the ship's starboard lies along `up`.
// ============================================================

import { AU_M } from '../core/constants.js';
import { FACES } from './hulls.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => [-a[0], -a[1], -a[2]];

/**
 * The rotation that puts a hull's `face` collar against a collar frame
 * (normal n, up u, both in the plane: [x, y, 0]). Returns the images of
 * the ship's axes: { X, Y, Z } (3-vectors, solar frame with Z out of the plane).
 */
export function mateRotation(face, n, u) {
  const N = [n.x, n.y, 0], U = [u.x, u.y, 0];
  let X, Y, Z;
  if (face === 'x+') { X = neg(N); Y = U; Z = cross(X, Y); }
  else if (face === 'x-') { X = N; Y = U; Z = cross(X, Y); }
  else if (face === 'y-') { Y = N; X = U; Z = cross(X, Y); }
  else if (face === 'y+') { Y = neg(N); X = U; Z = cross(X, Y); }
  else if (face === 'z+') { Z = neg(N); X = U; Y = cross(Z, X); }
  else { Z = N; X = U; Y = cross(Z, X); }
  return { X, Y, Z };
}

/** A ship-frame vector (m) turned into the solar frame by R. */
export const turn = (R, v) => [
  R.X[0] * v[0] + R.Y[0] * v[1] + R.Z[0] * v[2],
  R.X[1] * v[0] + R.Y[1] * v[1] + R.Z[1] * v[2],
  R.X[2] * v[0] + R.Y[2] * v[1] + R.Z[2] * v[2],
];

/** How the plane shows a hull in pose R: the nose's facing and which side we see. */
export function planeView(R) {
  const facing = Math.atan2(R.X[1], R.X[0]);
  const top = Math.abs(R.Z[2]) > 0.7;
  return { facing, view: top ? (R.Z[2] > 0 ? 'top' : 'top-flip') : (R.Y[2] > 0 ? 'side-flip' : 'side') };
}

/**
 * The pose of a hull whose collar `port` (from hulls.js: x, y, z, face) is
 * mated to the collar frame `frame`, standing `gapM` off it: the hull's
 * centre (AU), its rotation, facing and view.
 */
export function matePose(frame, port, gapM = 0) {
  const R = mateRotation(port.face, frame.normal, frame.up);
  const p = turn(R, [port.x, port.y, port.z]);
  const cx = frame.pos.x + (frame.normal.x * gapM - p[0]) / AU_M;
  const cy = frame.pos.y + (frame.normal.y * gapM - p[1]) / AU_M;
  return { center: { x: cx, y: cy }, offZ: -p[2], R, ...planeView(R) };
}

/** Where a hull's centre sits off a collar frame, in that frame's (normal, up) metres. */
export function mateOffset(frame, port) {
  const R = mateRotation(port.face, frame.normal, frame.up);
  const p = turn(R, [port.x, port.y, port.z]);
  return { n: -(p[0] * frame.normal.x + p[1] * frame.normal.y), u: -(p[0] * frame.up.x + p[1] * frame.up.y) };
}

/**
 * The collar frame of a port on a ship flying in the plane (not rolled:
 * its Z is the plane's): position (AU), the outward normal, and `up` (the
 * ship's axis for a flank collar, its starboard for a nose collar).
 */
export function shipPortFrame(pos, facing, port) {
  const c = Math.cos(facing), s = Math.sin(facing);
  const n = FACES[port.face];
  const toW = (x, y) => ({ x: x * c - y * s, y: x * s + y * c });
  const at = toW(port.x, port.y);
  const normal = toW(n[0], n[1]);
  const up = port.face[0] === 'x' ? toW(0, 1) : toW(1, 0);
  return { pos: { x: pos.x + at.x / AU_M, y: pos.y + at.y / AU_M }, normal, up };
}
