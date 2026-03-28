// ============================================================
// LONGHAUL — Spatial Hash Grid
// O(1) range queries for entity lookups at scale.
// Designed for 200k+ entities.
// ============================================================

export class SpatialHash {
  /**
   * @param {number} cellSize - Cell size in AU. Default 0.05 AU (~7.5M km).
   *   Balances between query efficiency (fewer cells checked) and
   *   cell population (fewer entities per cell for small queries).
   */
  constructor(cellSize = 0.05) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.cells = new Map();
    this.count = 0;
  }

  /** Remove all entities from the grid. */
  clear() {
    this.cells.clear();
    this.count = 0;
  }

  /**
   * Insert a single entity into the grid.
   * Entity must have entity.position.x and entity.position.y in AU.
   */
  insert(entity) {
    const cx = (entity.position.x * this.invCellSize) | 0;
    const cy = (entity.position.y * this.invCellSize) | 0;
    // Bitwise key packing for faster Map lookups than string keys.
    // Supports coordinates from -32768 to 32767 cells (~1600 AU at 0.05 cell size).
    const key = ((cx + 32768) << 16) | ((cy + 32768) & 0xFFFF);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push(entity);
    this.count++;
  }

  /**
   * Bulk insert an array of entities. Faster than individual inserts
   * due to reduced function call overhead.
   */
  insertAll(entities) {
    const inv = this.invCellSize;
    const cells = this.cells;
    for (let i = 0, len = entities.length; i < len; i++) {
      const e = entities[i];
      const cx = (e.position.x * inv) | 0;
      const cy = (e.position.y * inv) | 0;
      const key = ((cx + 32768) << 16) | ((cy + 32768) & 0xFFFF);
      let cell = cells.get(key);
      if (!cell) {
        cell = [];
        cells.set(key, cell);
      }
      cell.push(e);
    }
    this.count += entities.length;
  }

  /**
   * Query all entities within a circular radius.
   * @param {number} x - Center x in AU
   * @param {number} y - Center y in AU
   * @param {number} radius - Radius in AU
   * @returns {Array} Entities within radius
   */
  query(x, y, radius) {
    const r2 = radius * radius;
    const inv = this.invCellSize;
    const minCx = ((x - radius) * inv) | 0;
    const maxCx = ((x + radius) * inv) | 0;
    const minCy = ((y - radius) * inv) | 0;
    const maxCy = ((y + radius) * inv) | 0;
    const cells = this.cells;
    const result = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = ((cx + 32768) << 16) | ((cy + 32768) & 0xFFFF);
        const cell = cells.get(key);
        if (!cell) continue;
        for (let i = 0, len = cell.length; i < len; i++) {
          const e = cell[i];
          const dx = e.position.x - x;
          const dy = e.position.y - y;
          if (dx * dx + dy * dy <= r2) {
            result.push(e);
          }
        }
      }
    }
    return result;
  }

  /**
   * Query all entities within an axis-aligned bounding box.
   * Useful for viewport culling on the solar map.
   * @param {number} x1 - Min x in AU
   * @param {number} y1 - Min y in AU
   * @param {number} x2 - Max x in AU
   * @param {number} y2 - Max y in AU
   * @returns {Array} Entities within the rectangle
   */
  queryRect(x1, y1, x2, y2) {
    const inv = this.invCellSize;
    const minCx = (x1 * inv) | 0;
    const maxCx = (x2 * inv) | 0;
    const minCy = (y1 * inv) | 0;
    const maxCy = (y2 * inv) | 0;
    const cells = this.cells;
    const result = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = ((cx + 32768) << 16) | ((cy + 32768) & 0xFFFF);
        const cell = cells.get(key);
        if (!cell) continue;
        for (let i = 0, len = cell.length; i < len; i++) {
          const e = cell[i];
          if (e.position.x >= x1 && e.position.x <= x2 &&
              e.position.y >= y1 && e.position.y <= y2) {
            result.push(e);
          }
        }
      }
    }
    return result;
  }
}
