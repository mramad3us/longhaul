// ============================================================
// LONGHAUL — 8-Bit Pixel Art SVG Icon & Tile Library
// Every graphic is built from rect "pixels" with crispEdges
// ============================================================

export const SVG_NS = 'http://www.w3.org/2000/svg';

// Pixel helper: creates a rect at grid position
function px(x, y, color, s = 1) {
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${color}"/>`;
}

// Row helper: draws multiple pixels from a color-map string
// Each char maps to a color, '.' = transparent
function pxRow(y, pattern, palette, s = 1) {
  let out = '';
  for (let x = 0; x < pattern.length; x++) {
    const ch = pattern[x];
    if (ch !== '.' && palette[ch]) {
      out += `<rect x="${x * s}" y="${y * s}" width="${s}" height="${s}" fill="${palette[ch]}"/>`;
    }
  }
  return out;
}

// Build a sprite from an array of pattern strings
function sprite(patterns, palette, s = 1) {
  return patterns.map((row, y) => pxRow(y, row, palette, s)).join('');
}

function svg(width, height, viewBox, innerHTML, cls = '') {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('width', width);
  el.setAttribute('height', height);
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('fill', 'none');
  el.setAttribute('shape-rendering', 'crispEdges');
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = innerHTML;
  return el;
}

// ---- COLOR PALETTES ----

const C = {
  // UI / Accent
  teal:     '#4FD1C5',
  tealDk:   '#2B8A82',
  tealLt:   '#6EEAE0',
  amber:    '#E2A355',
  amberDk:  '#9A6A2A',
  amberLt:  '#FBBF24',
  red:      '#E25555',
  redDk:    '#8B3A3A',
  redLt:    '#FF6B6B',
  green:    '#6BCB77',
  greenDk:  '#3A7A42',
  blue:     '#5BC0EB',
  blueDk:   '#2A6A8A',
  purple:   '#C084FC',
  purpleDk: '#7A4AAA',
  orange:   '#F97316',

  // Hull / structure
  hull:     '#2D5A6A',
  hullDk:   '#1A2A3A',
  hullLt:   '#3D7A8A',
  metal:    '#5A6A7A',
  metalDk:  '#3A4A5A',
  metalLt:  '#8A9BAE',

  // Backgrounds
  bg:       '#0D1520',
  bgDk:     '#060A10',
  bgLt:     '#1A2636',

  // Skin tones
  skin1:    '#D4A574',
  skin1dk:  '#B8895A',
  skin2:    '#8B6844',
  skin2dk:  '#6A4E30',
  skin3:    '#F5D6B8',
  skin3dk:  '#D4B896',
  skin4:    '#4A3728',
  skin4dk:  '#362818',

  // Hair
  hair1:    '#2A1A0A',  // dark brown
  hair2:    '#D4A020',  // blonde
  hair3:    '#8B2A0A',  // red
  hair4:    '#1A1A2A',  // black
  hair5:    '#8A8A9A',  // grey
  hair6:    '#E2A355',  // amber

  white:    '#FFFFFF',
  offwhite: '#D1DBE6',
  dim:      '#4A5A6A',
};


// ==== MENU / HUD ICONS (16x16 pixel art) ====

export function iconNewGame() {
  const p = {
    t: C.teal, d: C.tealDk, b: C.bg, w: C.white,
  };
  return svg(24, 24, '0 0 16 16', sprite([
    '......tt........',
    '.....t..t.......',
    '....t.ww.t......',
    '...t.w..w.t.....',
    '..t.w....w.t....',
    '..t.w....w.t....',
    '..t.w.tt.w.t....',
    '..t.w.tt.w.t....',
    '..t.w....w.t....',
    '..t.w....w.t....',
    '...t.w..w.t.....',
    '....t.ww.t......',
    '.....t..t.......',
    '......tt........',
  ], p, 1));
}

export function iconLoadGame() {
  const p = { t: C.teal, d: C.tealDk, m: C.metalDk };
  return svg(24, 24, '0 0 16 16', `
    ${sprite([
      '................',
      '......tt........',
      '......tt........',
      '.....tttt.......',
      '....tttttt......',
      '......tt........',
      '......tt........',
      '......tt........',
      '......tt........',
      '......tt........',
      '................',
      '..mmmmmmmmmm....',
      '..m........m....',
      '..mmmmmmmmmm....',
    ], p, 1)}
    <rect x="6" y="1" width="2" height="1" fill="${C.teal}">
      <animate attributeName="y" values="1;3;1" dur="1.5s" repeatCount="indefinite"/>
    </rect>
  `);
}

export function iconSettings() {
  const p = { t: C.teal, d: C.tealDk };
  return svg(24, 24, '0 0 16 16', `
    ${sprite([
      '......tt........',
      '.....tttt.......',
      '..tt.tttt.tt....',
      '..tttttttttt....',
      '..ttt.tt.ttt....',
      '.tttt....tttt...',
      '.tt........tt...',
      '.tt........tt...',
      '.tttt....tttt...',
      '..ttt.tt.ttt....',
      '..tttttttttt....',
      '..tt.tttt.tt....',
      '.....tttt.......',
      '......tt........',
    ], p, 1)}
    <g transform="translate(0,0)">
      <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="20s" repeatCount="indefinite"/>
    </g>
  `);
}

export function iconPause() {
  return svg(16, 16, '0 0 12 12', sprite([
    '............',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '.aaa..aaa...',
    '............',
  ], { a: C.amber }, 1));
}

export function iconHudSettings() {
  const p = { m: C.metalLt, d: C.metalDk };
  return svg(20, 20, '0 0 14 14', sprite([
    '.....mm.......',
    '....mmmm......',
    '.mm.mmmm.mm...',
    '.mmmmmmmmmm...',
    '.mmm.mm.mmm...',
    'mmmm....mmmm..',
    'mm........mm..',
    'mm........mm..',
    'mmmm....mmmm..',
    '.mmm.mm.mmm...',
    '.mmmmmmmmmm...',
    '.mm.mmmm.mm...',
    '....mmmm......',
    '.....mm.......',
  ], p, 1), 'hud-svg');
}

export function iconHudSave() {
  const p = { m: C.metalLt, d: C.metalDk, b: C.bgLt };
  return svg(20, 20, '0 0 14 14', sprite([
    '.mmmmmmmmmmm..',
    '.m..mmmm..dm..',
    '.m..mmmm..dm..',
    '.m..mmmm...m..',
    '.m.........m..',
    '.m.........m..',
    '.m.........m..',
    '.m.ddddddd.m..',
    '.m.d.....d.m..',
    '.m.d.ddd.d.m..',
    '.m.d.ddd.d.m..',
    '.m.d.....d.m..',
    '.m.ddddddd.m..',
    '.mmmmmmmmmmm..',
  ], p, 1), 'hud-svg');
}

export function iconHudExit() {
  const p = { m: C.metalLt, r: C.red };
  return svg(20, 20, '0 0 14 14', sprite([
    '.mmmmm........',
    '.m...m........',
    '.m...m...r....',
    '.m...m..rr....',
    '.m...m.rrrrr..',
    '.m...mmrrrrrr.',
    '.m...m.rrrrr..',
    '.m...m..rr....',
    '.m...m...r....',
    '.m...m........',
    '.mmmmm........',
  ], p, 1), 'hud-svg');
}

export function iconThrust() {
  // Flame/rocket icon in amber/white
  const p = { w: C.white, a: C.amber, A: C.amberLt, r: C.red, d: C.amberDk, m: C.metalDk };
  return svg(16, 16, '0 0 16 16', sprite([
    '......ww........',
    '.....wwww.......',
    '.....wAAw.......',
    '....wwAAww......',
    '....wAAAAw......',
    '...wwAAAAww.....',
    '...wAaaaAw......',
    '..mwAaaaAwm.....',
    '..mwAaaaAwm.....',
    '..mmwaaaaWmm....',
    '..mm.aaaa.mm....',
    '..mm..rr..mm....',
    '..mm..rr..mm....',
    '...m......m.....',
    '................',
    '................',
  ], p, 1));
}

export function iconMinus() {
  return svg(20, 20, '0 0 12 12', sprite([
    '............',
    '............',
    '............',
    '............',
    '............',
    '..tttttttt..',
    '..tttttttt..',
    '............',
    '............',
  ], { t: C.teal }, 1));
}

export function iconPlus() {
  return svg(20, 20, '0 0 12 12', sprite([
    '............',
    '............',
    '.....tt.....',
    '.....tt.....',
    '..tttttttt..',
    '..tttttttt..',
    '.....tt.....',
    '.....tt.....',
    '............',
  ], { t: C.teal }, 1));
}

export function iconDelete() {
  return svg(16, 16, '0 0 12 12', sprite([
    '..rrrrrrrr..',
    '............',
    '..rrrrrrrr..',
    '..r.rr.r.r..',
    '..r.rr.r.r..',
    '..r.rr.r.r..',
    '..r.rr.r.r..',
    '..r.rr.r.r..',
    '..r.rr.r.r..',
    '..rrrrrrrr..',
  ], { r: C.red }, 1));
}


// ==== RESOURCE ICONS (12x12 pixel art) ====

export function iconFuel() {
  return svg(18, 18, '0 0 12 12', `
    ${sprite([
      '....aa......',
      '...aaaa.....',
      '...abba.....',
      '..aabbaa....',
      '..aabbaa....',
      '.aaabbaaa...',
      '.aaa..aaa...',
      '.aaaaaaa....',
      '..aaaaaa....',
      '...aaaa.....',
      '....aa......',
    ], { a: C.amber, b: C.amberLt }, 1)}
    <rect x="5" y="3" width="1" height="2" fill="${C.amberLt}">
      <animate attributeName="height" values="2;3;1;2" dur="0.8s" repeatCount="indefinite"/>
    </rect>
  `);
}

export function iconOxygen() {
  return svg(18, 18, '0 0 12 12', sprite([
    '...bbbb.....',
    '..b....b....',
    '.b..bb..b...',
    '.b.b..b.b...',
    '.b.b..b.b...',
    '.b..bb..b...',
    '.b......b...',
    '..b....b....',
    '...bbbb.....',
  ], { b: C.blue }, 1));
}

export function iconN2() {
  return svg(18, 18, '0 0 12 12', sprite([
    '...cccc.....',
    '..c....c....',
    '.c..cc..c...',
    '.c.c..c.c...',
    '.c.c..c.c...',
    '.c..cc..c...',
    '.c......c...',
    '..c....c....',
    '...cccc.....',
  ], { c: '#7B8FA3' }, 1));
}

export function iconWater() {
  return svg(18, 18, '0 0 12 12', sprite([
    '.....b......',
    '....bb......',
    '...bbbb.....',
    '..bbbbbb....',
    '..bblbbbb...',
    '.bbbllbbbb..',
    '.bbbbbbbb...',
    '..bbbbbb....',
    '...bbbb.....',
  ], { b: '#4A90D9', l: '#7AB8F0' }, 1));
}

export function iconFood() {
  return svg(18, 18, '0 0 12 12', sprite([
    '............',
    '....gg......',
    '...gggg.....',
    '..gggggg....',
    '..ggGggg....',
    '.gggggggg...',
    '.gggggggg...',
    '..mmmmmm....',
    '...mmmm.....',
    '............',
  ], { g: C.green, G: C.greenDk, m: '#5A4A3A' }, 1));
}

export function iconCrew() {
  return svg(18, 18, '0 0 12 12', sprite([
    '....pp......',
    '...pppp.....',
    '...ssss.....',
    '...s.ss.....',
    '...ssss.....',
    '..tttttt....',
    '..tttttt....',
    '..t.tt.t....',
    '...llll.....',
    '...l..l.....',
  ], { p: C.purple, s: C.skin1, t: C.purpleDk, l: C.metalDk }, 1));
}

export function iconPower() {
  return svg(18, 18, '0 0 12 12', `
    ${sprite([
      '......y.....',
      '.....yy.....',
      '....yy......',
      '...yy.......',
      '..yyyyy.....',
      '.....yy.....',
      '....yy......',
      '...yy.......',
      '..yy........',
      '.yy.........',
    ], { y: C.amberLt }, 1)}
    <g opacity="1">
      <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" repeatCount="indefinite"/>
    </g>
  `);
}


// ==== LANDING SCREEN LOGO (pixel art ship) ====

export function logoShip() {
  const P = {
    h: C.hull, H: C.hullLt, d: C.hullDk,
    t: C.teal, T: C.tealDk,
    a: C.amber, A: C.amberLt, D: C.amberDk,
    w: C.white, b: C.blue,
    r: C.redLt, m: C.metalDk,
    s: C.skin1, p: C.purple,
    g: C.bgLt,
  };

  const shipPixels = [
    // Nose / Bridge (rows 0-8)
    '..........HHHH..........',  // 0
    '.........HHbbHH.........',  // 1
    '........HHb..bHH........',  // 2
    '.......HH.b..b.HH.......',  // 3
    '......HH..tttt..HH......',  // 4
    '.....HH..t.tt.t..HH.....',  // 5
    '....HH...tttttt...HH....',  // 6
    '...HH.....tttt.....HH...',  // 7
    '...Hh.hhhhhhhhhhhh.hH...',  // 8
    // Crew Quarters (rows 9-14)
    '...hh.gggggggggggg.hh...',  // 9
    '...hh.gpggg..gggpg.hh...',  // 10
    '...hh.gggggg.ggggg.hh...',  // 11
    '...hh.gpggg..gggpg.hh...',  // 12
    '...hh.gggggggggggg.hh...',  // 13
    '...hh.hhhhhhhhhhhh.hh...',  // 14
    // Mess Hall (rows 15-19)
    '...hh.gggggggggggg.hh...',  // 15
    '...hh.gmmgg..ggmmg.hh...',  // 16
    '...hh.gggggg.ggggg.hh...',  // 17
    '...hh.gggggggggggg.hh...',  // 18
    '...hh.hhhhhhhhhhhh.hh...',  // 19
    // Cargo (rows 20-24)
    '..HHh.gggggggggggg.hHH..',  // 20
    '..HHh.gddgg..ggddg.hHH..',  // 21
    '..HHh.gddgg..ggddg.hHH..',  // 22
    '..HHh.gggggggggggg.hHH..',  // 23
    '..HHh.hhhhhhhhhhhh.hHH..',  // 24
    // Engineering (rows 25-30)
    '...hh.gggggggggggg.hh...',  // 25
    '...hh.ggaagg.gaaggg.hh...',  // 26 - note: will be slightly off, that's fine
    '...hh.gaaaag.gaaaag.hh...',  // 27
    '...hh.ggaagg.gaaggg.hh...',  // 28
    '...hh.gggggggggggg.hh...',  // 29
    '...Hh.hhhhhhhhhhhh.hH...',  // 30
    // Reactor (rows 31-36)
    '....hh.ggggggggggg.hh....',  // 31
    '....hh.gggrrrrgggg.hh....',  // 32
    '....hh.ggrAAAArgg.hh....',  // 33
    '....hh.ggrAAAArgg.hh....',  // 34
    '....hh.gggrrrrgggg.hh....',  // 35
    '....hh.ggggggggggg.hh....',  // 36
    '....HHhhhhhhhhhhhhHH....',  // 37
    // Engine exhaust (rows 38-42)
    '.....HHH.aaaa.HHH.......',  // 38
    '......HH.AAAA.HH........',  // 39
    '.......h..AA..h..........',  // 40
    '..........AA.............',  // 41
    '..........aa.............',  // 42
  ];

  const pxSize = 4;
  const w = 24 * pxSize;
  const h = shipPixels.length * pxSize;

  return svg(w / 2, h / 2, `0 0 ${w} ${h}`, `
    ${shipPixels.map((row, y) => pxRow(y, row, P, pxSize)).join('')}
    <!-- Animated engine glow -->
    <rect x="${9*pxSize}" y="${41*pxSize}" width="${2*pxSize}" height="${pxSize}" fill="${C.amberLt}" opacity="0.8">
      <animate attributeName="opacity" values="0.4;1;0.4" dur="0.6s" repeatCount="indefinite"/>
      <animate attributeName="height" values="${pxSize};${pxSize*2};${pxSize}" dur="0.8s" repeatCount="indefinite"/>
    </rect>
    <rect x="${10*pxSize}" y="${42*pxSize}" width="${pxSize}" height="${pxSize}" fill="${C.amber}" opacity="0.5">
      <animate attributeName="opacity" values="0.2;0.7;0.2" dur="0.5s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${42*pxSize};${43*pxSize};${42*pxSize}" dur="0.7s" repeatCount="indefinite"/>
    </rect>
    <!-- Bridge window blink -->
    <rect x="${10*pxSize}" y="${2*pxSize}" width="${pxSize}" height="${pxSize}" fill="${C.blue}" opacity="0.6">
      <animate attributeName="opacity" values="0.3;0.8;0.3" dur="3s" repeatCount="indefinite"/>
    </rect>
  `, 'logo-ship');
}


// ==== SHIP TILE SYSTEM (16x16 pixel grid, rendered at 32px) ====

const TILE_SIZE = 32;
const PX = 2; // each "pixel" is 2 real pixels (16x16 grid in 32x32 tile)

export const TileType = {
  EMPTY: 0,
  HULL_WALL: 1,
  INTERIOR_WALL: 2,
  FLOOR: 3,
  DOOR: 4,
  LADDER: 5,
  CONSOLE: 6,
  BUNK: 7,
  TABLE: 8,
  ENGINE: 9,
  REACTOR: 10,
  STORAGE: 11,
  LIFE_SUPPORT: 12,
  AIRLOCK: 13,
  MEDBAY: 14,
  NAV_CONSOLE: 15,
  CRASH_COUCH: 16,
  TERMINAL: 17,
  EVA_LOCKER: 18,
};

// Human-readable tile names (for tooltips and UI)
export const TILE_NAMES = {
  [TileType.HULL_WALL]: 'Hull Wall',
  [TileType.INTERIOR_WALL]: 'Interior Wall',
  [TileType.FLOOR]: 'Floor',
  [TileType.DOOR]: 'Door',
  [TileType.LADDER]: 'Ladder',
  [TileType.CONSOLE]: 'Console',
  [TileType.BUNK]: 'Bunk',
  [TileType.TABLE]: 'Table',
  [TileType.ENGINE]: 'Epstein Drive',
  [TileType.REACTOR]: 'Reactor',
  [TileType.STORAGE]: 'Storage Bay',
  [TileType.LIFE_SUPPORT]: 'Life Support',
  [TileType.AIRLOCK]: 'Airlock',
  [TileType.MEDBAY]: 'Medical Bay',
  [TileType.NAV_CONSOLE]: 'Navigation Console',
  [TileType.CRASH_COUCH]: 'Crash Couch',
  [TileType.TERMINAL]: 'Terminal',
  [TileType.EVA_LOCKER]: 'EVA Suit Locker',
};

// Tiles that are interactive (clickable for info/actions)
export const INTERACTIVE_TILES = new Set([
  TileType.CONSOLE, TileType.NAV_CONSOLE, TileType.ENGINE,
  TileType.REACTOR, TileType.STORAGE, TileType.LIFE_SUPPORT,
  TileType.AIRLOCK, TileType.MEDBAY, TileType.CRASH_COUCH,
  TileType.TERMINAL, TileType.EVA_LOCKER,
]);

// Tile palettes
const TP = {
  h: C.hull, H: C.hullLt, d: C.hullDk, m: C.metalDk, M: C.metalLt,
  g: C.bgLt, b: C.bg, B: C.bgDk,
  t: C.teal, T: C.tealDk, L: C.tealLt,
  a: C.amber, A: C.amberLt, D: C.amberDk,
  r: C.red, R: C.redLt, k: C.redDk,
  n: C.green, N: C.greenDk,
  u: C.blue, U: C.blueDk,
  p: C.purple, P: C.purpleDk,
  w: C.white, o: C.offwhite, i: C.dim,
};

const TILE_PATTERNS = {
  [TileType.HULL_WALL]: [
    'HHHHHHHHHHHHHHhh',
    'HhhhhhhhhhhhhhHHh',
    'Hhdddddddddddhh.',
    'Hhdddddddddddhh.',
    'HhdddddddddddhH.',
    'HhdddddddddddhH.',
    'Hhdddddddddddhh.',
    'Hhdddddddddddhh.',
    'HhdddddddddddhH.',
    'HhdddddddddddhH.',
    'Hhdddddddddddhh.',
    'Hhdddddddddddhh.',
    'HhdddddddddddhH.',
    'HhhhhhhhhhhhhhHH.',
    'hHHHHHHHHHHHHHHh.',
    'hh...............',
  ],
  [TileType.FLOOR]: [
    'bbbbbbbbbbbbbbbb',
    'bgbbbbbbbbbbbbgb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbibbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbibbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbibbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bgbbbbbbbbbbbbgb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.DOOR]: [
    'bbbbbbbbbbbbbbbb',
    'bbbbbbmmbbbbbbbb',
    'bbbbbbmmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmLLmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbmttmbbbbbbbb',
    'bbbbbbmmbbbbbbbb',
    'bbbbbbmmbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.LADDER]: [
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmmmmmmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmmmmmmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmmmmmmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmmmmmmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbmbbbbmbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.CONSOLE]: [
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbiTTTTTTTTTibb',
    'bbiTtbbbbtTTibb',
    'bbiTbbbbbbTTibb',
    'bbiTtbbbbtTTibb',
    'bbiTTTTTTTTTibb',
    'bbiiiiiiiiiiibb',
    'bbbbbiiiibbbbb',
    'bbbbbimmibbbbb',
    'bbbbiimmiibbbbb',
    'bbbiibbbbiibbbb',
    'bbiibbbbbbiibbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.NAV_CONSOLE]: [
    'bbbbbbbbbbbbbbbb',
    'bttttttttttttttb',
    'btTTTTTTTTTTTTtb',
    'btTBBwBBBBBBTTtb',
    'btTBBBBwBBBBTTtb',
    'btTBBBBBBBwBTTtb',
    'btTBBwBBBBBLTTtb',
    'btTBBBBBwBBBTTtb',
    'btTTTTTTTTTTTTtb',
    'bttttttttttttttb',
    'bbbbbmmmmmmbbbbb',
    'bbbbmmiiiimmbbb',
    'bbbmmiibbiimmbb',
    'bbmmbbbbbbbbmmbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.BUNK]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbidddddddddibb',
    'bbiUUdddddddib',
    'bbiUUdddddddibb',
    'bbidddddddddibb',
    'bbiiiiiiiiiiibb',
    'bbibbbbbbbbbibbb',
    'bbiiiiiiiiiiibb',
    'bbidddddddddibb',
    'bbiUUdddddddib',
    'bbiUUdddddddibb',
    'bbidddddddddibb',
    'bbiiiiiiiiiiibb',
    'bbibbbbbbbbbibbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.TABLE]: [
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbmmmmmmmmmbbb',
    'bbmddddddddmbb',
    'bbmddddddddmbb',
    'bbmdddiddddmbb',
    'bbmddddddddmbb',
    'bbmddddddddmbb',
    'bbbmmmmmmmmmbbb',
    'bbbmbbbbbbbmbbb',
    'bbbmbbbbbbbmbbb',
    'bbbmbbbbbbbmbbb',
    'bbbmbbbbbbbmbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.ENGINE]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbiDDDDDDDDDibb',
    'bbiDbbbbbbbDibb',
    'bbiDbbaaabbDibb',
    'bbiDbaaAaabDibb',
    'bbiDbaaAaabDibb',
    'bbiDbaaAaabDibb',
    'bbiDbaaAaabDibb',
    'bbiDbaaAaabDibb',
    'bbiDbbaaabbDibb',
    'bbiDbbbbbbbDibb',
    'bbiDDDDDDDDDibb',
    'bbiiiiiiiiiiibb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.REACTOR]: [
    'bbbbbbbbbbbbbbbb',
    'bbkkkkkkkkkkkkbb',
    'bbkdddddddddkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdbbrrrrbbdkbb',
    'bbkdbbrAArbdkbb',
    'bbkdbbrAArbdkbb',
    'bbkdbbrAArbdkbb',
    'bbkdbbrAArbdkbb',
    'bbkdbbrrrrbbdkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdddddddddkbb',
    'bbkkkkkkkkkkkkbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.STORAGE]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbidddddddddibbb',
    'bbidddddddddibbb',
    'bbidddmmddddibb',
    'bbiiiiiiiiiiibb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbidddddddddibbb',
    'bbidddddddddibbb',
    'bbidddmmddddibb',
    'bbiiiiiiiiiiibb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.LIFE_SUPPORT]: [
    'bbbbbbbbbbbbbbbb',
    'bbtttttttttttbb',
    'bbtTTTTTTTTTtbb',
    'bbtTbbbbbbbTtbb',
    'bbtTbbttbbbTtbb',
    'bbtTbbtbtbbTtbb',
    'bbtTbbbtbbbTtbb',
    'bbtTbbtbtbbTtbb',
    'bbtTbbttbbbTtbb',
    'bbtTbbbbbbbTtbb',
    'bbtTTTTTTTTTtbb',
    'bbtttttttttttbb',
    'bbbbbmmmmbbbbb',
    'bbbbbmbbmbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.AIRLOCK]: [
    'bbbbbbbbbbbbbbbb',
    'bbkkkkkkkkkkkkbb',
    'bbkdddddddddkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdbbkrrbbdkbb',
    'bbkdbbrRrkbdkbb',
    'bbkdbbrRrkbdkbb',
    'bbkdbbkrrbbdkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdbbbbbbbbdkbb',
    'bbkdddddddddkbb',
    'bbkkkkkkkkkkkkbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.MEDBAY]: [
    'bbbbbbbbbbbbbbbb',
    'bbttttttttttttbb',
    'bbtTTTTTTTTTtbb',
    'bbtTbbbbbbTTtbb',
    'bbtTbbtttbTTtbb',
    'bbtTbbtttbTTtbb',
    'bbtTttttttTTtbb',
    'bbtTbbtttbTTtbb',
    'bbtTbbtttbTTtbb',
    'bbtTbbbbbbTTtbb',
    'bbtTTTTTTTTTtbb',
    'bbttttttttttttbb',
    'bbbmmmmmmmmmbbb',
    'bbbmbbbbbbmbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.CRASH_COUCH]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbirkkkkkkkrib',
    'bbirRRRRRRkrib',
    'bbirRRRRRRkrib',
    'bbirRRRRRRkrib',
    'bbirRRRRRRkrib',
    'bbirRRRRRRkrib',
    'bbirRRRRRRkrib',
    'bbirkkkkkkkrib',
    'bbirrrrrrrrribb',
    'bbirkkkkkkkrib',
    'bbirRRRRRRkrib',
    'bbiiiiiiiiiiibb',
    'bbibbbbbbbbbibbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.TERMINAL]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbiBBBBBBBBBibb',
    'bbiBBtBBBBBBibb',
    'bbiBBBBBtBBBibb',
    'bbiBBBBBBBBBibb',
    'bbiBBtBBBtBBibb',
    'bbiBBBBBBBBBibb',
    'bbiiiiiiiiiiibb',
    'bbbbiiiiiibbbbb',
    'bbbbibbbbibbbbb',
    'bbbbibbbbibbbbb',
    'bbbbiiiiiibbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
  [TileType.EVA_LOCKER]: [
    'bbbbbbbbbbbbbbbb',
    'bbiiiiiiiiiiibb',
    'bbimmmmmmmmmibb',
    'bbimuuuuuuumibb',
    'bbimuuUUuuumibb',
    'bbimuuUUuuumibb',
    'bbimuuuuuuumibb',
    'bbimmmmmmmmmibb',
    'bbimuuuuuuumibb',
    'bbimuuUUuuumibb',
    'bbimuuUUuuumibb',
    'bbimuuuuuuumibb',
    'bbimmmmmmmmmibb',
    'bbiiiiiiiiiiibb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
};


export function renderTile(type, x, y, ctx) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${x * TILE_SIZE}, ${y * TILE_SIZE})`);
  g.setAttribute('shape-rendering', 'crispEdges');

  // Tooltip for furniture tiles
  const tileName = TILE_NAMES[type];
  if (tileName) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = tileName;
    g.appendChild(title);
  }

  // Make interactive tiles show pointer cursor
  if (INTERACTIVE_TILES.has(type)) {
    g.setAttribute('class', 'tile-interactive');
    g.setAttribute('data-tile-type', type);
  }

  const pattern = TILE_PATTERNS[type];
  if (pattern) {
    g.innerHTML = sprite(pattern, TP, PX);
    // Re-insert title since innerHTML wipes it
    if (tileName) {
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = tileName;
      g.insertBefore(title, g.firstChild);
    }
  } else {
    // EMPTY
    g.innerHTML = '';
  }

  // Add animations for specific tiles
  if (type === TileType.CONSOLE || type === TileType.NAV_CONSOLE) {
    // Screen flicker
    const flicker = document.createElementNS(SVG_NS, 'rect');
    flicker.setAttribute('x', 4 * PX);
    flicker.setAttribute('y', 3 * PX);
    flicker.setAttribute('width', 8 * PX);
    flicker.setAttribute('height', 1 * PX);
    flicker.setAttribute('fill', type === TileType.NAV_CONSOLE ? C.tealLt : C.teal);
    flicker.setAttribute('opacity', '0');
    flicker.innerHTML = `<animate attributeName="opacity" values="0;0.4;0;0;0;0;0;0;0;0.3;0" dur="4s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${3*PX};${4*PX};${5*PX};${6*PX};${7*PX};${3*PX}" dur="3s" repeatCount="indefinite"/>`;
    g.appendChild(flicker);
  }

  if (type === TileType.ENGINE) {
    // Engine rotation shimmer
    const shimmer = document.createElementNS(SVG_NS, 'rect');
    shimmer.setAttribute('x', 7 * PX);
    shimmer.setAttribute('y', 5 * PX);
    shimmer.setAttribute('width', 2 * PX);
    shimmer.setAttribute('height', 2 * PX);
    shimmer.setAttribute('fill', C.amberLt);
    shimmer.setAttribute('opacity', '0.3');
    shimmer.innerHTML = `<animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.5s" repeatCount="indefinite"/>`;
    g.appendChild(shimmer);
  }

  if (type === TileType.REACTOR) {
    // Reactor pulse
    const pulse = document.createElementNS(SVG_NS, 'rect');
    pulse.setAttribute('x', 6 * PX);
    pulse.setAttribute('y', 5 * PX);
    pulse.setAttribute('width', 4 * PX);
    pulse.setAttribute('height', 4 * PX);
    pulse.setAttribute('fill', C.amberLt);
    pulse.setAttribute('opacity', '0');
    pulse.innerHTML = `<animate attributeName="opacity" values="0;0.3;0" dur="2s" repeatCount="indefinite"/>`;
    g.appendChild(pulse);
  }

  if (type === TileType.DOOR) {
    // Door light blink
    const light = document.createElementNS(SVG_NS, 'rect');
    light.setAttribute('x', 7 * PX);
    light.setAttribute('y', 7 * PX);
    light.setAttribute('width', 2 * PX);
    light.setAttribute('height', 1 * PX);
    light.setAttribute('fill', C.tealLt);
    light.setAttribute('opacity', '0.5');
    light.innerHTML = `<animate attributeName="opacity" values="0.3;0.8;0.3" dur="3s" repeatCount="indefinite"/>`;
    g.appendChild(light);
  }

  if (type === TileType.AIRLOCK) {
    // Warning blink
    const warn = document.createElementNS(SVG_NS, 'rect');
    warn.setAttribute('x', 7 * PX);
    warn.setAttribute('y', 6 * PX);
    warn.setAttribute('width', 2 * PX);
    warn.setAttribute('height', 2 * PX);
    warn.setAttribute('fill', C.redLt);
    warn.setAttribute('opacity', '0');
    warn.innerHTML = `<animate attributeName="opacity" values="0;0.6;0;0;0;0" dur="2s" repeatCount="indefinite"/>`;
    g.appendChild(warn);
  }

  if (type === TileType.LIFE_SUPPORT) {
    // Wave animation
    const wave = document.createElementNS(SVG_NS, 'rect');
    wave.setAttribute('x', 5 * PX);
    wave.setAttribute('y', 6 * PX);
    wave.setAttribute('width', 1 * PX);
    wave.setAttribute('height', 1 * PX);
    wave.setAttribute('fill', C.tealLt);
    wave.setAttribute('opacity', '0.4');
    wave.innerHTML = `<animate attributeName="x" values="${5*PX};${6*PX};${7*PX};${8*PX};${9*PX};${5*PX}" dur="2s" repeatCount="indefinite"/>`;
    g.appendChild(wave);
  }

  return g;
}


// ==== 8-BIT CREW MEMBER SPRITES ====

// Each crew member is a unique 16x16 pixel art character
// Different hair, skin, uniform colors per role

const CREW_DEFS = [
  { // Captain — teal uniform, dark hair, skin1
    hair: C.hair4, skin: C.skin1, skinDk: C.skin1dk,
    uniform: C.teal, uniformDk: C.tealDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Pilot — teal uniform, blonde hair, skin3
    hair: C.hair2, skin: C.skin3, skinDk: C.skin3dk,
    uniform: C.teal, uniformDk: C.tealDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Engineer — amber uniform, red hair, skin1
    hair: C.hair3, skin: C.skin1, skinDk: C.skin1dk,
    uniform: C.amber, uniformDk: C.amberDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Medic — green uniform, grey hair, skin2
    hair: C.hair5, skin: C.skin2, skinDk: C.skin2dk,
    uniform: C.green, uniformDk: C.greenDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Gunner — red uniform, black hair, skin4
    hair: C.hair4, skin: C.skin4, skinDk: C.skin4dk,
    uniform: C.red, uniformDk: C.redDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Mechanic — amber uniform, brown hair, skin2
    hair: C.hair1, skin: C.skin2, skinDk: C.skin2dk,
    uniform: C.amber, uniformDk: C.amberDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Scientist — blue uniform, blonde, skin3
    hair: C.hair2, skin: C.skin3, skinDk: C.skin3dk,
    uniform: C.blue, uniformDk: C.blueDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
  { // Cook — purple uniform, amber hair, skin1
    hair: C.hair6, skin: C.skin1, skinDk: C.skin1dk,
    uniform: C.purple, uniformDk: C.purpleDk, boots: C.hullDk,
    eye: C.white, pupil: C.bgDk,
  },
];

function buildCrewSprite(def) {
  // h=hair, s=skin, d=skinDk, u=uniform, U=uniformDk, B=boots, e=eye, p=pupil
  const pal = {
    h: def.hair, s: def.skin, d: def.skinDk,
    u: def.uniform, U: def.uniformDk, B: def.boots,
    e: def.eye, p: def.pupil, b: C.hullDk,
    E: '#3A7BD5', F: '#1E4A8A', v: '#7EC8E3', // EVA suit blue, dark blue, visor cyan
  };

  return {
    palette: pal,
    standing: [
      '................',
      '......hhhh......',
      '.....hhhhhh.....',
      '.....hssehs.....',
      '.....hssehs.....',
      '......ssss......',
      '......sdds......',
      '.....uuuuuu.....',
      '.....uuUUuu.....',
      '.....uuUUuu.....',
      '.....uuUUuu.....',
      '.....uuUUuu.....',
      '......uuuu......',
      '......BBBB......',
      '......B..B......',
      '......B..B......',
    ],
    // Zero-G: arms spread, legs relaxed apart, slight tilt
    floating: [
      [
        '................',
        '.......hhhh.....',
        '......hhhhhh....',
        '......hssehs....',
        '......hssehs....',
        '.......ssss.....',
        '.......sdds.....',
        '...suuuuuuuus...',
        '..ss.uuUUuu.ss..',
        '.s...uuUUuu...s.',
        '.....uuUUuu.....',
        '.....uuUUuu.....',
        '......uuuu......',
        '.....B....B.....',
        '....B......B....',
        '....B......B....',
      ],
      [
        '................',
        '.......hhhh.....',
        '......hhhhhh....',
        '......hssehs....',
        '......hssehs....',
        '.......ssss.....',
        '.......sdds.....',
        '...suuuuuuuus...',
        '..ss.uuUUuu.ss..',
        '.s...uuUUuu...s.',
        '.....uuUUuu.....',
        '.....uuUUuu.....',
        '......uuuu......',
        '.....B....B.....',
        '...B........B...',
        '...B........B...',
      ],
    ],
    // Secured: crew reclined in crash couch, red gel visible around body
    secured: [
      '................',
      '................',
      '................',
      '................',
      '..kkkkkkkkkkk...',
      '..kRhhhRRRRRk...',
      '..kRhsseRRRRk...',
      '..kRhsseRRRRk...',
      '..kRRssRRRRRk...',
      '..kRuuuuuuRRk...',
      '..kRuuUUuuRRk...',
      '..kRuuUUuuRRk...',
      '..kRRuuuuRRRk...',
      '..kRRBBBBRRRk...',
      '..kkkkkkkkkkk...',
      '................',
    ],
    // In medbay: crew lying on medical bed, teal indicators
    inMedbay: [
      '................',
      '................',
      '................',
      '................',
      '..ttttttttttt...',
      '..tThhhTTTTTt...',
      '..tThsseTTTTt...',
      '..tThsseTTTTt...',
      '..tTTssTTTTTt...',
      '..tTuuuuuuTTt...',
      '..tTuuUUuuTTt...',
      '..tTuuUUuuTTt...',
      '..tTTuuuuTTTt...',
      '..tTTBBBBTTTt...',
      '..ttttttttttt...',
      '................',
    ],
    // EVA suited: crew in blue EVA suit with helmet visor
    suited: [
      '................',
      '......EEEE......',
      '.....EEEEEE.....',
      '.....EvvEEE.....',
      '.....EvvEEE.....',
      '......EEEE......',
      '......EEEE......',
      '.....EEEEEE.....',
      '.....EEFFEE.....',
      '.....EEFFEE.....',
      '.....EEFFEE.....',
      '.....EEFFEE.....',
      '......EEEE......',
      '......EEEE......',
      '......E..E......',
      '......E..E......',
    ],
    // Prone: crew member collapsed on deck, on knees/face, arms out
    // Used for: crushed under G, unconscious on floor, dead on floor
    prone: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '......hhhh......',
      '.....hhhhss.....',
      '...ssuusdds.....',
      '..ssuuUUuuuu....',
      '..s.uuUUUUuu....',
      '....uuUUUUuu....',
      '...BBuuuuuuBB...',
      '...B..BBBB..B...',
    ],
  };
}

export function renderCrewMember(x, y, memberIndex, name) {
  const def = CREW_DEFS[memberIndex % CREW_DEFS.length];
  const crewSprite = buildCrewSprite(def);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${x * TILE_SIZE}, ${y * TILE_SIZE})`);
  g.setAttribute('class', 'crew-symbol');
  g.setAttribute('shape-rendering', 'crispEdges');

  // Standing sprite (shown under thrust / gravity)
  const standingGroup = document.createElementNS(SVG_NS, 'g');
  standingGroup.setAttribute('class', 'crew-standing');
  standingGroup.innerHTML = sprite(crewSprite.standing, crewSprite.palette, PX);
  g.appendChild(standingGroup);

  // Floating sprite (shown in zero-G) — 2 frames for gentle drift
  const floatingGroup = document.createElementNS(SVG_NS, 'g');
  floatingGroup.setAttribute('class', 'crew-floating');
  floatingGroup.setAttribute('display', 'none');

  // Bob offset — each crew member floats at different phase
  const bobDur = 3 + (memberIndex % 4) * 0.5;
  const bobAmt = 2 * PX;

  // Frame A
  const floatA = document.createElementNS(SVG_NS, 'g');
  floatA.innerHTML = sprite(crewSprite.floating[0], crewSprite.palette, PX);
  const animA = document.createElementNS(SVG_NS, 'animate');
  animA.setAttribute('attributeName', 'display');
  animA.setAttribute('values', 'inline;inline;none;none');
  animA.setAttribute('keyTimes', '0;0.499;0.5;1');
  animA.setAttribute('dur', `${bobDur}s`);
  animA.setAttribute('calcMode', 'discrete');
  animA.setAttribute('repeatCount', 'indefinite');
  floatA.appendChild(animA);
  floatingGroup.appendChild(floatA);

  // Frame B (legs slightly different)
  const floatB = document.createElementNS(SVG_NS, 'g');
  floatB.setAttribute('display', 'none');
  floatB.innerHTML = sprite(crewSprite.floating[1], crewSprite.palette, PX);
  const animB = document.createElementNS(SVG_NS, 'animate');
  animB.setAttribute('attributeName', 'display');
  animB.setAttribute('values', 'none;none;inline;inline');
  animB.setAttribute('keyTimes', '0;0.499;0.5;1');
  animB.setAttribute('dur', `${bobDur}s`);
  animB.setAttribute('calcMode', 'discrete');
  animB.setAttribute('repeatCount', 'indefinite');
  floatB.appendChild(animB);
  floatingGroup.appendChild(floatB);

  // Vertical bob animation on the whole floating group
  const bobUp = document.createElementNS(SVG_NS, 'animateTransform');
  bobUp.setAttribute('attributeName', 'transform');
  bobUp.setAttribute('type', 'translate');
  bobUp.setAttribute('values', `0 0; 0 -${bobAmt}; 0 0; 0 ${bobAmt}; 0 0`);
  bobUp.setAttribute('dur', `${bobDur}s`);
  bobUp.setAttribute('repeatCount', 'indefinite');
  floatingGroup.appendChild(bobUp);

  g.appendChild(floatingGroup);

  // Secured in crash couch sprite
  const securedGroup = document.createElementNS(SVG_NS, 'g');
  securedGroup.setAttribute('class', 'crew-secured');
  securedGroup.setAttribute('display', 'none');
  securedGroup.innerHTML = sprite(crewSprite.secured, crewSprite.palette, PX);
  g.appendChild(securedGroup);

  // In medbay sprite
  const medbayGroup = document.createElementNS(SVG_NS, 'g');
  medbayGroup.setAttribute('class', 'crew-in-medbay');
  medbayGroup.setAttribute('display', 'none');
  medbayGroup.innerHTML = sprite(crewSprite.inMedbay, crewSprite.palette, PX);
  g.appendChild(medbayGroup);

  // EVA suited sprite (shown when crew is wearing a suit)
  const suitedGroup = document.createElementNS(SVG_NS, 'g');
  suitedGroup.setAttribute('class', 'crew-suited');
  suitedGroup.setAttribute('display', 'none');
  suitedGroup.innerHTML = sprite(crewSprite.suited, crewSprite.palette, PX);
  g.appendChild(suitedGroup);

  // Prone sprite (shown under dangerous G without crash couch — with shake)
  const proneGroup = document.createElementNS(SVG_NS, 'g');
  proneGroup.setAttribute('class', 'crew-prone');
  proneGroup.setAttribute('display', 'none');
  proneGroup.innerHTML = sprite(crewSprite.prone, crewSprite.palette, PX);
  // Subtle shake animation to convey strain
  const proneShake = document.createElementNS(SVG_NS, 'animateTransform');
  proneShake.setAttribute('attributeName', 'transform');
  proneShake.setAttribute('type', 'translate');
  proneShake.setAttribute('values', '0 0; 1 0; -1 0; 0 1; 0 0');
  proneShake.setAttribute('dur', '0.3s');
  proneShake.setAttribute('repeatCount', 'indefinite');
  proneGroup.appendChild(proneShake);
  g.appendChild(proneGroup);

  // Unconscious on floor (same prone sprite, no shake — still/limp)
  const unconsciousFloorGroup = document.createElementNS(SVG_NS, 'g');
  unconsciousFloorGroup.setAttribute('class', 'crew-unconscious-floor');
  unconsciousFloorGroup.setAttribute('display', 'none');
  unconsciousFloorGroup.innerHTML = sprite(crewSprite.prone, crewSprite.palette, PX);
  g.appendChild(unconsciousFloorGroup);

  // Unconscious/dead floating in zero-G (prone sprite with bob, no shake)
  const unconsciousFloatGroup = document.createElementNS(SVG_NS, 'g');
  unconsciousFloatGroup.setAttribute('class', 'crew-unconscious-float');
  unconsciousFloatGroup.setAttribute('display', 'none');
  unconsciousFloatGroup.innerHTML = sprite(crewSprite.prone, crewSprite.palette, PX);
  // Slow tumble/bob for limp body floating
  const limpBobDur = 5 + (memberIndex % 3);
  const limpBob = document.createElementNS(SVG_NS, 'animateTransform');
  limpBob.setAttribute('attributeName', 'transform');
  limpBob.setAttribute('type', 'translate');
  limpBob.setAttribute('values', `0 0; 0 -${bobAmt}; 0 0; 0 ${bobAmt * 0.5}; 0 0`);
  limpBob.setAttribute('dur', `${limpBobDur}s`);
  limpBob.setAttribute('repeatCount', 'indefinite');
  unconsciousFloatGroup.appendChild(limpBob);
  // Slow rotation for drifting feel
  const limpRotate = document.createElementNS(SVG_NS, 'animateTransform');
  limpRotate.setAttribute('attributeName', 'transform');
  limpRotate.setAttribute('type', 'rotate');
  limpRotate.setAttribute('values', '0 16 16; 8 16 16; 0 16 16; -5 16 16; 0 16 16');
  limpRotate.setAttribute('dur', `${limpBobDur * 1.3}s`);
  limpRotate.setAttribute('repeatCount', 'indefinite');
  limpRotate.setAttribute('additive', 'sum');
  unconsciousFloatGroup.appendChild(limpRotate);
  g.appendChild(unconsciousFloatGroup);

  // Eye blink (works for both states)
  const blink = document.createElementNS(SVG_NS, 'g');
  blink.setAttribute('class', 'crew-blink');
  // Blink covers eyes for standing (row 3, cols 5 and 8)
  // and floating (row 3, cols 6 and 9 — shifted right by 1)
  blink.innerHTML = `
    <g class="blink-standing">
      <rect x="${5*PX}" y="${3*PX}" width="${PX}" height="${PX}" fill="${def.skin}"/>
      <rect x="${8*PX}" y="${3*PX}" width="${PX}" height="${PX}" fill="${def.skin}"/>
    </g>
    <g class="blink-floating" display="none">
      <rect x="${6*PX}" y="${3*PX}" width="${PX}" height="${PX}" fill="${def.skin}"/>
      <rect x="${9*PX}" y="${3*PX}" width="${PX}" height="${PX}" fill="${def.skin}"/>
    </g>
  `;
  blink.setAttribute('opacity', '0');
  const blinkAnim = document.createElementNS(SVG_NS, 'animate');
  blinkAnim.setAttribute('attributeName', 'opacity');
  blinkAnim.setAttribute('values', '0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;1;0');
  blinkAnim.setAttribute('dur', '4s');
  blinkAnim.setAttribute('begin', `${memberIndex * 0.7}s`);
  blinkAnim.setAttribute('repeatCount', 'indefinite');
  blink.appendChild(blinkAnim);
  g.appendChild(blink);

  // Tooltip
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = name;
  g.appendChild(title);

  return g;
}

// Set crew visual state based on physics state + consciousness/dead
// crewMembers: array of crew objects (for checking consciousness/dead)
export function setCrewGravity(container, hasGravity, crewStates = null, crewMembers = null) {
  container.querySelectorAll('.crew-symbol').forEach(crew => {
    const crewId = crew.getAttribute('data-crew-id');
    const standing = crew.querySelector('.crew-standing');
    const floating = crew.querySelector('.crew-floating');
    const prone = crew.querySelector('.crew-prone');
    const unconsciousFloor = crew.querySelector('.crew-unconscious-floor');
    const unconsciousFloat = crew.querySelector('.crew-unconscious-float');
    const blinkStanding = crew.querySelector('.blink-standing');
    const blinkFloating = crew.querySelector('.blink-floating');
    const blink = crew.querySelector('.crew-blink');

    // Find crew member data
    const member = crewMembers && crewId !== null
      ? crewMembers.find(m => String(m.id) === String(crewId))
      : null;

    const isDead = member && member.dead;
    const isUnconscious = member && (member.consciousness <= 10 || member.dead);
    const inCrashCouch = member && member._inCrashCouch;
    const inMedbayBed = member && member._inMedbay;
    const inSuit = member && member._inSuit;

    // Determine physics state
    let state;
    if (crewStates && crewId !== null && crewStates[crewId]) {
      state = crewStates[crewId];
    } else {
      state = hasGravity ? 'standing' : 'floating';
    }

    const inGravity = state !== 'floating';

    // Determine which sprite to show
    let showStanding = false, showFloating = false, showProne = false;
    let showUnconsciousFloor = false, showUnconsciousFloat = false;
    let showSecured = false, showInMedbay = false, showSuited = false;

    const isCrushed = member && member.conditions && member.conditions.includes('crushed');

    if (isUnconscious || isDead) {
      if (inGravity) {
        showUnconsciousFloor = true;
      } else {
        showUnconsciousFloat = true;
      }
    } else if (inMedbayBed) {
      showInMedbay = true;
    } else if (inCrashCouch) {
      showSecured = true;
    } else if (isCrushed || state === 'prone') {
      showProne = true;
    } else if (inSuit) {
      showSuited = true;
    } else if (state === 'floating') {
      showFloating = true;
    } else {
      showStanding = true;
    }

    const secured = crew.querySelector('.crew-secured');
    const medbaySprite = crew.querySelector('.crew-in-medbay');
    const suited = crew.querySelector('.crew-suited');

    if (standing) standing.setAttribute('display', showStanding ? 'inline' : 'none');
    if (floating) floating.setAttribute('display', showFloating ? 'inline' : 'none');
    if (prone) prone.setAttribute('display', showProne ? 'inline' : 'none');
    if (unconsciousFloor) unconsciousFloor.setAttribute('display', showUnconsciousFloor ? 'inline' : 'none');
    if (unconsciousFloat) unconsciousFloat.setAttribute('display', showUnconsciousFloat ? 'inline' : 'none');
    if (secured) secured.setAttribute('display', showSecured ? 'inline' : 'none');
    if (medbaySprite) medbaySprite.setAttribute('display', showInMedbay ? 'inline' : 'none');
    if (suited) suited.setAttribute('display', showSuited ? 'inline' : 'none');
    if (blinkStanding) blinkStanding.setAttribute('display', showStanding ? 'inline' : 'none');
    if (blinkFloating) blinkFloating.setAttribute('display', showFloating ? 'inline' : 'none');
    // Blink only when standing, floating, secured, or in medbay (not prone/unconscious/dead/suited)
    if (blink) blink.setAttribute('display', (showStanding || showFloating || showSecured || showInMedbay) ? 'inline' : 'none');
  });
}


// ==== STARFIELD (8-bit style — square star pixels) ====

export function createStarfield(container, count = 150) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const svgEl = svg(w, h, `0 0 ${w} ${h}`, '', 'starfield-svg');
  svgEl.style.position = 'absolute';
  svgEl.style.inset = '0';
  svgEl.style.width = '100%';
  svgEl.style.height = '100%';

  for (let i = 0; i < count; i++) {
    // Snap to a grid for pixel-art feel
    const gridSize = 4;
    const cx = Math.floor(Math.random() * (w / gridSize)) * gridSize;
    const cy = Math.floor(Math.random() * (h / gridSize)) * gridSize;
    const size = Math.random() > 0.9 ? gridSize : (Math.random() > 0.7 ? gridSize / 2 : gridSize / 4);
    const dur = (Math.random() * 4 + 2).toFixed(1);
    const delay = (Math.random() * 5).toFixed(1);

    let color = C.white;
    if (Math.random() > 0.95) color = C.teal;
    else if (Math.random() > 0.93) color = C.amber;
    else if (Math.random() > 0.9) color = C.blue;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', cx);
    rect.setAttribute('y', cy);
    rect.setAttribute('width', size);
    rect.setAttribute('height', size);
    rect.setAttribute('fill', color);
    rect.setAttribute('opacity', (Math.random() * 0.5 + 0.2).toFixed(2));
    rect.innerHTML = `<animate attributeName="opacity"
      values="${(Math.random() * 0.2 + 0.1).toFixed(2)};${(Math.random() * 0.4 + 0.5).toFixed(2)};${(Math.random() * 0.2 + 0.1).toFixed(2)}"
      dur="${dur}s" begin="${delay}s" repeatCount="indefinite"/>`;
    svgEl.appendChild(rect);
  }

  container.appendChild(svgEl);
}
