// Every pop-up text in one file (FR-HELP-06). Numbers come from the config,
// so the explanations always match the rules actually in use.
// Each entry: short name, full name, what it is, value ranges
// (bull / neutral / bear), and now(res) -> "value — meaning" for the coin.
import * as fmt from "./format.js";

const r1 = (x) => (x == null ? "—" : Math.round(x));
const voteWord = (v) => (v > 0 ? "bullish (+1)" : v < 0 ? "bearish (−1)" : "neutral (0)");

export function helpFor(key, cfg) {
  const s = cfg.signal, p = s.periods, th = s.thresholds;
  const entries = {
    "Signal score": {
      short: "Signal score", full: `Combined result of the ${Object.keys(s.weights).length} rules`,
      what: "The weighted votes of all the rules for this coin, added up into one number from −100 to +100.",
      ranges: [
        ["bull", `+${th.buy} or more = BUY (+${th.strong_buy} or more = strong)`],
        ["neutral", `${th.sell + 1} to +${th.buy - 1} = HOLD`],
        ["bear", `${th.sell} or less = SELL (${th.strong_sell} or less = strong)`],
      ],
      now: (res) => `${fmt.signed(res.score)} — ${res.strong ? "strong " : ""}${res.signal}`,
    },
    "RSI": {
      short: `RSI (${p.rsi})`, full: "Relative Strength Index",
      what: `Shows how strongly the price has been rising or falling over the last ${p.rsi} days, on a scale from 0 to 100.`,
      ranges: [
        ["bull", `Below ${s.rsi_oversold}: oversold — price may rebound (bullish, +1)`],
        ["neutral", `${s.rsi_oversold} to ${s.rsi_overbought}: neutral (0)`],
        ["bear", `Above ${s.rsi_overbought}: overbought — price may pull back (bearish, −1)`],
      ],
      now: (res) => {
        const v = res.indicators.rsi14;
        return `${r1(v)} — ${v < s.rsi_oversold ? "oversold" : v > s.rsi_overbought ? "overbought" : "neutral"}`;
      },
    },
    "MACD": {
      short: `MACD (${p.macd_fast}, ${p.macd_slow}, ${p.macd_signal})`, full: "Moving Average Convergence Divergence",
      what: `The gap between the ${p.macd_fast}-day and ${p.macd_slow}-day averages, compared with its own ${p.macd_signal}-day average (the signal line). Shows whether momentum is building or fading.`,
      ranges: [
        ["bull", "Above the signal line and histogram rising = bullish (+1)"],
        ["neutral", "Otherwise neutral (0)"],
        ["bear", "Below the signal line and histogram falling = bearish (−1)"],
      ],
      now: (res) => `${res.indicators.macd > res.indicators.macd_signal ? "above" : "below"} the signal line — ${voteWord(res.votes.macd)}`,
    },
    "SMA 200": {
      short: `SMA ${p.sma_slow}`, full: "Simple Moving Average",
      what: `The average closing price of the last ${p.sma_slow} days. Smooths out daily noise to show the long-term trend.`,
      ranges: [["bull", "Price above the line = up-trend"], ["bear", "Price below the line = down-trend"]],
      now: (res, price) => {
        const v = res.indicators.sma200;
        return `${fmt.price(v)} — price is ${price > v ? "above (up-trend)" : "below (down-trend)"}`;
      },
    },
    "SMA 50": {
      short: `SMA ${p.sma_fast}`, full: "Simple Moving Average",
      what: `The average closing price of the last ${p.sma_fast} days. Smooths out daily noise to show the medium-term trend.`,
      ranges: [["bull", "Price above the line = up-trend"], ["bear", "Price below the line = down-trend"]],
      now: (res, price) => {
        const v = res.indicators.sma50;
        return `${fmt.price(v)} — price is ${price > v ? "above (up-trend)" : "below (down-trend)"}`;
      },
    },
    "EMA 20": {
      short: `EMA ${p.ema}`, full: "Exponential Moving Average",
      what: `Average of about ${p.ema} days that gives more weight to recent days, so it reacts faster. Shown on the chart only, not in the score.`,
      ranges: [["bull", "Price above = short-term strength"], ["bear", "Price below = short-term weakness"]],
      now: (res, price) => {
        const v = res.indicators.ema20;
        return `${fmt.price(v)} — price is ${price > v ? "above (strength)" : "below (weakness)"}`;
      },
    },
    "Bollinger": {
      short: `Bollinger Bands (${p.bb}, ${p.bb_std})`, full: "Bollinger Bands",
      what: `A band around the ${p.bb}-day average, ${p.bb_std} standard deviations wide. The price usually stays inside it.`,
      ranges: [
        ["bull", "Below the lower band = stretched down (+1)"],
        ["neutral", "Inside the band = neutral (0)"],
        ["bear", "Above the upper band = stretched up (−1)"],
      ],
      now: (res) => {
        const c = res.close, i = res.indicators;
        return c < i.bb_lower ? "below the lower band — bullish (+1)" : c > i.bb_upper ? "above the upper band — bearish (−1)" : "inside the band — neutral (0)";
      },
    },
    "Trend (price vs SMA 200)": {
      short: `Trend (price vs SMA ${p.sma_slow})`, full: `Long-term trend, ${s.weights.trend} points`,
      what: `Compares today's price with the ${p.sma_slow}-day average.`,
      ranges: [["bull", "Above = bullish (+1)"], ["bear", "Below = bearish (−1)"]],
      now: (res) => `price ${res.close > res.indicators.sma200 ? "above" : "below"} SMA ${p.sma_slow} — ${voteWord(res.votes.trend)}`,
    },
    "Trend structure (SMA 50 vs SMA 200)": {
      short: `Trend structure (SMA ${p.sma_fast} vs SMA ${p.sma_slow})`, full: `Medium vs long-term average, ${s.weights.cross} points`,
      what: "Compares the medium-term average with the long-term average.",
      ranges: [["bull", `SMA ${p.sma_fast} above ("golden cross") = bullish (+1)`], ["bear", `SMA ${p.sma_fast} below ("death cross") = bearish (−1)`]],
      now: (res) => `SMA ${p.sma_fast} ${res.indicators.sma50 > res.indicators.sma200 ? "above" : "below"} SMA ${p.sma_slow} — ${voteWord(res.votes.cross)}`,
    },
    "Momentum ROC": {
      short: `Momentum ROC (${p.roc})`, full: "Rate of Change",
      what: `The percentage price change over the last ${p.roc} days.`,
      ranges: [
        ["bull", `Above +${s.roc_pct}% = bullish (+1)`],
        ["neutral", `Between −${s.roc_pct}% and +${s.roc_pct}% = neutral (0)`],
        ["bear", `Below −${s.roc_pct}% = bearish (−1)`],
      ],
      now: (res) => `${fmt.pct(res.indicators.roc14)} — ${voteWord(res.votes.momentum)}`,
    },
    "Volume ratio": {
      short: "Volume ratio", full: `Today's volume vs the ${p.vol_avg}-day average`,
      what: `Today's trading volume divided by the ${p.vol_avg}-day average volume. A big move on heavy volume is more convincing.`,
      ranges: [
        ["bull", `Above ${s.volume_spike}× on an up day = move confirmed (+1)`],
        ["neutral", "Otherwise neutral (0)"],
        ["bear", `Above ${s.volume_spike}× on a down day = selling confirmed (−1)`],
      ],
      now: (res) => `${res.indicators.vol_ratio.toFixed(2)}× — ${voteWord(res.votes.volume)}`,
    },
  };
  return entries[key] ?? null;
}
