// Load and check config/config.json. validate() mirrors python/config.py
// word for word, so the website refuses exactly what the daily job would
// refuse (FR-CFG-08). Change both together; tests/fixtures/config_cases.json
// is checked against both.

export const MAX_COINS = 30;
const WEIGHT_KEYS = ["trend", "cross", "macd", "rsi", "bollinger", "momentum", "volume"];
const PERIOD_KEYS = ["sma_fast", "sma_slow", "ema", "rsi", "bb", "bb_std",
  "macd_fast", "macd_slow", "macd_signal", "roc", "vol_avg"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isText = (v) => typeof v === "string" && v.length > 0;

export class ConfigError extends Error {}

// Returns a list of problems; empty means the config is usable.
export function validate(cfg) {
  const problems = [];
  const need = (section) => {
    const val = cfg[section];
    if (!isObj(val)) { problems.push(`"${section}" section is missing`); return {}; }
    return val;
  };

  let symbols = cfg.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    problems.push('"symbols" must be a non-empty list');
    symbols = [];
  }
  const seen = new Set();
  symbols.forEach((s, i) => {
    const label = `symbols[${i}]`;
    if (!isObj(s)) { problems.push(`${label} must be an object`); return; }
    for (const field of ["symbol", "name", "pair"]) {
      if (!isText(s[field])) problems.push(`${label} needs a text "${field}"`);
    }
    if (seen.has(s.symbol)) problems.push(`${label}: symbol "${s.symbol}" is listed twice`);
    seen.add(s.symbol);
    if ("enabled" in s && typeof s.enabled !== "boolean") problems.push(`${label}: "enabled" must be true or false`);
  });
  const enabled = symbols.filter((s) => isObj(s) && s.enabled !== false);
  if (symbols.length && !enabled.length) problems.push("no coin is enabled");
  if (enabled.length > MAX_COINS) problems.push(`${enabled.length} coins enabled; the maximum is ${MAX_COINS}`);

  const refresh = need("refresh");
  const opts = refresh.options_sec;
  if (!Array.isArray(opts) || !opts.length || !opts.every((o) => Number.isInteger(o) && o > 0)) {
    problems.push("refresh.options_sec must be a list of positive whole seconds");
  } else if (!opts.includes(refresh.default_sec)) {
    problems.push("refresh.default_sec must be one of refresh.options_sec");
  }

  if (!["dark", "bright"].includes(need("theme").default)) problems.push('theme.default must be "dark" or "bright"');

  const lookback = need("data").lookback_days;
  if (!(isNum(lookback) && lookback >= 220)) problems.push("data.lookback_days must be at least 220 (FR-SIG-02)");

  const sig = need("signal");
  const periods = sig.periods ?? {};
  const weights = sig.weights ?? {};
  for (const k of PERIOD_KEYS) {
    if (!isNum(periods[k]) || periods[k] <= 0) problems.push(`signal.periods.${k} must be a positive number`);
  }
  for (const k of WEIGHT_KEYS) {
    if (!isNum(weights[k]) || weights[k] < 0) problems.push(`signal.weights.${k} must be a number of 0 or more`);
  }
  if (WEIGHT_KEYS.every((k) => isNum(weights[k]))) {
    const total = WEIGHT_KEYS.reduce((a, k) => a + weights[k], 0);
    if (total !== 100) {
      problems.push(`signal.weights add up to ${total}; they must add up to 100 so the score runs from -100 to +100`);
    }
  }
  const th = sig.thresholds;
  if (!isObj(th) || !["strong_buy", "buy", "sell", "strong_sell"].every((k) => isNum(th[k]))) {
    problems.push("signal.thresholds needs strong_buy, buy, sell and strong_sell");
  } else if (!(th.strong_sell < th.sell && th.sell < 0 && 0 < th.buy && th.buy < th.strong_buy)) {
    problems.push("signal.thresholds must satisfy strong_sell < sell < 0 < buy < strong_buy");
  }

  const tg = need("telegram");
  if (!TIME_RE.test(String(tg.report_time ?? ""))) {
    problems.push('telegram.report_time must be "HH:MM" in 24-hour MYT, e.g. "08:10"');
  }

  const alerts = need("alerts");
  if (!["daily", "intraday"].includes(alerts.check)) problems.push('alerts.check must be "daily" or "intraday"');
  (alerts.targets ?? []).forEach((t, i) => {
    const label = `alerts.targets[${i}]`;
    if (!isObj(t) || !seen.has(t.symbol)) { problems.push(`${label}: symbol must match a coin in "symbols"`); return; }
    const levels = ["above", "below"].filter((k) => k in t);
    if (levels.length !== 1 || !isNum(t[levels[0]]) || t[levels[0]] <= 0) {
      problems.push(`${label}: needs exactly one of "above" or "below" with a positive price`);
    }
  });

  return problems;
}

export function enabledSymbols(cfg) {
  return cfg.symbols.filter((s) => s.enabled !== false);
}

// Browser: fetch and check config/config.json (no caching, so edits show at once).
export async function loadConfig(url = "config/config.json") {
  let cfg;
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch (e) {
    throw new ConfigError(`config.json could not be read: ${e.message}`);
  }
  const problems = validate(cfg);
  if (problems.length) throw new ConfigError(`config.json has problems:\n- ${problems.join("\n- ")}`);
  return cfg;
}
