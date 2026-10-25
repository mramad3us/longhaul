// ============================================================
// LONGHAUL — Trade: a market's board, and every market we hear of
//
// The MARKET tab of a station's window (marketHTML): every good its market
// deals in, what it pays and asks (and against the good's base price: dear
// is red, cheap green), how its stock stands, whether it makes or wants
// the good, what we hold of it and what we paid; BUY and SELL by the
// tonne, by ten, or as much as we can (docked: goods cross a berth's
// collar; by radio the board is read, not dealt on). A licensed captain at
// its own power's port turns contraband over here (law.js).
//
// The MARKETS window (P: toggleMarkets): every market's prices as we know
// them, a light-time old (sim/market.js knownPrices), good by good, the
// cheapest and dearest marked, and our hold against them: where to buy,
// where to sell.
// ============================================================

import { ui } from './context.js';
import { $, esc, show, fmtNum } from './dom.js';
import { toast } from './toast.js';
import { logEntry } from './log.js';
import { bus } from '../core/events.js';
import { formatDuration } from '../core/clock.js';
import { GOODS, GOOD_IDS, tonnes } from '../sim/goods.js';
import {
  MARKETS, MARKET_IDS, marketName, isOpen, priceAt, priceIndex, quote, targetOf, marketHere, heldOf, holdLoad, holdRoom,
  tradeRefusal, buyGood, sellGood, knownPrices, SPREAD,
} from '../sim/market.js';
import { turnOverHere, turnOverContraband } from '../sim/law.js';

const emit = (t, p) => bus.emit(t, p);

/** A price against its base, in words and colour: ▲ dear, ▼ cheap. */
function vsBase(ix) {
  const pc = Math.round((ix - 1) * 100);
  if (Math.abs(pc) < 4) return '<span class="mkt-even">at base</span>';
  return pc > 0 ? `<span class="mkt-dear">▲ ${pc}%</span>` : `<span class="mkt-cheap">▼ ${-pc}%</span>`;
}
/** How a market's stock of a good stands (its fullness against its target). */
function stockWords(f) {
  return f < 0.25 ? '<span class="mkt-dear">scarce</span>' : f < 0.7 ? 'short' : f < 1.4 ? 'steady' : f < 2.2 ? 'plenty' : '<span class="mkt-cheap">glut</span>';
}
const mcr = (x) => `${fmtNum(Math.round(x))}`;

/** What we hold of a good, and what it cost us a tonne. */
function ourLot(s, g) {
  const items = s.cargo.filter(x => x.good === g && !x.contract);
  const t = items.reduce((a, x) => a + x.mass, 0) / 1000;
  if (t <= 0.004) return null;
  const cost = items.reduce((a, x) => a + (x.cost || 0), 0);
  const stolen = items.some(x => x.stolen), seized = items.some(x => x.seized);
  return { t, per: cost > 0 ? cost / t : null, stolen, seized };
}

/** The MARKET tab of a station's window. */
export function marketHTML(s, st) {
  const id = st.id;
  if (!MARKETS[id] || !isOpen(id)) return `<div class="station-mission-empty">${esc(st.name)} has no market for passing ships.</div>`;
  const here = marketHere(s) === id;
  const m = MARKETS[id];
  const turn = here ? turnOverHere(s) : null;
  const rows = GOOD_IDS.filter(g => !tradeRefusal(s, id, g, 'sell') || ourLot(s, g)).map(g => {
    const G = GOODS[g], p = priceAt(s, id, g), f = s.market.nodes[id].stock[g] / targetOf(id, g);
    const lot = ourLot(s, g);
    const noBuy = tradeRefusal(s, id, g, 'buy'), noSell = tradeRefusal(s, id, g, 'sell');
    const tag = m.make[g] ? '<span class="mkt-tag made">MADE HERE</span>' : m.want[g] ? '<span class="mkt-tag wanted">WANTED</span>' : '';
    const stock = s.market.nodes[id].stock[g];
    const btn = (act, t, label, no) => `<button class="mkt-btn" data-act="${act}" data-good="${g}" data-t="${t}" ${no || !here ? `disabled title="${esc(no || 'Dock to trade: goods cross a berth\'s collar')}"` : ''}>${label}</button>`;
    return `<div class="mkt-row" title="${esc(G.desc)}">
      <span class="mkt-good">${esc(G.name)} ${tag}</span>
      <span class="mkt-price"><b>${mcr(p * (1 + SPREAD))}</b> / ${mcr(p * (1 - SPREAD))}<small>${vsBase(p / G.base)}</small></span>
      <span class="mkt-stock">${stockWords(f)}<small>${tonnes(stock)}</small></span>
      <span class="mkt-ours">${lot ? `${tonnes(lot.t)}<small>${lot.per ? `paid ${mcr(lot.per)}` : lot.seized ? 'taken' : ''}${lot.stolen ? ' · <span class="mkt-dear">stolen</span>' : ''}</small>` : '—'}</span>
      <span class="mkt-acts"><span>${noBuy ? `<span class="mkt-no" title="${esc(noBuy)}">not sold to us</span>` : `${btn('mkt-buy', 1, 'BUY 1')}${btn('mkt-buy', 10, '10')}${btn('mkt-buy', 'max', 'MAX')}`}</span>
        ${lot && !noSell ? `<span>${btn('mkt-sell', 1, 'SELL 1')}${btn('mkt-sell', 10, '10')}${btn('mkt-sell', 'all', 'ALL')}</span>` : ''}</span>
    </div>`;
  }).join('');
  return `<div class="mkt">
    <div class="mkt-top"><span>HOLD <b>${tonnes(holdLoad(s) / 1000)}</b> of ${tonnes(s.cargoCapacity / 1000)}</span><span>CREDITS <b>${fmtNum(Math.round(s.resources.credits.current))} MCR</b></span>
      <span class="mkt-note">${here ? 'Docked: buy and sell across the collar.' : 'By radio: the board is read here, dealt on docked.'} Prices MCR a tonne, we pay / we are paid.</span>
      <button class="mkt-btn" data-act="mkt-all">ALL MARKETS (P)</button></div>
    ${turn ? `<div class="mkt-turn"><span>Contraband aboard: ${turn.items.map(c => `${tonnes(c.mass / 1000)} ${esc(c.name.toLowerCase())}`).join(', ')}. A licensed captain turns it over here, for reputation and standing.</span><button class="station-mission-accept" data-act="mkt-turn">TURN IT OVER</button></div>` : ''}
    <div class="mkt-head"><span>GOOD</span><span>PRICE · VS BASE</span><span>STOCK</span><span>OURS</span><span></span></div>
    ${rows}
  </div>`;
}

/** A click on the MARKET tab (dialogs.js routes `mkt-*` here). Returns whether it was ours. */
export function onMarketAction(s, st, b) {
  const act = b.dataset.act;
  if (!act?.startsWith('mkt-')) return false;
  if (act === 'mkt-all') { openMarkets(); return true; }
  if (act === 'mkt-turn') { const r = turnOverContraband(s, emit); toast(r.text, r.ok ? 'ok' : 'warn'); if (r.ok) logEntry(r.text, 'ok'); return true; }
  const g = b.dataset.good, raw = b.dataset.t;
  if (act === 'mkt-buy') {
    const t = raw === 'max' ? Infinity : +raw;
    const r = buyGood(s, st.id, g, t);
    toast(r.text, r.ok ? 'ok' : 'warn');
    if (r.ok) logEntry(r.text, 'system');
  } else if (act === 'mkt-sell') {
    const t = raw === 'all' ? Infinity : +raw;
    const r = sellGood(s, st.id, g, t);
    toast(r.text, r.ok ? 'ok' : 'warn');
    if (r.ok) logEntry(r.text, 'system');
  }
  return true;
}

// ---- THE MARKETS WINDOW ----

let marketsOpen = false;

export function initMarkets() {
  const ov = $('#dialog-markets');
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closeMarkets(); });
  ov.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) closeMarkets(); });
}
export const marketsShown = () => $('#dialog-markets').style.display !== 'none';
export function openMarkets() { show($('#dialog-markets'), true, 'flex'); renderMarkets(); }
export function closeMarkets() { if (!marketsShown()) return false; show($('#dialog-markets'), false); return true; }
export function toggleMarkets() { if (marketsShown()) closeMarkets(); else openMarkets(); }

/** Every market's prices as we know them, good by good: the cheapest and dearest marked; our hold against them. */
function renderMarkets() {
  const s = ui.state;
  if (!s?.market) return;
  const cols = MARKET_IDS.filter(isOpen);
  const known = Object.fromEntries(cols.map(id => [id, knownPrices(s, id)]));
  const age = (id) => { const k = known[id]; return k ? Math.max(0, s.clock.minute - k.at) : null; };
  const head = cols.map(id => `<th title="${esc(`${marketName(s, id)}${MARKETS[id].world ? ' (its ground: by shuttle)' : ''} · prices ${formatDuration(age(id) ?? 0)} old`)}">${esc(short(s, id))}${MARKETS[id].world ? '<small>by shuttle</small>' : ''}</th>`).join('');
  const rows = GOOD_IDS.map(g => {
    const ps = cols.map(id => !tradeRefusal(s, id, g, 'sell') && known[id] ? known[id].p[g] : null);
    const live = ps.filter(p => p != null);
    const lo = Math.min(...live), hi = Math.max(...live);
    const lot = ourLot(s, g);
    return `<tr><td class="mk-good" title="${esc(GOODS[g].desc)}">${esc(GOODS[g].name)}${lot ? `<small>${tonnes(lot.t)} aboard${lot.per ? ` @ ${mcr(lot.per)}` : ''}</small>` : ''}</td>${ps.map((p, i) => {
      if (p == null) return '<td class="mk-none">—</td>';
      const ix = p / GOODS[g].base;
      const cls = p === lo && live.length > 1 ? 'mk-lo' : p === hi && live.length > 1 ? 'mk-hi' : ix > 1.15 ? 'mk-dear' : ix < 0.87 ? 'mk-cheap' : '';
      return `<td class="${cls}">${mcr(p)}</td>`;
    }).join('')}<td class="mk-base">${mcr(GOODS[g].base)}</td></tr>`;
  }).join('');
  $('#dialog-markets-body').innerHTML = `<h3 class="dialog-title">Markets</h3>
    <p class="dialog-text">Prices in MCR a tonne, as we last heard them (a light-time old, and refreshed four times a day): green the cheapest, red the dearest. A world's ground trades by shuttle from a high orbit (G). Hold: ${tonnes(holdLoad(s) / 1000)} of ${tonnes(s.cargoCapacity / 1000)}, ${fmtNum(Math.round(s.resources.credits.current))} MCR.</p>
    <div class="mk-wrap"><table class="mk-table"><thead><tr><th></th>${head}<th>BASE</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${newsHTML(s)}
    <div class="form-actions"><button class="btn btn-secondary" data-act="close">Close</button></div>`;
}

/** A market's short name, for a column. */
function short(s, id) {
  const n = marketName(s, id);
  return n.replace(/ (Station|Depot|Ring|Yards|Shipyards)$/, '').replace('Shipyards', 'Yards');
}

/** The market news we have heard (the radio's: intel.js), the latest first. */
function newsHTML(s) {
  const items = (s.market.heard || []).slice(-6).reverse();
  return items.length ? `<div class="mk-news"><div class="missions-section">MARKET NEWS</div>${items.map(n => `<div>${esc(n.text)} <span class="scanner-val-dim">${formatDuration(Math.max(0, s.clock.minute - n.at))} ago</span></div>`).join('')}</div>` : '';
}

/** While open, follow the market (a step is every six hours: redraw on one). */
export function updateMarkets() {
  if (!marketsShown() || !ui.state?.market) return;
  const at = ui.state.market.at;
  if (at !== updateMarkets.at) { updateMarkets.at = at; renderMarkets(); }
}
