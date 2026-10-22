// ============================================================
// LONGHAUL — Tooltips and pointers: the console's own
//
// TOOLTIPS. Anything with a `title` (or `data-tip`) gets the console's
// tooltip instead of the browser's: after a short dwell it fades in just
// above (or below) the thing it describes, anchored to it rather than to
// the pointer, and goes the moment the pointer leaves or presses. The
// `title` is moved to `data-tip` on first hover, so the browser's own
// never shows; modules keep writing `title=` as they always have.
//
// POINTERS are pixel art (the one place the console keeps the old
// pixel look): an arrow, a hand over what can be pressed, a crosshair
// over the displays that pick things, a move cross on title bars, and
// resize arrows on grips and splitters. They are drawn here from small
// pixel maps into SVG data URIs at twice their size, crisp-edged, and
// set as CSS variables the stylesheet uses (`cursor: var(--cur-hand)`),
// with the system pointer as the fallback.
// ============================================================

const DWELL_MS = 380;
let tip = null, anchor = null, timer = 0;

export function initTooltips() {
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  document.addEventListener('keydown', hide, true);
}

function target(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.nodeType !== 1) continue;
    if (n.hasAttribute('title')) { const t = n.getAttribute('title'); n.removeAttribute('title'); if (t) n.dataset.tip = t; }
    if (n.dataset?.tip) return n;
  }
  return null;
}

function onOver(e) {
  const t = target(e.target);
  if (t === anchor) return;
  hide();
  if (!t) return;
  anchor = t;
  timer = setTimeout(show, DWELL_MS);
}

function onOut(e) {
  if (!anchor) return;
  if (e.relatedTarget && anchor.contains(e.relatedTarget)) return;
  hide();
}

function show() {
  if (!anchor || !anchor.isConnected) return;
  tip.textContent = anchor.dataset.tip;
  tip.classList.remove('tip-in', 'tip-below');
  tip.style.display = 'block';
  const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const below = r.top - t.height - 8 < 4;
  const x = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 6);
  const y = below ? r.bottom + 8 : r.top - t.height - 8;
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.classList.toggle('tip-below', below);
  requestAnimationFrame(() => tip.classList.add('tip-in'));
}

export function hide() {
  clearTimeout(timer);
  anchor = null;
  if (tip) { tip.classList.remove('tip-in'); tip.style.display = 'none'; }
}

// ---- POINTERS ----
// Pixel maps: '#' outline, '.' fill, ' ' clear. Hotspots in pixels.

const MAPS = {
  arrow: { hot: [0, 0], px: [
    '#           ', '##          ', '#.#         ', '#..#        ', '#...#       ', '#....#      ', '#.....#     ', '#......#    ', '#.......#   ',
    '#........#  ', '#.........# ', '#......#####', '#...#..#    ', '#..# #..#   ', '#.#  #..#   ', '##    #..#  ', '#     #..#  ', '       ##   '] },
  hand: { hot: [5, 0], px: [
    '    ##          ', '   #..#         ', '   #..#         ', '   #..#         ', '   #..###       ', '   #..#..###    ', '   #..#..#..##  ', '## #..#..#..#.# ',
    '#..#........#.# ', '#...#.........# ', ' #............# ', '  #...........# ', '  #..........#  ', '   #.........#  ', '    #.......#   ', '    #########   '] },
  cross: { hot: [7, 7], px: [
    '      ###      ', '      #.#      ', '      #.#      ', '      #.#      ', '      #.#      ', '      ###      ', '###### . ######',
    '#.....   .....#', '###### . ######', '      ###      ', '      #.#      ', '      #.#      ', '      #.#      ', '      #.#      ', '      ###      '] },
  move: { hot: [7, 7], px: [
    '       #       ', '      #.#      ', '     #...#     ', '    ###.###    ', '  #   #.#   #  ', ' ##   #.#   ## ', '#.#####.#####.#',
    '#.............#', '#.#####.#####.#', ' ##   #.#   ## ', '  #   #.#   #  ', '    ###.###    ', '     #...#     ', '      #.#      ', '       #       '] },
  ew: { hot: [7, 4], px: [
    '   #       #   ', '  ##       ##  ', ' #.#########.# ', '#.............#', ' #.#########.# ', '  ##       ##  ', '   #       #   '] },
  ns: { hot: [3, 8], px: [
    '   #   ', '  #.#  ', ' #...# ', '#.....#', '###.###', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ',
    '###.###', '#.....#', ' #...# ', '  #.#  ', '   #   '] },
  nwse: { hot: [6, 6], px: [
    '#####       ', '#...#       ', '#..#        ', '#.#.#       ', '## #.#      ', '    #.#     ', '     #.#    ', '      #.# ##', '       #.#.#', '        #..#', '       #...#', '       #####'] },
  text: { hot: [3, 7], px: [
    '### ###', '#..#..#', '###.###', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '  #.#  ', '###.###', '#..#..#', '### ###'] },
};

const INK = '#0A0E13', FILL = '#E8EEF4', HOT = '#3EC7E6';

function svgFor(name, scale = 2) {
  const m = MAPS[name];
  const h = m.px.length, w = Math.max(...m.px.map(r => r.length));
  let rects = '';
  m.px.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${INK}"/>`;
    else if (c === '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${name === 'cross' ? HOT : FILL}"/>`;
  }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${m.hot[0] * scale} ${m.hot[1] * scale}`;
}

/** Set the pointer variables on the document (the stylesheet falls back to the system's). */
export function initPointers() {
  const root = document.documentElement.style;
  root.setProperty('--cur-default', `${svgFor('arrow')}, default`);
  root.setProperty('--cur-hand', `${svgFor('hand')}, pointer`);
  root.setProperty('--cur-cross', `${svgFor('cross')}, crosshair`);
  root.setProperty('--cur-move', `${svgFor('move')}, move`);
  root.setProperty('--cur-ew', `${svgFor('ew')}, ew-resize`);
  root.setProperty('--cur-ns', `${svgFor('ns')}, ns-resize`);
  root.setProperty('--cur-nwse', `${svgFor('nwse')}, nwse-resize`);
  root.setProperty('--cur-text', `${svgFor('text')}, text`);
}
