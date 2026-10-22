// ============================================================
// LONGHAUL — Names on a display, without printing one over another
//
// A display (the solar map, the scanner, the threat board) hands every
// name it wants to show to a Labels pass instead of drawing it on the
// spot, with how much it matters, and marks the spots that must stay
// readable (each contact's dot, our own ship, the corners the display
// writes in). At the end of the frame the names are placed most
// important first: to the right of the mark, else to its left, above,
// below; a name with no free place is left off (the mark is still there
// to hover and click; our ship and the selection go first, so they keep
// theirs). Names stay inside the display.
//
// Cost: what is placed goes into a coarse grid of cells, so a name is
// only tested against what is near it: a map with thousands of marks
// and a few hundred names stays well under a millisecond.
// ============================================================

const PX = /(\d+(?:\.\d+)?)px/;
const CELL = 48;

export class Labels {
  constructor() { this.list = []; this.grid = new Map(); }

  /** Start a frame. */
  reset() { this.list.length = 0; this.grid.clear(); }

  /** Keep an area clear of names (screen px). */
  block(x0, y0, x1, y1) { this._put({ x0, y0, x1, y1 }); }

  /**
   * A name for the mark at (x, y): `off` is the gap from the mark's centre
   * to the text, or [across, up and down] for a long mark (a hull seen side
   * on). `above` tries above and below first. `fixed` names have one place
   * only (a ring's label, a zone's corner): (x + off, y) as the text's left
   * and middle.
   */
  add(text, x, y, { off = 8, font, color, alpha = 1, pri = 1, fixed = false, above = false } = {}) {
    if (text) this.list.push({ text, x, y, off, font, color, alpha, pri, fixed, above });
  }

  /** Visit the grid cells a box touches; stop when `fn` says false. */
  _cells(b, fn) {
    for (let cx = Math.floor(b.x0 / CELL), cx1 = Math.floor(b.x1 / CELL); cx <= cx1; cx++)
      for (let cy = Math.floor(b.y0 / CELL), cy1 = Math.floor(b.y1 / CELL); cy <= cy1; cy++)
        if (fn(cx * 8192 + cy) === false) return false;
    return true;
  }

  _put(b) {
    this._cells(b, (k) => { let c = this.grid.get(k); if (!c) this.grid.set(k, c = []); c.push(b); });
  }

  _free(b) {
    return this._cells(b, (k) => {
      const c = this.grid.get(k);
      return !c || !c.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    });
  }

  draw(ctx, W, H) {
    const list = this.list.sort((a, b) => b.pri - a.pri);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const l of list) {
      ctx.font = l.font;
      const w = ctx.measureText(l.text).width;
      const h = +(PX.exec(l.font)?.[1] ?? 11);
      // (a name's box is its text, no margin: the gap to its mark is `off`)
      const box = (tx, ty) => ({ x0: tx, y0: ty - h * 0.5, x1: tx + w, y1: ty + h * 0.5, tx, ty });
      const ox = Array.isArray(l.off) ? l.off[0] : l.off, oy = Array.isArray(l.off) ? l.off[1] : l.off;
      const right = box(l.x + ox, l.y), left = box(l.x - ox - w, l.y);
      const up = box(l.x - w / 2, l.y - oy - h * 0.5), down = box(l.x - w / 2, l.y + oy + h * 0.5);
      const tries = l.fixed ? [right] : l.above ? [up, down, right, left] : [right, left, up, down];
      const at = tries.find(b => b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= H && this._free(b));
      if (!at) continue;
      this._put(at);
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, at.tx, at.ty);
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }
}
