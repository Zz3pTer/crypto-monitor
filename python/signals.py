"""Rules R1-R7, score, BUY/HOLD/SELL with hysteresis, and events (spec 4.4).

Input candles are completed daily candles, oldest first, each a dict with
open, high, low, close, volume (and any time field). All numbers come from
config["signal"]. js/signals.js mirrors this file; change both together.
"""
from __future__ import annotations

from typing import Optional, Sequence

import indicators as ind

RULES = ("trend", "cross", "macd", "rsi", "bollinger", "momentum", "volume")
BUY, HOLD, SELL = "BUY", "HOLD", "SELL"


def compute_indicators(candles: Sequence[dict], sig_cfg: dict) -> dict[str, list]:
    """Every indicator as a full series aligned with the candles."""
    p = sig_cfg["periods"]
    closes = [float(c["close"]) for c in candles]
    volumes = [float(c["volume"]) for c in candles]
    macd_line, macd_sig, macd_hist = ind.macd(closes, p["macd_fast"], p["macd_slow"], p["macd_signal"])
    bb_upper, bb_mid, bb_lower = ind.bollinger(closes, p["bb"], p["bb_std"])
    return {
        "close": closes,
        "volume": volumes,
        "sma50": ind.sma(closes, p["sma_fast"]),
        "sma200": ind.sma(closes, p["sma_slow"]),
        "ema20": ind.ema(closes, p["ema"]),
        "rsi14": ind.rsi(closes, p["rsi"]),
        "macd": macd_line,
        "macd_signal": macd_sig,
        "macd_hist": macd_hist,
        "bb_upper": bb_upper,
        "bb_middle": bb_mid,
        "bb_lower": bb_lower,
        "roc14": ind.roc(closes, p["roc"]),
        "vol_ratio": ind.volume_ratio(volumes, p["vol_avg"]),
    }


def _sign_vote(bullish: bool, bearish: bool) -> int:
    return 1 if bullish else -1 if bearish else 0


def votes_at(series: dict[str, list], t: int, sig_cfg: dict) -> Optional[dict[str, int]]:
    """Votes of R1-R7 on day t, or None if any input is not available yet."""
    if t < 1:
        return None
    need = ("sma50", "sma200", "rsi14", "macd", "macd_signal", "bb_upper", "bb_lower", "roc14", "vol_ratio")
    if any(series[k][t] is None for k in need) or series["macd_hist"][t] is None or series["macd_hist"][t - 1] is None:
        return None
    s = {k: v[t] for k, v in series.items()}
    close, prev_close = s["close"], series["close"][t - 1]
    hist, prev_hist = s["macd_hist"], series["macd_hist"][t - 1]
    spike = s["vol_ratio"] > sig_cfg["volume_spike"]
    return {
        "trend": _sign_vote(close > s["sma200"], close < s["sma200"]),
        "cross": _sign_vote(s["sma50"] > s["sma200"], s["sma50"] < s["sma200"]),
        "macd": _sign_vote(s["macd"] > s["macd_signal"] and hist > prev_hist,
                           s["macd"] < s["macd_signal"] and hist < prev_hist),
        "rsi": _sign_vote(s["rsi14"] < sig_cfg["rsi_oversold"], s["rsi14"] > sig_cfg["rsi_overbought"]),
        "bollinger": _sign_vote(close < s["bb_lower"], close > s["bb_upper"]),
        "momentum": _sign_vote(s["roc14"] > sig_cfg["roc_pct"], s["roc14"] < -sig_cfg["roc_pct"]),
        "volume": _sign_vote(spike and close > prev_close, spike and close < prev_close),
    }


def score_of(votes: dict[str, int], sig_cfg: dict) -> int:
    w = sig_cfg["weights"]
    return int(sum(votes[r] * w[r] for r in RULES))


def classify(score: float, previous: Optional[str], sig_cfg: dict) -> tuple[str, bool]:
    """Score -> (signal, strong). A BUY or SELL only falls back to HOLD once the
    score is `hysteresis` points back inside the threshold (FR-SIG-03)."""
    th = sig_cfg["thresholds"]
    h = sig_cfg["hysteresis"]
    if score >= th["buy"]:
        signal = BUY
    elif score <= th["sell"]:
        signal = SELL
    elif previous == BUY and score >= th["buy"] - h:
        signal = BUY
    elif previous == SELL and score <= th["sell"] + h:
        signal = SELL
    else:
        signal = HOLD
    strong = (signal == BUY and score >= th["strong_buy"]) or (signal == SELL and score <= th["strong_sell"])
    return signal, strong


def events_at(series: dict[str, list], t: int, signal: str, previous: Optional[str], sig_cfg: dict) -> list[str]:
    """FR-SIG-06 flags for day t."""
    events: list[str] = []
    if previous is not None and signal != previous:
        events.append("signal_changed")
    fast, slow = series["sma50"], series["sma200"]
    for k in range(sig_cfg.get("cross_lookback_days", 3)):
        a, b = t - k, t - k - 1
        if b < 0 or None in (fast[a], slow[a], fast[b], slow[b]):
            break
        if fast[b] <= slow[b] and fast[a] > slow[a]:
            events.append("golden_cross")
            break
        if fast[b] >= slow[b] and fast[a] < slow[a]:
            events.append("death_cross")
            break
    r_now, r_prev = series["rsi14"][t], series["rsi14"][t - 1] if t >= 1 else None
    if r_now is not None and r_prev is not None:
        if r_now > sig_cfg["rsi_overbought"] >= r_prev:
            events.append("rsi_overbought")
        if r_now < sig_cfg["rsi_oversold"] <= r_prev:
            events.append("rsi_oversold")
    return events


INDICATOR_KEYS = ("sma50", "sma200", "ema20", "rsi14", "macd", "macd_signal", "macd_hist",
                  "bb_upper", "bb_middle", "bb_lower", "roc14", "vol_ratio")


def evaluate(candles: Sequence[dict], sig_cfg: dict, previous: Optional[str] = None) -> dict:
    """Official (or provisional) signal on the last candle.

    `previous` is yesterday's official signal, used for hysteresis and the
    'changed' flag. Returns the fields stored per asset in signals.json."""
    if len(candles) < sig_cfg["min_candles"]:
        return {"status": "insufficient_history", "message": "Not enough history",
                "candles": len(candles), "previous_signal": previous}
    series = compute_indicators(candles, sig_cfg)
    t = len(candles) - 1
    votes = votes_at(series, t, sig_cfg)
    if votes is None:  # cannot happen with min_candles >= 220 and default periods
        return {"status": "insufficient_history", "message": "Not enough history",
                "candles": len(candles), "previous_signal": previous}
    score = score_of(votes, sig_cfg)
    signal, strong = classify(score, previous, sig_cfg)
    return {
        "status": "ok",
        "close": series["close"][t],
        "score": score,
        "signal": signal,
        "strong": strong,
        "previous_signal": previous,
        "changed": previous is not None and signal != previous,
        "indicators": {k: series[k][t] for k in INDICATOR_KEYS},
        "votes": votes,
        "events": events_at(series, t, signal, previous, sig_cfg),
    }


def evaluate_series(candles: Sequence[dict], sig_cfg: dict) -> list[Optional[dict]]:
    """Signal for every day, carrying hysteresis forward day by day.
    Used to build the history files and by the backtest. Days without enough
    data are None. Day t only uses candles 0..t, so there is no look-ahead."""
    series = compute_indicators(candles, sig_cfg)
    out: list[Optional[dict]] = [None] * len(candles)
    previous: Optional[str] = None
    for t in range(len(candles)):
        if t + 1 < sig_cfg["min_candles"]:
            continue
        votes = votes_at(series, t, sig_cfg)
        if votes is None:
            continue
        score = score_of(votes, sig_cfg)
        signal, strong = classify(score, previous, sig_cfg)
        out[t] = {"close": series["close"][t], "score": score, "signal": signal, "strong": strong,
                  "votes": votes}
        previous = signal
    return out
