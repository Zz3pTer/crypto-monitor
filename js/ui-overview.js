// Overview screen (spec 5.2, FR-UI-01..03): summary strip, filter/sort bar
// and one card per coin. Works for any number of coins from 1 to 30.
import * as fmt from "./format.js";

const esc = fmt.escape;

// "?" icon placed after every indicator name (FR-HELP-01). The pop-up is wired up in tooltip.js.
export function help(key, sym = "") {
  return `<button type="button" class="help" data-help="${esc(key)}" data-sym="${esc(sym)}" aria-label="What is ${esc(key)}?" aria-expanded="false">?</button>`;
}

export function mountOverview(view, handlers) {
  view.innerHTML = `
    <section class="summary" aria-label="Summary">
      <button class="tile count buy" data-filter="BUY"><div class="label">BUY signals</div><div class="value num" id="n-buy">–</div></button>
      <button class="tile count hold" data-filter="HOLD"><div class="label">HOLD signals</div><div class="value num" id="n-hold">–</div></button>
      <button class="tile count sell" data-filter="SELL"><div class="label">SELL signals</div><div class="value num" id="n-sell">–</div></button>
      <div class="tile wide"><div class="label">Next Telegram report</div><div class="value" id="next-report">–</div></div>
      <div class="tile wide"><div class="label">Data feed</div><div class="feed" id="feed"><span class="dot"></span><span>Connecting…</span></div></div>
    </section>
    <section class="toolbar" aria-label="Filter and sort">
      <div class="tabs" role="tablist" aria-label="Filter by signal">
        <button class="tab" role="tab" data-tab="ALL" id="tab-all">All</button>
        <button class="tab" role="tab" data-tab="BUY">BUY</button>
        <button class="tab" role="tab" data-tab="HOLD">HOLD</button>
        <button class="tab" role="tab" data-tab="SELL">SELL</button>
      </div>
      <div class="spacer"></div>
      <select class="btn" id="sort" aria-label="Sort">
        <option value="score">Sort: Score (high→low)</option>
        <option value="change">Sort: 24h change (high→low)</option>
        <option value="name">Sort: Name (A→Z)</option>
        <option value="custom">Sort: My order (Settings)</option>
      </select>
      <input class="btn search" id="search" type="search" placeholder="Filter my coins…" aria-label="Filter the coins shown" autocomplete="off">
      <button class="btn primary" id="add-coin" title="Search all coins on Binance and add one">+ Add coin</button>
    </section>
    <section class="grid" id="grid" aria-label="Coins"></section>`;

  view.querySelectorAll("[data-filter]").forEach((el) => el.addEventListener("click", () => handlers.onFilter(el.dataset.filter)));
  view.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => handlers.onFilter(el.dataset.tab)));
  view.querySelector("#sort").addEventListener("change", (e) => handlers.onSort(e.target.value));
  view.querySelector("#search").addEventListener("input", (e) => handlers.onSearch(e.target.value));
  view.querySelector("#add-coin").addEventListener("click", () => handlers.onAdd());
  view.querySelector("#grid").addEventListener("click", (e) => {
    if (e.target.closest(".help")) return;            // the "?" opens its pop-up, not the card
    const card = e.target.closest(".card[data-sym]");
    if (card) handlers.onOpen(card.dataset.sym);
  });
  view.querySelector("#grid").addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".card[data-sym]");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handlers.onOpen(card.dataset.sym); }
  });
}

export function renderSkeleton(view, n) {
  const grid = view.querySelector("#grid");
  grid.innerHTML = Array.from({ length: n }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="sk" style="height:22px;width:45%"></div>
      <div class="sk" style="height:56px"></div>
      <div class="sk" style="height:14px"></div>
      <div class="sk" style="height:14px;width:80%"></div>
    </div>`).join("");
}

export function sparkline(hourly) {
  const pts = hourly.map((c) => c.close);
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 100 40"></svg>`;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * 100, 38 - ((p - min) / span) * 34]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const up = pts.at(-1) >= pts[0];
  const stroke = up ? "var(--buy)" : "var(--sell)";
  const fill = up ? "var(--spark-up)" : "var(--spark-down)";
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="7-day price ${up ? "up" : "down"}">
    <path d="${line}L100,40L0,40Z" fill="${fill}"/>
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

function scoreBar(score, th) {
  const pos = (v) => ((v + 100) / 200) * 100;
  const sellW = pos(th.sell), holdW = pos(th.buy) - pos(th.sell), buyW = 100 - pos(th.buy);
  const marker = score === null ? "" : `<span class="marker" style="left:${pos(Math.max(-100, Math.min(100, score)))}%"></span>`;
  return `<div class="scorebar" aria-hidden="true">
      <span class="z sell" style="width:${sellW}%"></span><span class="z hold" style="width:${holdW}%"></span><span class="z buy" style="width:${buyW}%"></span>${marker}
    </div><div class="scale num" aria-hidden="true"><span>-100</span><span>0</span><span>+100</span></div>`;
}

export function card(m, th, flash) {
  const sym = esc(m.symbol);
  if (m.unavailable) {
    return `<article class="card" data-sym="${sym}" tabindex="0" aria-label="${sym}: data unavailable">
      <div class="card-top"><span class="sym">${sym}</span><span class="name">${esc(m.name)}</span>
        <span class="badges"><span class="badge none">N/A</span></span></div>
      <div class="unavailable">Data unavailable — "${esc(m.pair)}" did not load from Binance.</div></article>`;
  }
  const t = m.ticker;
  const up = t && t.changePct >= 0;
  const badge = m.signal
    ? `<span class="badge ${m.signal}${m.strong ? " strong" : ""}">${m.strong ? "STRONG " : ""}${m.signal}</span>`
    : `<span class="badge none">—</span>`;
  const tags = [
    m.local ? `<span class="tag" title="Added in this browser only: not in the Telegram report">my view</span>` : "",
    m.stale ? `<span class="tag stale">stale</span>` : "",
    m.liveDiffers ? `<span class="tag live-diff" title="Provisional signal on today's open candle">Live: ${m.live.signal} ${fmt.signed(m.live.score)}</span>` : "",
    m.source === "provisional" ? `<span class="tag" title="No official signal yet: shown from today's open candle">provisional</span>` : "",
    m.source === "insufficient" ? `<span class="tag">Not enough history</span>` : "",
  ].join("");
  const ind = m.live?.indicators;
  const votes = m.live?.votes;
  const macdArrow = votes ? (ind.macd > ind.macd_signal ? `<span class="up" aria-label="above signal">▲</span>` : `<span class="down" aria-label="below signal">▼</span>`) : "—";
  const smaWord = ind && ind.sma200 !== null ? (m.livePrice > ind.sma200 ? "above" : "below") : "—";
  return `<article class="card${m.stale ? " stale" : ""}" data-sym="${sym}" tabindex="0" aria-label="${sym} ${esc(m.name)}, ${m.signal ?? "no signal"}">
    <div class="card-top">
      <span class="sym">${sym}</span><span class="name">${esc(m.name)}</span>
      <span class="badges">${tags}${badge}</span>
    </div>
    <div class="card-mid">
      <div>
        <div class="price num${flash ? ` flash-${flash}` : ""}">${fmt.price(m.livePrice)}</div>
        <div class="change num ${t ? (up ? "up" : "down") : ""}">${t ? `${up ? "▲" : "▼"} ${fmt.pct(t.changePct)}` : "—"} <span class="muted">24h</span></div>
      </div>
      ${sparkline(m.hourly)}
    </div>
    <div>
      <div class="score-head">
        <span class="label">Signal score ${help("Signal score", m.symbol)}</span>
        <span class="score-val num ${m.signal ?? ""}">${m.score === null ? "—" : fmt.signed(m.score)}</span>
      </div>
      ${scoreBar(m.score, th)}
    </div>
    <div class="ind-line">
      <span class="item">RSI ${help("RSI", m.symbol)} <span class="v num">${ind?.rsi14 != null ? Math.round(ind.rsi14) : "—"}</span></span>
      <span aria-hidden="true">·</span>
      <span class="item">MACD ${help("MACD", m.symbol)} ${macdArrow}</span>
      <span aria-hidden="true">·</span>
      <span class="item">SMA 200 ${help("SMA 200", m.symbol)} <span class="v">${smaWord}</span></span>
      <a class="details" href="#/asset/${sym}">Details ›</a>
    </div>
  </article>`;
}

export function renderCards(view, models, th, flashes) {
  const grid = view.querySelector("#grid");
  // Keep keyboard focus on the same card across repaints.
  const focused = document.activeElement?.closest?.(".card[data-sym]")?.dataset.sym;
  grid.innerHTML = models.length
    ? models.map((m) => card(m, th, flashes.get(m.symbol))).join("")
    : `<div class="empty">No coins match this filter.</div>`;
  if (focused) grid.querySelector(`.card[data-sym="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

export function renderSummary(view, { counts, total, filter, sort, nextReport, feed }) {
  view.querySelector("#n-buy").textContent = counts.BUY;
  view.querySelector("#n-hold").textContent = counts.HOLD;
  view.querySelector("#n-sell").textContent = counts.SELL;
  view.querySelector("#next-report").textContent = nextReport;
  view.querySelector("#tab-all").textContent = `All (${total})`;
  view.querySelectorAll("[data-tab]").forEach((el) => el.setAttribute("aria-selected", String(el.dataset.tab === filter)));
  view.querySelector("#sort").value = sort;
  view.querySelector("#feed").innerHTML = `<span class="dot ${feed.cls}"></span><span>${esc(feed.text)}</span>`;
}
