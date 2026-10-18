// ============================================================
// LONGHAUL — Incremental spatial hash
// Uniform grid over the ecliptic plane. Entities move between cells
// only when they cross a boundary, so per-tick upkeep is O(moved).
// Runtime bookkeeping lives on the entity as `$cell`/`$ci`
// ($-prefixed keys are stripped from saves).
// ============================================================

const OFFSET = 32768;

function cellKey(cx, cy) {
  return ((cx + OFFSET) << 16) | ((cy + OFFSET) & 0xFFFF);
}

export class SpatialHash {
  /** @param {number} cellSize cell edge in AU */
  constructor(cellSize = 0.05) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.cells = new Map();
    this.count = 0;
  }

  clear() {
    this.cells.clear();
    this.count = 0;
  }

  _keyFor(x, y) {
    return cellKey(Math.floor(x * this.inv), Math.floor(y * this.inv));
  }

  insert(e) {
    const key = this._keyFor(e.pos.x, e.pos.y);
    let cell = this.cells.get(key);
    if (!cell) { cell = []; this.cells.set(key, cell); }
    e.$cell = key;
    e.$ci = cell.length;
    cell.push(e);
    this.count++;
  }

  remove(e) {
    if (e.$cell === undefined) return;
    const cell = this.cells.get(e.$cell);
    if (cell) {
      const last = cell.pop();
      if (last !== e) {
        cell[e.$ci] = last;
        last.$ci = e.$ci;
      }
      if (cell.length === 0) this.cells.delete(e.$cell);
      this.count--;
    }
    e.$cell = undefined;
    e.$ci = undefined;
  }

  /** Re-file an entity after it moved. Cheap when it stayed in its cell. */
  update(e) {
    const key = this._keyFor(e.pos.x, e.pos.y);
    if (key === e.$cell) return;
    this.remove(e);
    this.insert(e);
  }

  /** Entities within `radius` AU of (x, y). Appends to `out`. */
  query(x, y, radius, out = []) {
    const inv = this.inv;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) * inv), x1 = Math.floor((x + radius) * inv);
    const y0 = Math.floor((y - radius) * inv), y1 = Math.floor((y + radius) * inv);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(cellKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.pos.x - x, dy = e.pos.y - y;
          if (dx * dx + dy * dy <= r2) out.push(e);
        }
      }
    }
    return out;
  }

  /** Entities inside an axis-aligned rectangle (AU). Appends to `out`. */
  queryRect(minX, minY, maxX, maxY, out = []) {
    const inv = this.inv;
    const x0 = Math.floor(minX * inv), x1 = Math.floor(maxX * inv);
    const y0 = Math.floor(minY * inv), y1 = Math.floor(maxY * inv);
    // Huge views: iterating occupied cells beats iterating empty grid squares
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size * 4) {
      for (const cell of this.cells.values()) {
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if (e.pos.x >= minX && e.pos.x <= maxX && e.pos.y >= minY && e.pos.y <= maxY) out.push(e);
        }
      }
      return out;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(cellKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if (e.pos.x >= minX && e.pos.x <= maxX && e.pos.y >= minY && e.pos.y <= maxY) out.push(e);
        }
      }
    }
    return out;
  }
}
