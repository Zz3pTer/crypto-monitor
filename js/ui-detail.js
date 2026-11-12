// Asset detail screen (spec 5.3, FR-UI-04..08, FR-HIST-02/03).
// Address: #/asset/<SYMBOL>, so it can be bookmarked.
import * as fmt from "./format.js";
import { runAsset, settings as btSettings, daysNeeded } from "./backtest.js";
import * as store from "./store.js";
import { RULES } from "./signals.js";
import { help } from "./ui-overview.js";
import { loadLibrary, OVERLAYS, PriceChart } from "./charts.js";
import * as R from "./chart-range.js";

const esc = fmt.escape;
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
  if (bt.status !== "ok") return `<p class="muted">No backtest for this coin: ${esc(bt.message ?? "not enough history")}.</p>`;
  const rate = (x, n) => (x == null ? `<span class="muted">—</span>` : `${Math.round(x * 100)}% <span class="muted">of ${n}</span>`);
  const rows = (bt.horizons ?? []).map((hz) => `<tr><td>${hz.days} days</td><td class="num">${rate(hz.buy_hit_rate, hz.buy_count)}</td><td class="num">${rate(hz.sell_hit_rate, hz.sell_count)}</td></tr>`).join("");
  const beat = bt.strategy_return_pct > bt.buy_hold_return_pct;
  const range = bt.start && bt.end ? `${fmt.date(bt.start + "T12:00:00+08:00")} – ${fmt.date(bt.end + "T12:00:00+08:00")}` : esc(bt.period ?? "");
  return `<p class="bt-range">${range} <span class="muted">(${esc(bt.period ?? "")}, daily)</span>${bt.short_history ? ` <span class="tag">shorter history</span>` : ""}</p>
    <table class="bt"><thead><tr><th>After</th><th>BUY right</th><th>SELL right</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="bt"><tbody>
      <tr><td>Following the signals</td><td class="num ${bt.strategy_return_pct >= 0 ? "up" : "down"}">${fmt.pct(bt.strategy_return_pct)}</td></tr>
      <tr><td>Just holding</td><td class="num ${bt.buy_hold_return_pct >= 0 ? "up" : "down"}">${fmt.pct(bt.buy_hold_return_pct)}</td></tr>
    </tbody></table>
    ${bt.browser ? `<p class="muted">Worked out in your browser${bt.local ? "" : "; the saved backtest follows after the next daily run"}.</p>` : ""}
    <p class="muted">${bt.signal_changes} signal changes, ${bt.trades} trades, in the market ${Math.round(bt.time_in_market_pct)}% of the time. Following the signals did ${beat ? "better" : "worse"} than holding. Past results do not predict future results.</p>`;
}

// ---------- the screen ----------

export class DetailView {
  constructor(view, ctx) {
    this.view = view;
    this.ctx = ctx;                               // { cfg, feed, coin, getModel, getOfficial }
    this.range = R.rangeOf(store.get("detailRange", R.DEFAULT_RANGE)).key;    // which dates are shown
    this.tf = R.intervalOf(store.get("detailTf", "1D")).key;                    // candle size
    if (!R.allowed(this.range, this.tf)) this.tf = R.defaultInterval(this.range);
    this.overlays = store.get("overlays", { sma50: true, sma200: true, bb: true, ema20: true });
    this.paneTab = "rsi";
    this.mode = null;                            // "official" | "live" (breakdown shown)
    this.tfBars = null;
    this.gen = 0;                                // load counter: only the newest answer is used
    this.busy = false;
    this.moreOlder = false;
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
        <button class="btn mini d-manage" id="d-manage" title="Add for everyone, or remove">${c.local ? "My view only · Manage" : "Manage coin"}</button>
      </section>
      <section class="d-toolbar">
        <div class="tf-group"><span class="tf-label">Period</span>
          <div class="tabs" role="group" aria-label="Period shown">${R.RANGES.map((r) =>
            `<button class="tab" data-range="${r.key}" title="Show ${r.name}">${r.label}</button>`).join("")}</div></div>
        <div class="tf-group"><span class="tf-label">Candles</span>
          <div class="tabs" role="group" aria-label="Candle size">${R.INTERVALS.map((i) =>
            `<button class="tab" data-tf="${i.key}">${i.label}</button>`).join("")}</div></div>
        <div class="overlays" role="group" aria-label="Overlays">${Object.entries(OVERLAYS).map(([k, o]) =>
          `<span class="ov-wrap"><button class="ov" data-ov="${k}" aria-pressed="${Boolean(this.overlays[k])}"><span class="key" style="background:${o.color}"></span>${esc(o.label)}</button>${help(o.help)}</span>`).join("")}</div>
        <span class="muted tf-note">The signal always uses daily (1d) candles, whatever the chart shows.</span>
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
          </div>
          <div class="panel">
            <h3>Backtest ${help("Backtest", c.symbol)}</h3>
            <div id="backtest"><p class="muted">Loading…</p></div>
          </div>
        </aside>
      </section>`;

    this.view.querySelectorAll("[data-tf]").forEach((b) => b.addEventListener("click", () => this.setTf(b.dataset.tf)));
    this.view.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => this.setRange(b.dataset.range)));
    this.tfButtons();
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

    this.view.querySelector("#d-manage").addEventListener("click", () => this.ctx.onManage?.(c.symbol));
    this.loadSideData();
    this.buildChart();
  }

  // A coin added since the last backtest run: work it out here with the same rules.
  async browserBacktest() {
    const cfg = this.ctx.cfg;
    try {
      const daily = await this.ctx.feed.klines(this.ctx.coin.pair, "1d", Math.min(daysNeeded(cfg) + 1, 1000));
      const closed = daily.filter((k) => k.closeTime < Date.now());
      this.backtest = { ...runAsset(closed, cfg.signal, btSettings(cfg)), browser: true, local: Boolean(this.ctx.coin.local) };
    } catch {
      this.backtest = { status: "error", message: "the price history could not be loaded" };
    }
    if (this.view.isConnected) this.update();
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
    if (!this.backtest) this.browserBacktest();
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
    this.chart = new PriceChart(L, box, {
      phone, overlays: this.overlays, onCrosshair: (b) => this.legend(b),
      onView: (v) => this.onView(v), onNeedOlder: () => this.loadOlder(),
    });
    if (phone) this.chart.showPane(this.paneTab);
    const p = this.ctx.cfg.signal.periods;
    const rsiLabel = `RSI (${p.rsi}) ${help("RSI")}`;
    const macdLabel = `MACD (${p.macd_fast}, ${p.macd_slow}, ${p.macd_signal}) ${help("MACD")}`;
    await this.loadTf(true);
    this.chart?.setPaneLabels(phone ? [] : [rsiLabel, macdLabel]);
  }

  // Highlights the chosen period (none after free zooming) and candle size;
  // greys out candle sizes that give too few or too many candles.
  tfButtons() {
    this.view.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === this.range)));
    this.view.querySelectorAll("[data-tf]").forEach((b) => {
      const why = this.whyNotTf(b.dataset.tf);
      b.setAttribute("aria-pressed", String(b.dataset.tf === this.tf));
      b.disabled = Boolean(why);
      b.title = why || `${R.intervalOf(b.dataset.tf).name} candles`;
    });
  }

  // Dates on screen (ms), or null.
  visibleTimes() {
    const v = this.chart?.visible(), bars = this.tfBars;
    if (!v || !bars?.length) return null;
    const a = bars[Math.max(0, Math.min(bars.length - 1, Math.round(v.from)))];
    const b = bars[Math.max(0, Math.min(bars.length - 1, Math.round(v.to)))];
    return { t0: a.time, t1: b.time, a, b };
  }

  whyNotTf(key) {
    if (this.range) return R.whyNot(this.range, key);
    const vt = this.visibleTimes();
    if (!vt) return "";
    if ((vt.t1 - vt.t0) / R.intervalOf(key).ms < 2) return "Too few candles for what is shown";
    return R.barsSince(vt.t0, key) > R.MAX_BARS ? "Too many candles for what is shown" : "";
  }

  async setRange(range) {
    this.range = range;
    this.tf = R.defaultInterval(range);
    store.set("detailRange", range);
    store.set("detailTf", this.tf);
    this.tfButtons();
    await this.loadTf(true);
  }

  async setTf(tf) {
    if (this.whyNotTf(tf)) return;
    if (!this.range) { await this.switchInterval(tf); return; }     // after free zooming: keep the same dates
    this.tf = tf;
    store.set("detailTf", tf);
    this.tfButtons();
    await this.loadTf(true);
  }

  // Loads the candles for the chosen period and shows exactly that period.
  // `user`: started by a button, so "Loading…" is shown meanwhile.
  async loadTf(user = false) {
    if (!this.chart) return;
    const gen = ++this.gen;
    const tf = this.tf, range = this.range;
    const iv = R.intervalOf(tf);
    const title = this.view.querySelector("#chart-title");
    if (user) title.textContent = "Loading…";
    try {
      const want = R.barsToLoad(range, tf);
      const bars = await this.ctx.feed.klines(this.ctx.coin.pair, iv.api, want);
      if (gen !== this.gen || !this.chart) return;          // something newer was asked for meanwhile
      this.setBars(bars, want);
      this.chart.setData(bars, this.ctx.cfg.signal);
      const p = R.periodChange(bars, R.rangeStart(range));
      this.shownBars = p ? p.bars : bars.length;
      this.chart.fit(this.shownBars);
      this.applyMarkers();
      this.updateTitle();
      if (this.moreOlder) this.loadOlder();                  // ready before anyone zooms out
    } catch (e) {
      if (gen === this.gen) title.textContent = `Price — could not load ${iv.name} candles (${e.message})`;
    }
  }

  setBars(bars, asked) {
    this.tfBars = bars;
    this.tfLoadedAt = Date.now();
    this.moreOlder = bars.length >= asked && bars.length < R.MAX_LOADED;   // a full answer: there may be older candles
    if (this.chart) this.chart.moreOlder = this.moreOlder;
  }

  // The view moved (gesture, or the page itself).
  onView(v) {
    const shown = v.to - v.from;
    const before = this.visibleBars ?? shown;
    this.visibleBars = shown;
    if ((shown > 120) !== (before > 120)) this.applyMarkers();
    if (!v.user) return;
    if (this.range) { this.range = null; this.tfButtons(); }      // free zooming: no period button is lit
    this.updateTitle();
    if (v.from < Math.max(20, shown) && this.moreOlder) this.loadOlder();   // about one screen before the edge
    if (Math.abs(shown - before) < 0.5) return;
    this.zoomingOut = shown > before;
    this.maybeSwitch();
  }

  // Bigger or smaller candles if the zoom calls for it.
  maybeSwitch() {
    if (this.busy || this.zoomingOut == null || !this.chart) return;
    const v = this.chart.visible(), vt = this.visibleTimes();
    if (!v || !vt) return;
    const next = R.nextInterval(this.tf, v.to - v.from, this.zoomingOut, vt.t0, this.chart.width());
    if (next !== this.tf) this.switchInterval(next);
    else this.tfButtons();
  }

  // Changes the candle size but keeps the same dates on screen.
  async switchInterval(key) {
    const vt = this.visibleTimes();
    if (!vt || this.busy) return;
    // One more screen of history to the left, so zooming out can go on.
    const want = Math.min(R.barsSince(vt.t0 - (vt.t1 - vt.t0), key), R.MAX_BARS);
    this.busy = true;
    const gen = ++this.gen;
    try {
      const bars = await this.ctx.feed.klines(this.ctx.coin.pair, R.intervalOf(key).api, want);
      await this.chart?.idle();
      if (gen !== this.gen || !this.chart) return;
      const now = this.visibleTimes() ?? vt;                  // the dates on screen once the gesture ended
      const end = this.chart.atRight() ? Infinity : (now.b.closeTime ?? now.t1);
      this.tf = key;
      this.zoomingOut = null;
      store.set("detailTf", key);
      this.setBars(bars, want);
      this.chart.setData(bars, this.ctx.cfg.signal);
      this.chart.showTimes(now.t0 / 1000, end / 1000);     // the same dates; still at the latest candle if it was
      this.tfButtons();
      this.applyMarkers();
      this.updateTitle();
    } catch { /* keep the current candles */ } finally {
      this.busy = false;
    }
  }

  // The user reached the oldest loaded candle: load up to 1000 older ones.
  async loadOlder() {
    if (this.busy || !this.moreOlder || !this.tfBars?.length) return;
    this.busy = true;
    const gen = ++this.gen;
    try {
      const iv = R.intervalOf(this.tf);
      const older = await this.ctx.feed.klines(this.ctx.coin.pair, iv.api, 1000, this.tfBars[0].time - 1);
      await this.chart?.idle();
      if (gen !== this.gen || !this.chart) return;
      const merged = R.mergeBars(older, this.tfBars);
      this.tfBars = merged;
      this.moreOlder = older.length >= 1000 && merged.length < R.MAX_LOADED;
      this.chart.moreOlder = this.moreOlder;
      this.chart.replaceData(merged, this.ctx.cfg.signal);
      this.applyMarkers();
      this.updateTitle();
    } catch { /* try again on the next push */ } finally {
      this.busy = false;
      this.chart?.setLoading(false);
    }
    this.maybeSwitch();                                    // a zoom that happened while loading
  }

  // Every few minutes: fetch the latest candles and add them, keeping the view.
  async refreshLatest() {
    if (this.busy || !this.tfBars?.length) return;
    this.tfLoadedAt = Date.now();
    const gen = this.gen;
    try {
      const latest = await this.ctx.feed.klines(this.ctx.coin.pair, R.intervalOf(this.tf).api, 3);
      if (gen !== this.gen || !this.chart) return;
      this.tfBars = R.mergeBars(this.tfBars, latest);
      this.chart.replaceData(this.tfBars, this.ctx.cfg.signal);
      this.applyMarkers();
      this.updateTitle();
    } catch { /* next time */ }
  }

  updateTitle() {
    const title = this.view.querySelector("#chart-title");
    const iv = R.intervalOf(this.tf);
    if (!this.tfBars?.length) return;
    if (this.range) {
      const start = R.rangeStart(this.range);
      const p = R.periodChange(this.tfBars, start);
      title.innerHTML = p ? this.periodTitle(p, start, iv) : `Price (${iv.name} candles, MYT)`;
      return;
    }
    const vt = this.visibleTimes();
    if (!vt) return;
    const pct = vt.a.open ? ((vt.b.close - vt.a.open) / vt.a.open) * 100 : null;
    const end = Math.min(vt.b.closeTime ?? vt.t1, Date.now());
    const short = end - vt.t0 < 3 * DAY_MS;
    const dates = `${short ? fmt.dateTime(vt.t0) : fmt.date(vt.t0)} – ${end >= Date.now() - iv.ms ? "now" : short ? fmt.dateTime(end) : fmt.date(end)}`;
    const ch = pct === null ? "" : ` · <span class="num ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${fmt.pct(pct)}</span>`;
    title.innerHTML = `Price · ${esc(dates)}${ch} · ${iv.name} candles, MYT`;
  }

  // "1 year · 12 Nov 2025 – 12 Nov 2026 · ▲ +40.2% · daily candles, MYT"
  periodTitle(p, start, iv) {
    const r = R.rangeOf(this.range);
    const short = start !== null && p.from > start + iv.ms;          // the coin is younger than the period
    const ch = p.changePct === null ? "" : ` · <span class="num ${p.changePct >= 0 ? "up" : "down"}">${p.changePct >= 0 ? "▲" : "▼"} ${fmt.pct(p.changePct)}</span>`;
    const dates = this.range === "1D" || this.range === "1W"
      ? `${fmt.dateTime(Math.max(p.from, start ?? p.from))} – now`
      : `${fmt.date(Math.max(p.from, start ?? p.from))} – ${fmt.date(Math.min(p.to, Date.now()))}`;
    return `Price · ${esc(r.name)} · ${esc(dates)}${ch} · ${iv.name} candles, MYT${short ? ` <span class="tag">only since ${esc(fmt.date(p.from))}</span>` : ""}`;
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
        text: (this.visibleBars ?? this.shownBars ?? 0) > 120 ? "" : h.signal,   // many candles: arrows only, words would overlap
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
      if (Date.now() - this.tfLoadedAt > TF_RELOAD_MS) this.refreshLatest();
      else this.chart.updateLast(m.livePrice);
    }
  }

  applyTheme() {
    this.chart?.applyTheme();
    if (this.tfBars) this.chart?.replaceData(this.tfBars, this.ctx.cfg.signal);
    this.applyMarkers();
  }

  destroy() {
    this.mq?.removeEventListener?.("change", this._onMq);
    this.chart?.destroy();
    this.chart = null;
  }
}
