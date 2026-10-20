// ============================================================
// LONGHAUL — Save format
// The game state is plain data. Saving strips runtime-only keys
// (prefixed with $) and encodes ±Infinity; loading checks the schema.
// Saves from an older schema are refused: start a new game. A save of
// the current schema from an earlier version is brought up to date in
// place (upgradeState: the plot, the background population).
// ============================================================

import { SAVE_SCHEMA, upgradeState } from './game.js';
import { resetWorld } from './world.js';
import { VERSION } from '../version.js';

const INF = '__inf__', NINF = '__-inf__';

function replacer(key, value) {
  if (key && key[0] === '$') return undefined;
  if (value === Infinity) return INF;
  if (value === -Infinity) return NINF;
  return value;
}

function reviver(_key, value) {
  if (value === INF) return Infinity;
  if (value === NINF) return -Infinity;
  return value;
}

/** Game state → JSON string. */
export function serialize(state) {
  state.version = VERSION;
  return JSON.stringify(state, replacer);
}

/** JSON string or object → { state }. Throws on a save from another schema. */
export function deserialize(input) {
  const data = typeof input === 'string' ? JSON.parse(input, reviver) : input;
  if (data && data.schema === SAVE_SCHEMA) {
    resetWorld(data);
    upgradeState(data);
    return { state: data };
  }
  const from = data?.version ? `v${data.version}` : `schema ${data?.schema ?? 'unknown'}`;
  throw new Error(`This save is from an older version (${from}) and can't be loaded — start a new game`);
}
