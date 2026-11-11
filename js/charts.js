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
  constructor(LWC, el, { phone, overlays, onCrosshair }) {
    this.L = LWC;
    this.el = el;
    this.phone = phone;
    this.onCrosshair = onCrosshair;
    this.bars = [];
    this.chart = LWC.createChart(el, {
      autoSize: true,
      ...themeOptions(),
      crosshair: { mode: 0 },
      localization: { timeFormatter: (t) => fmt.dateTime(t * 1000) },
      timeScale: { ...themeOptions().timeScale, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickLabel, rightOffset: 4 },
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
    this.chart.subscribeCrosshairMove((param) => {
      const bar = param.time ? param.seriesData.get(this.candles) : null;
      const full = bar ? this.bars.find((b) => b.time === param.time) : this.bars.at(-1);
      this.onCrosshair?.(full ?? null);
    });
  }

  setData(candles, rsiCfg) {
    this.bars = candles.map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const last = this.bars.at(-1)?.close ?? 1;
    const prec = precisionFor(last);
    this.candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    this.candles.setData(this.bars);
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

  fit(barsVisible = 120) {
    const n = this.bars.length;
    if (n) this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - barsVisible), to: n + 3 });
  }

  destroy() {
    this.chart.remove();
  }
}
