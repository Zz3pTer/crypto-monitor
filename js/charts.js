// Price chart with overlays, RSI and MACD panes (spec 5.3, FR-UI-05/06).
// Uses TradingView Lightweight Charts, pinned to one version and checked
// with an integrity hash. Every time on the axis and crosshair is MYT
// (FR-TIME-02): the library shows UTC unless told otherwise.
import * as ind from "./indicators.js";
import * as fmt from "./format.js";

const LIB_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
const LIB_SRI = "sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN";

export const OVERLAYS = {
  sma50: { label: "SMA 50", help: "SMA 50", color: "#3B82F6" },
  sma200: { label: "SMA 200", help: "SMA 200", color: "#A78BFA" },
  bb: { label: "Bollinger 20,2", help: "Bollinger", color: "#94A3B8" },
  ema20: { label: "EMA 20", help: "EMA 20", color: "#F59E0B" },
};

let libPromise = null;
export function loadLibrary() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  libPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIB_URL;
    s.integrity = LIB_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => { libPromise = null; reject(new Error("chart library could not be loaded")); };
    document.head.appendChild(s);
  });
  return libPromise;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeOptions() {
  const text = css("--label"), border = css("--border");
  return {
    layout: { background: { type: "solid", color: css("--card") }, textColor: text, fontSize: 11,
      panes: { separatorColor: border, separatorHoverColor: border, enableResize: false } },
    grid: { vertLines: { color: border + "55" }, horzLines: { color: border + "55" } },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  };
}

function precisionFor(price) {
  if (price >= 10) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 4;
  return 8;
}

// MYT labels for the time axis. tickMarkType: 0 year, 1 month, 2 day, 3 time, 4 time with seconds.
function tickLabel(time, type) {
  const d = new Date(time * 1000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: fmt.TZ, hourCycle: "h23",
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  if (type === 0) return p.year;
  if (type === 1) return p.month;
  if (type === 2) return `${p.day} ${p.month}`;
  return `${p.hour}:${p.minute}`;
}

export class PriceChart {
  // phone = true: one indicator pane with RSI/MACD as tabs (spec 5.6)
  // onView({ from, to, n, user }): the visible candles changed (user = by a gesture).
  // onNeedOlder(): the user pushed against the oldest loaded candle.
  constructor(LWC, el, { phone, overlays, onCrosshair, onView, onNeedOlder }) {
    this.L = LWC;
    this.el = el;
    this.phone = phone;
    this.onCrosshair = onCrosshair;
    this.onView = onView;
    this.onNeedOlder = onNeedOlder;
    this.moreOlder = false;             // set by the page: older history can still be loaded
    el.priceChart = this;               // lets browser tests read the view
    this._quietUntil = 0;
    this.bars = [];
    this.byTime = new Map();
    this.chart = LWC.createChart(el, {
      autoSize: true,
      ...themeOptions(),
      crosshair: { mode: 0 },
      // Drag to move, pinch or mouse wheel to zoom. Up/down swipes on a phone
      // still scroll the page. The price axis always fits the candles shown.
      // Touch and hold, then slide, to read prices (gone when the finger lifts).
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: { time: false, price: true } },
      kineticScroll: { touch: true, mouse: false },
      trackingMode: { exitMode: 0 },
      localization: { timeFormatter: (t) => fmt.dateTime(t * 1000) },
      timeScale: { ...themeOptions().timeScale, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickLabel,
        rightOffset: 0, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
    });
    const up = css("--buy"), down = css("--sell");
    this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
      upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
    }, 0);
    const line = (color, pane, extra = {}) => this.chart.addSeries(LWC.LineSeries, {
      color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra,
    }, pane);
    this.ov = {
      sma50: [line(OVERLAYS.sma50.color, 0)],
      sma200: [line(OVERLAYS.sma200.color, 0)],
      ema20: [line(OVERLAYS.ema20.color, 0)],
      bb: [line(OVERLAYS.bb.color, 0, { lineWidth: 1 }), line(OVERLAYS.bb.color, 0, { lineWidth: 1, lineStyle: 2 }),
        line(OVERLAYS.bb.color, 0, { lineWidth: 1 })],
    };
    const rsiPane = 1, macdPane = phone ? 1 : 2;
    this.rsi = line("#A78BFA", rsiPane, { lastValueVisible: true });
    this.rsiLines = [];
    this.macdHist = this.chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, macdPane);
    this.macd = line("#3B82F6", macdPane, { lineWidth: 2 });
    this.macdSig = line("#F59E0B", macdPane, { lineWidth: 2 });
    const panes = this.chart.panes();
    panes[0].setStretchFactor(phone ? 3 : 3.2);
    panes[1]?.setStretchFactor(1);
    panes[2]?.setStretchFactor(1);
    this.markers = LWC.createSeriesMarkers(this.candles, []);
    this.setOverlays(overlays);
    if (phone) this.showPane("rsi");
    el.style.overscrollBehaviorX = "none";      // sideways swipes never trigger the browser's swipe-back
    this.initEdges(el);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this._onRange(r));
    this.chart.subscribeCrosshairMove((param) => {
      const bar = param.time ? param.seriesData.get(this.candles) : null;
      const full = bar ? this.bars.find((b) => b.time === param.time) : this.bars.at(-1);
      this.onCrosshair?.(full ?? null);
    });
  }

  // ---------- view: which part of the history is on screen ----------

  // A view change counts as the user's while a gesture is going on (and
  // shortly after, for the glide after a flick), unless the page made it.
  touched(ms = 1200) {
    this._userUntil = performance.now() + ms;
    this._lastMove = performance.now();
  }

  // Resolves once no finger or mouse button is down and the view has been
  // still for a moment. New candles are only swapped in then: the chart
  // library tracks a pinch or drag by candle position, so changing the
  // candles mid-gesture would make the view jump back.
  idle() {
    // A wheel holds no gesture state, so its zoom can carry on over new candles at once.
    const still = () => !this._fingers && !this._mouse && (this._lastInput === "wheel" || performance.now() - (this._lastMove ?? 0) > 250);
    return new Promise((resolve) => {
      const check = () => (still() ? resolve() : setTimeout(check, 80));
      check();
    });
  }

  quiet(fn) {
    this._quietUntil = performance.now() + 200;
    fn();
  }

  visible() {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    return r ? { from: r.from, to: r.to, n: this.bars.length } : null;
  }

  width() { return this.chart.timeScale().width(); }

  atLeft() { const v = this.visible(); return Boolean(v && v.from <= 0.6); }
  atRight() { const v = this.visible(); return Boolean(v && v.to >= v.n - 1.6); }

  _onRange(r) {
    if (!r || !this.bars.length) return;
    const n = this.bars.length;
    // Safety net: never show space beyond the data, whatever the gesture.
    if (r.from < -0.6 || r.to > n - 0.4) {
      const w = Math.min(r.to - r.from, n);
      const from = r.from < -0.6 ? -0.5 : n - 0.5 - w;
      this.chart.timeScale().setVisibleLogicalRange({ from, to: from + w });
      return;
    }
    const t = performance.now();
    const user = t < (this._userUntil ?? 0) && t > this._quietUntil;
    if (user) this._lastMove = t;                    // still gliding after a flick
    this.showPill(r, user);
    if (this._viewFrame) return;
    this._viewFrame = requestAnimationFrame(() => {
      this._viewFrame = null;
      const v = this.visible();
      if (v) this.onView?.({ ...v, user });
    });
  }

  // Shows candles `from` to `to` (indexes into the bars).
  showBars(from, to) {
    this.quiet(() => this.chart.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: to + 0.5 }));
  }

  // Replaces the candles but keeps the same dates on screen. If the view was
  // at the latest candle it stays there.
  replaceData(candles, cfg) {
    const v = this.visible();
    const old = this.bars;
    const keepRight = v && v.to >= v.n - 1.6;
    const t0 = v && old.length ? old[Math.max(0, Math.round(v.from))]?.time : null;
    const t1 = v && old.length ? old[Math.min(old.length - 1, Math.round(v.to))]?.time : null;
    this.setData(candles, cfg);
    if (t0 == null) return;
    const n = this.bars.length;
    const idx = (t) => { const i = this.bars.findIndex((b) => b.time >= t); return i < 0 ? n - 1 : i; };
    if (keepRight) {
      const w = Math.round(v.to) - Math.round(v.from);
      this.showBars(Math.max(0, n - 1 - w), n - 1);
    } else this.showBars(idx(t0), idx(t1));
  }

  // Shows the dates t0..t1 (seconds), whatever the candle size.
  showTimes(t0, t1) {
    const n = this.bars.length;
    if (!n) return;
    const first = this.bars.findIndex((b) => b.time >= t0);
    let last = n - 1;
    while (last > 0 && this.bars[last].time > t1) last--;
    this.showBars(Math.max(0, first < 0 ? 0 : first), Math.max(first < 0 ? 0 : first, last));
  }

  // ---------- edge glow and scroll pill ----------

  initEdges(el) {
    const mk = (cls, parent = el) => { const d = document.createElement("div"); d.className = cls; parent.appendChild(d); return d; };
    this.glow = { left: mk("edge-glow left"), right: mk("edge-glow right") };
    this.pill = mk("scroll-pill");
    this.pillThumb = mk("thumb", this.pill);
    this.loadingChip = mk("chart-chip");
    this.loadingChip.textContent = "Loading older prices…";
    this.pull = { left: 0, right: 0 };
    let lastX = null, lastDist = null, mouseDown = false, wheelTimer = null;

    const push = (side, amount) => {
      if (side === "left" && this.moreOlder) { this.setLoading(true); this.onNeedOlder?.(); return; }
      this.pull[side] = Math.min(160, this.pull[side] + amount);
      const k = this.pull[side] / 160;
      const g = this.glow[side];
      g.style.transition = "none";
      g.style.opacity = String(Math.min(1, 0.25 + k));
      g.style.transform = `scaleX(${0.35 + 0.65 * k})`;
    };
    const release = () => {
      for (const side of ["left", "right"]) {
        this.pull[side] = 0;
        const g = this.glow[side];
        g.style.transition = "";
        g.style.opacity = "0";
        g.style.transform = "scaleX(.35)";
      }
    };
    // A finger or mouse moving right shows older candles; moving left, newer.
    const moveBy = (dx) => {
      if (dx > 0 && this.atLeft()) push("left", dx);
      else if (dx < 0 && this.atRight()) push("right", -dx);
    };
    const zoomOutAtFull = (amount) => {
      if (!(this.atLeft() && this.atRight())) return;
      push("left", amount);
      push("right", amount);
    };
    // Capture phase: the chart library handles these events itself and may stop them.
    const on = (target, ev, fn) => target.addEventListener(ev, fn, { passive: true, capture: true });
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    on(el, "touchstart", (e) => {
      this.touched();
      this._lastInput = "touch";
      this._fingers = e.touches.length;
      lastX = e.touches.length === 1 ? e.touches[0].clientX : null;
      lastDist = e.touches.length === 2 ? dist(e.touches) : null;
    });
    on(el, "touchmove", (e) => {
      this.touched();
      if (e.touches.length === 1 && lastX !== null) {
        const x = e.touches[0].clientX;
        moveBy(x - lastX);
        lastX = x;
      } else if (e.touches.length === 2) {
        const d = dist(e.touches);
        if (lastDist !== null && d < lastDist) zoomOutAtFull((lastDist - d) / 2);
        lastDist = d;
      }
    });
    for (const ev of ["touchend", "touchcancel"]) on(el, ev, (e) => { this.touched(1500); this._fingers = e.touches.length; lastX = lastDist = null; release(); });

    on(el, "mousedown", (e) => { this.touched(); this._lastInput = "mouse"; mouseDown = this._mouse = true; lastX = e.clientX; });
    this._onMouseMove = (e) => {
      if (!mouseDown) return;
      this.touched();
      moveBy(e.clientX - lastX);
      lastX = e.clientX;
    };
    this._onMouseUp = () => { if (mouseDown) { mouseDown = this._mouse = false; release(); } };
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);

    on(el, "wheel", (e) => {
      this.touched(600);
      this._lastInput = "wheel";
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) moveBy(-e.deltaX / 2);
      else if (e.deltaY > 0) zoomOutAtFull(e.deltaY / 4);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(release, 180);
    });
  }

  setLoading(on) {
    this.loadingChip.classList.toggle("on", Boolean(on));
  }

  // Thin bar under the dates: where the view is within the loaded history.
  // Shows while moving and fades out after a moment.
  showPill(r, user) {
    const n = this.bars.length;
    if (!n || !this.pill) return;
    const from = Math.max(0, r.from + 0.5), to = Math.min(n, r.to + 0.5);
    const axisW = this.chart.priceScale("right").width() || 60;
    this.pill.style.right = `${axisW + 4}px`;
    this.glow.right.style.right = `${axisW}px`;
    this.pillThumb.style.left = `${(from / n) * 100}%`;
    this.pillThumb.style.width = `${Math.max(2, ((to - from) / n) * 100)}%`;
    if (!user) return;
    this.pill.classList.add("on");
    clearTimeout(this._pillTimer);
    this._pillTimer = setTimeout(() => this.pill.classList.remove("on"), 1200);
  }

  setData(candles, rsiCfg) {
    this.bars = candles.map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const last = this.bars.at(-1)?.close ?? 1;
    const prec = precisionFor(last);
    this.candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    this.candles.setData(this.bars);
    this.byTime = new Map(this.bars.map((b) => [b.time, b]));
    const closes = candles.map((c) => c.close);
    const times = this.bars.map((b) => b.time);
    const toLine = (vals) => vals.flatMap((v, i) => (v === null ? [] : [{ time: times[i], value: v }]));
    const p = rsiCfg.periods;
    this.ov.sma50[0].setData(toLine(ind.sma(closes, p.sma_fast)));
    this.ov.sma200[0].setData(toLine(ind.sma(closes, p.sma_slow)));
    this.ov.ema20[0].setData(toLine(ind.ema(closes, p.ema)));
    const [u, m, l] = ind.bollinger(closes, p.bb, p.bb_std);
    this.ov.bb[0].setData(toLine(u));
    this.ov.bb[1].setData(toLine(m));
    this.ov.bb[2].setData(toLine(l));
    for (const s of this.ov.sma50.concat(this.ov.sma200, this.ov.ema20, this.ov.bb)) {
      s.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    }
    this.rsi.setData(toLine(ind.rsi(closes, p.rsi)));
    if (!this.rsiLines.length) {
      this.rsiLines = [
        this.rsi.createPriceLine({ price: rsiCfg.rsi_overbought, color: css("--sell"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true }),
        this.rsi.createPriceLine({ price: rsiCfg.rsi_oversold, color: css("--buy"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true }),
      ];
    }
    const [ml, ms, mh] = ind.macd(closes, p.macd_fast, p.macd_slow, p.macd_signal);
    this.macd.setData(toLine(ml));
    this.macdSig.setData(toLine(ms));
    const up = css("--buy"), down = css("--sell");
    this.macdHist.setData(mh.flatMap((v, i) => (v === null ? [] : [{ time: times[i], value: v, color: (v >= 0 ? up : down) + "B0" }])));
    this.onCrosshair?.(this.bars.at(-1) ?? null);
  }

  // Live update of the last bar (repainted at the refresh interval).
  updateLast(price) {
    const b = this.bars.at(-1);
    if (!b || price == null) return;
    b.close = price;
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    this.candles.update({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
  }

  // Titles (with "?" icons) placed inside the RSI and MACD panes.
  setPaneLabels(htmls) {
    this._labels = htmls;
    requestAnimationFrame(() => {
      const panes = this.chart.panes();
      htmls.forEach((html, i) => {
        const host = panes[i + 1]?.getHTMLElement?.();
        if (!host) return;
        host.style.position = "relative";
        host.querySelector(":scope > .pane-label")?.remove();
        const div = document.createElement("div");
        div.className = "pane-label";
        div.innerHTML = html;
        host.appendChild(div);
      });
    });
  }

  // Markers where the official signal changed (1D only).
  setMarkers(list) {
    this.markers.setMarkers(list);
  }

  setOverlays(on) {
    for (const [key, series] of Object.entries(this.ov)) {
      for (const s of series) s.applyOptions({ visible: Boolean(on[key]) });
    }
  }

  showPane(which) {
    this.rsi.applyOptions({ visible: which === "rsi" });
    for (const l of this.rsiLines) l.applyOptions({ lineVisible: which === "rsi", axisLabelVisible: which === "rsi" });
    for (const s of [this.macd, this.macdSig, this.macdHist]) s.applyOptions({ visible: which === "macd" });
  }

  applyTheme() {
    this.chart.applyOptions(themeOptions());
    const up = css("--buy"), down = css("--sell");
    this.candles.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }

  // Shows the latest `barsVisible` candles.
  fit(barsVisible = 120) {
    const n = this.bars.length;
    if (n) this.showBars(Math.max(0, n - barsVisible), n - 1);
  }

  destroy() {
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("mouseup", this._onMouseUp);
    cancelAnimationFrame(this._viewFrame);
    this.chart.remove();
  }
}
