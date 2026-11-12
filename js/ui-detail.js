// Asset detail screen (spec 5.3, FR-UI-04..08, FR-HIST-02/03).
// Address: #/asset/<SYMBOL>, so it can be bookmarked.
import * as fmt from "./format.js";
import * as store from "./store.js";
import { RULES } from "./signals.js";
import { help } from "./ui-overview.js";
import { loadLibrary, OVERLAYS, PriceChart } from "./charts.js";

const esc = fmt.escape;
const TIMEFRAMES = [["1H", "1h", 500], ["4H", "4h", 500], ["1D", "1d", 500], ["1W", "1w", 300]];
const DAY_MS = 86_400_000;
const TF_RELOAD_MS = 5 * 60_000;
const PHONE = "(max-width: 767px)";

// ---------- small renderers ----------

function badge(signal, strong) {
  if (!signal) return `<span class="badge none">—</span>`;
  return `<span class="badge ${signal}${strong ? " strong" : ""}">${strong ? "STRONG " : ""}${signal}</span>`;
}

// Half-circle gauge from -100 to +100 with SELL / HOLD / BUY zones.
function gauge(score, signal, th) {
  const cx = 110, cy = 105, r = 84;
  const pt = (v, rr = r) => {
    const a = Math.PI * (1 - (v + 100) / 200);           // -100 -> left, +100 -> right
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  };
  const arc = (from, to, color) => {
    const [x1, y1] = pt(from), [x2, y2] = pt(to);
    return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${color}" stroke-width="16" fill="none"/>`;
  };
  const needle = score === null ? "" : (() => {
    const [x, y] = pt(Math.max(-100, Math.min(100, score)), r - 14);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--text)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="8" fill="var(--text)"/>`;
  })();
  return `<svg class="gauge" viewBox="0 0 220 130" role="img" aria-label="Score ${score ?? "unknown"}: ${signal ?? "no signal"}">
      ${arc(-100, th.sell, "var(--sell)")}${arc(th.sell, th.buy, "var(--hold)")}${arc(th.buy, 100, "var(--buy)")}
      ${needle}
      <text x="22" y="126" class="g-sell">SELL ≤ ${th.sell}</text>
      <text x="198" y="126" text-anchor="end" class="g-buy">BUY ≥ +${th.buy}</text>
    </svg>
    <div class="gauge-val ${signal ?? ""}"><span class="num">${score === null ? "—" : fmt.signed(score)}</span> ${signal ?? ""}</div>`;
}

function ruleRows(res, cfg) {
  const p = cfg.signal.periods, sc = cfg.signal, w = sc.weights, ind = res.indicators;
  const above = (a, b) => (a > b ? "above" : a < b ? "below" : "equal");
  const rsiWord = ind.rsi14 < sc.rsi_oversold ? "oversold" : ind.rsi14 > sc.rsi_overbought ? "overbought" : "neutral";
  const bbWord = res.close < ind.bb_lower ? "below lower band" : res.close > ind.bb_upper ? "above upper band" : "inside";
  const meta = {
    trend: [`Trend: price vs SMA ${p.sma_slow}`, "Trend (price vs SMA 200)", above(res.close, ind.sma200)],
    cross: [`SMA ${p.sma_fast} vs SMA ${p.sma_slow}`, "Trend structure (SMA 50 vs SMA 200)", above(ind.sma50, ind.sma200)],
    macd: [`MACD (${p.macd_fast},${p.macd_slow},${p.macd_signal})`, "MACD", `${ind.macd > ind.macd_signal ? "above" : "below"} signal`],
    rsi: [`RSI (${p.rsi}) = ${Math.round(ind.rsi14)}`, "RSI", rsiWord],
    bollinger: [`Bollinger (${p.bb},${p.bb_std})`, "Bollinger", bbWord],
    momentum: [`Momentum ROC(${p.roc})`, "Momentum ROC", fmt.pct(ind.roc14)],
    volume: [`Volume vs ${p.vol_avg}d avg`, "Volume ratio", `${ind.vol_ratio.toFixed(1)}×`],
  };
  return RULES.map((r) => {
    const v = res.votes[r];
    const pts = v * w[r];
    const vote = v > 0 ? `<span class="up">▲ +1</span>` : v < 0 ? `<span class="down">▼ −1</span>` : `<span class="flat">● 0</span>`;
    const [name, helpKey, sub] = meta[r];
    return `<tr><td><div class="rule">${esc(name)} ${help(helpKey, res.symbol ?? "")}</div><div class="sub">${esc(sub)}</div></td>
      <td class="vote">${vote}</td><td class="pts num ${pts > 0 ? "up" : pts < 0 ? "down" : ""}">${pts > 0 ? "+" : pts < 0 ? "−" : ""}${Math.abs(pts)}</td></tr>`;
  }).join("");
}

function historyStrip(hist) {
  const last = hist.slice(-30);
  const pad = Array.from({ length: Math.max(0, 30 - last.length) }, () => `<span class="cell none" title="No official signal"></span>`);
  const cells = last.map((h) => `<span class="cell ${h.signal}" title="${esc(fmt.date(h.date + "T08:00:00+08:00"))}: ${h.signal} ${fmt.signed(h.score)}"></span>`);
  return `<div class="strip" role="img" aria-label="Official signals for the last 30 days">${pad.join("")}${cells.join("")}</div>
    <div class="strip-scale"><span>30 days ago</span><span>today</span></div>`;
}

function backtestBlock(bt) {
  if (!bt) return `<p class="muted">Backtest results appear after the first weekly backtest run.</p>`;
  const h = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const rows = (bt.horizons ?? []).map((hz) => `<tr><td>${hz.days} days</td><td class="num">${h(hz.buy_hit_rate)}</td><td class="num">${h(hz.sell_hit_rate)}</td></tr>`).join("");
  return `<p>Backtest (${esc(bt.period ?? "2 years")}, daily): ${bt.signal_changes ?? "—"} signal changes.</p>
    <table class="bt"><thead><tr><th>After</th><th>BUY right</th><th>SELL right</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Strategy ${fmt.pct(bt.strategy_return_pct)} vs buy-and-hold ${fmt.pct(bt.buy_hold_return_pct)}.</p>`;
}

// ---------- the screen ----------

export class DetailView {
  constructor(view, ctx) {
    this.view = view;
    this.ctx = ctx;                               // { cfg, feed, coin, getModel, getOfficial }
    this.tf = store.get("detailTf", "1D");
    this.overlays = store.get("overlays", { sma50: true, sma200: true, bb: true, ema20: true });
    this.paneTab = "rsi";
    this.mode = null;                            // "official" | "live" (breakdown shown)
    this.tfBars = null;
    this.tfLoadedAt = 0;
    this.history = null;
    this.backtest = null;
    this.chart = null;
    this.mq = window.matchMedia?.(PHONE);
    this.mount();
  }

  mount() {
    const c = this.ctx.coin;
    const quote = this.ctx.cfg.data.quote ?? "USDT";
    this.view.innerHTML = `
      <section class="d-head">
        <a href="#/" class="back">‹ Back</a>
        <h2 class="d-pair">${esc(c.symbol)} / ${esc(quote)}</h2>
        <span class="name">${esc(c.name)}</span>
        <span class="price num" id="d-price">—</span>
        <span class="change num" id="d-change"></span>
        <span class="d-signals" id="d-signals"></span>
      </section>
      <section class="d-toolbar">
        <div class="tabs" role="tablist" aria-label="Timeframe">${TIMEFRAMES.map(([k]) =>
          `<button class="tab" role="tab" data-tf="${k}" aria-selected="${k === this.tf}">${k}</button>`).join("")}</div>
        <div class="overlays" role="group" aria-label="Overlays">${Object.entries(OVERLAYS).map(([k, o]) =>
          `<span class="ov-wrap"><button class="ov" data-ov="${k}" aria-pressed="${Boolean(this.overlays[k])}"><span class="key" style="background:${o.color}"></span>${esc(o.label)}</button>${help(o.help)}</span>`).join("")}</div>
        <span class="muted tf-note">The signal always uses daily (1D) candles.</span>
      </section>
      <section class="d-body">
        <div class="d-chart card-like">
          <div class="chart-title" id="chart-title"></div>
          <div class="legend num" id="legend"></div>
          <div class="chart-box" id="chart-box"><div class="chart-msg" id="chart-msg">Loading chart…</div></div>
          <div class="tabs pane-tabs" role="tablist" aria-label="Indicator pane">
            <button class="tab" data-pane="rsi" aria-selected="true">RSI</button>
            <button class="tab" data-pane="macd" aria-selected="false">MACD</button>
          </div>
        </div>
        <aside class="d-side">
          <div class="panel">
            <div class="panel-head"><h3>Signal score ${help("Signal score", c.symbol)}</h3>
              <div class="seg" role="group" aria-label="Which signal">
                <button data-mode="official">Official</button><button data-mode="live">Live</button>
              </div></div>
            <div class="mode-note muted" id="mode-note"></div>
            <div id="gauge"></div>
            <div class="events" id="events"></div>
          </div>
          <div class="panel">
            <h3>Indicator breakdown</h3>
            <table class="breakdown"><thead><tr><th>Rule</th><th>Vote</th><th>Points</th></tr></thead><tbody id="rules"></tbody></table>
          </div>
          <div class="panel">
            <h3>Signal history (last 30 days)</h3>
            <div id="history"><p class="muted">Loading…</p></div>
            <div id="backtest"></div>
          </div>
        </aside>
      </section>`;

    this.view.querySelectorAll("[data-tf]").forEach((b) => b.addEventListener("click", () => this.setTf(b.dataset.tf)));
    this.view.querySelectorAll("[data-ov]").forEach((b) => b.addEventListener("click", () => {
      this.overlays[b.dataset.ov] = !this.overlays[b.dataset.ov];
      store.set("overlays", this.overlays);
      b.setAttribute("aria-pressed", String(this.overlays[b.dataset.ov]));
      this.chart?.setOverlays(this.overlays);
    }));
    this.view.querySelectorAll("[data-pane]").forEach((b) => b.addEventListener("click", () => {
      this.paneTab = b.dataset.pane;
      this.view.querySelectorAll("[data-pane]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      this.chart?.showPane(this.paneTab);
    }));
    this.view.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { this.mode = b.dataset.mode; this.update(); }));
    this._onMq = () => this.buildChart();
    this.mq?.addEventListener?.("change", this._onMq);

    this.loadSideData();
    this.buildChart();
  }

  async loadSideData() {
    const sym = this.ctx.coin.symbol;
    const get = async (url) => {
      try {
        const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
        return r.ok ? r.json() : null;
      } catch { return null; }
    };
    const [hist, bt] = await Promise.all([get(`data/history/${encodeURIComponent(sym)}.json`), get("data/backtest.json")]);
    this.history = Array.isArray(hist) ? hist : [];
    this.backtest = bt?.assets?.find?.((a) => a.symbol === sym) ?? null;
    this.update();
    this.applyMarkers();
  }

  async buildChart() {
    const box = this.view.querySelector("#chart-box");
    const phone = Boolean(this.mq?.matches);
    this.view.querySelector(".d-chart").classList.toggle("phone", phone);
    this.chart?.destroy();
    this.chart = null;
    let L;
    try {
      L = await loadLibrary();
    } catch (e) {
      box.querySelector("#chart-msg").textContent = `Chart unavailable: ${e.message}. Signals and indicators below still work.`;
      return;
    }
    if (!this.view.isConnected) return;
    box.querySelector("#chart-msg")?.remove();
    this.chart = new PriceChart(L, box, { phone, overlays: this.overlays, onCrosshair: (b) => this.legend(b) });
    if (phone) this.chart.showPane(this.paneTab);
    const p = this.ctx.cfg.signal.periods;
    const rsiLabel = `RSI (${p.rsi}) ${help("RSI")}`;
    const macdLabel = `MACD (${p.macd_fast}, ${p.macd_slow}, ${p.macd_signal}) ${help("MACD")}`;
    await this.loadTf(true);
    this.chart?.setPaneLabels(phone ? [] : [rsiLabel, macdLabel]);
  }

  async setTf(tf) {
    this.tf = tf;
    store.set("detailTf", tf);
    this.view.querySelectorAll("[data-tf]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tf === tf)));
    await this.loadTf(true);
  }

  async loadTf(fit = false) {
    if (!this.chart) return;
    const [, interval, limit] = TIMEFRAMES.find(([k]) => k === this.tf);
    const tf = this.tf;
    try {
      const bars = await this.ctx.feed.klines(this.ctx.coin.pair, interval, limit);
      if (tf !== this.tf || !this.chart) return;            // the user switched while loading
      this.tfBars = bars;
      this.tfLoadedAt = Date.now();
      this.chart.setData(bars, this.ctx.cfg.signal);
      if (fit) this.chart.fit(this.tf === "1W" ? 104 : 120);
      this.applyMarkers();
      const n = { "1H": "hourly", "4H": "4-hour", "1D": "daily", "1W": "weekly" }[tf];
      this.view.querySelector("#chart-title").textContent = `Price (${n} candles, MYT)`;
    } catch (e) {
      this.view.querySelector("#chart-title").textContent = `Price — could not load ${tf} candles (${e.message})`;
    }
  }

  applyMarkers() {
    if (!this.chart) return;
    if (this.tf !== "1D" || !this.history?.length) { this.chart.setMarkers([]); return; }
    // History dates are the MYT close date; a daily candle opens at 08:00 MYT the day before.
    const marks = [];
    for (let i = 1; i < this.history.length; i++) {
      const h = this.history[i];
      if (h.signal === this.history[i - 1].signal) continue;
      const open = Date.parse(`${h.date}T00:00:00Z`) - DAY_MS;
      const color = h.signal === "BUY" ? "var(--buy)" : h.signal === "SELL" ? "var(--sell)" : "var(--hold)";
      marks.push({
        time: open / 1000,
        position: h.signal === "SELL" ? "aboveBar" : "belowBar",
        shape: h.signal === "BUY" ? "arrowUp" : h.signal === "SELL" ? "arrowDown" : "circle",
        color: getComputedStyle(document.documentElement).getPropertyValue(color.slice(4, -1)).trim(),
        text: h.signal,
      });
    }
    this.chart.setMarkers(marks);
  }

  legend(b) {
    const el = this.view.querySelector("#legend");
    if (!el) return;
    if (!b) { el.textContent = ""; return; }
    el.innerHTML = `<span>${esc(fmt.dateTime(b.time * 1000))}</span>
      <span>O <b>${fmt.price(b.open)}</b></span><span>H <b>${fmt.price(b.high)}</b></span>
      <span>L <b>${fmt.price(b.low)}</b></span><span>C <b>${fmt.price(b.close)}</b></span>
      <span>V <b>${b.volume?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "—"}</b></span>`;
  }

  // Called at every refresh interval.
  update() {
    const m = this.ctx.getModel();
    if (!m || !this.view.isConnected) return;
    const cfg = this.ctx.cfg;
    const priceEl = this.view.querySelector("#d-price");
    priceEl.textContent = fmt.price(m.livePrice);
    const t = m.ticker;
    const ch = this.view.querySelector("#d-change");
    ch.className = `change num ${t ? (t.changePct >= 0 ? "up" : "down") : ""}`;
    ch.textContent = t ? `${t.changePct >= 0 ? "▲" : "▼"} ${fmt.pct(t.changePct)} 24h` : "";

    // Official signal with its date, provisional live signal, highlight when they differ (FR-UI-08).
    const off = m.official, live = m.live;
    const offDate = this.ctx.getOfficial()?.candle_close;
    const differs = off && live && off.signal !== live.signal;
    this.view.querySelector("#d-signals").innerHTML = [
      off ? `<span class="sig">${badge(off.signal, off.strong)} <span class="num">score ${fmt.signed(off.score)}</span> · official ${offDate ? esc(fmt.date(offDate)) : ""}</span>` : "",
      live ? `<span class="sig${differs ? " differs" : ""}">${off ? "Live: " : ""}${badge(live.signal, live.strong)} <span class="num">score ${fmt.signed(live.score)}</span> · provisional (daily candle open)</span>` : "",
      !off && !live ? `<span class="muted">${m.unavailable ? "Data unavailable" : "Not enough history"}</span>` : "",
    ].join("");

    if (!this.mode) this.mode = off ? "official" : "live";
    if (this.mode === "official" && !off) this.mode = "live";
    const res = this.mode === "official" ? off : live;
    this.view.querySelectorAll("[data-mode]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === this.mode));
      b.disabled = b.dataset.mode === "official" ? !off : !live;
    });
    this.view.querySelector("#mode-note").textContent = this.mode === "official"
      ? `Official: completed daily candle${offDate ? ` closed ${fmt.dateTime(offDate)}` : ""}.`
      : "Live: today's candle is still open, so this can change until the 08:00 MYT close.";
    this.view.querySelector("#gauge").innerHTML = gauge(res?.score ?? null, res?.signal ?? null, cfg.signal.thresholds);
    const names = { golden_cross: "Golden cross (SMA 50 above SMA 200)", death_cross: "Death cross (SMA 50 below SMA 200)",
      rsi_overbought: "RSI entered overbought", rsi_oversold: "RSI entered oversold", signal_changed: "Signal changed since yesterday" };
    this.view.querySelector("#events").innerHTML = (res?.events ?? []).map((e) => `<span class="tag">${esc(names[e] ?? e)}</span>`).join("");
    this.view.querySelector("#rules").innerHTML = res ? ruleRows(res, cfg) : `<tr><td colspan="3" class="muted">No data</td></tr>`;

    if (this.history) {
      this.view.querySelector("#history").innerHTML = this.history.length
        ? historyStrip(this.history)
        : `<p class="muted">The 30-day history appears after the first daily run.</p>`;
      this.view.querySelector("#backtest").innerHTML = backtestBlock(this.backtest);
    }

    // Chart: move the last candle with the live price; reload candles every few minutes.
    if (this.chart && this.tfBars) {
      if (Date.now() - this.tfLoadedAt > TF_RELOAD_MS) this.loadTf(false);
      else this.chart.updateLast(m.livePrice);
    }
  }

  applyTheme() {
    this.chart?.applyTheme();
    if (this.tfBars) this.chart?.setData(this.tfBars, this.ctx.cfg.signal);
    this.applyMarkers();
  }

  destroy() {
    this.mq?.removeEventListener?.("change", this._onMq);
    this.chart?.destroy();
    this.chart = null;
  }
}
