"""Technical indicators, exactly as in spec Appendix A.

Every function takes plain lists of floats (oldest first) and returns a list of
the same length, with None where there is not yet enough data.

The code is written as simple loops on purpose: js/indicators.js is a line-by-line
copy, so both languages do the same arithmetic in the same order and give the
same results (FR-SIG-05). Please change both files together.
"""
from __future__ import annotations

import math
from typing import Optional, Sequence

Series = list[Optional[float]]


def sma(values: Sequence[Optional[float]], n: int) -> Series:
    """Simple moving average: mean of the last n values."""
    out: Series = [None] * len(values)
    for t in range(n - 1, len(values)):
        window = values[t - n + 1:t + 1]
        if any(v is None for v in window):
            continue
        s = 0.0
        for v in window:
            s += v
        out[t] = s / n
    return out


def ema(values: Sequence[Optional[float]], n: int) -> Series:
    """Exponential moving average, alpha = 2/(n+1), seeded with the SMA of the
    first n available values. Leading None values (e.g. MACD warm-up) are skipped."""
    out: Series = [None] * len(values)
    start = 0
    while start < len(values) and values[start] is None:
        start += 1
    first = start + n - 1
    if first >= len(values):
        return out
    s = 0.0
    for t in range(start, first + 1):
        s += values[t]
    prev = s / n
    out[first] = prev
    alpha = 2.0 / (n + 1)
    for t in range(first + 1, len(values)):
        prev = alpha * values[t] + (1.0 - alpha) * prev
        out[t] = prev
    return out


def rsi(closes: Sequence[float], n: int = 14) -> Series:
    """Wilder's RSI. First averages = plain mean of the first n gains/losses,
    then Avg(t) = (Avg(t-1) * (n-1) + value(t)) / n.
    No losses at all gives 100; no movement at all gives 50."""
    out: Series = [None] * len(closes)
    if len(closes) <= n:
        return out
    avg_gain = 0.0
    avg_loss = 0.0
    for t in range(1, n + 1):
        change = closes[t] - closes[t - 1]
        if change > 0:
            avg_gain += change
        else:
            avg_loss -= change
    avg_gain /= n
    avg_loss /= n
    out[n] = _rsi_value(avg_gain, avg_loss)
    for t in range(n + 1, len(closes)):
        change = closes[t] - closes[t - 1]
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        avg_gain = (avg_gain * (n - 1) + gain) / n
        avg_loss = (avg_loss * (n - 1) + loss) / n
        out[t] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0.0:
        return 50.0 if avg_gain == 0.0 else 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def macd(closes: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[Series, Series, Series]:
    """MACD = EMA(fast) - EMA(slow); signal line = EMA(signal) of MACD; histogram = MACD - signal."""
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    line: Series = [
        (f - s) if f is not None and s is not None else None
        for f, s in zip(ema_fast, ema_slow)
    ]
    sig = ema(line, signal)
    hist: Series = [
        (m - g) if m is not None and g is not None else None
        for m, g in zip(line, sig)
    ]
    return line, sig, hist


def bollinger(closes: Sequence[float], n: int = 20, k: float = 2) -> tuple[Series, Series, Series]:
    """Bollinger Bands: middle = SMA(n); upper/lower = middle +/- k * standard deviation
    of the last n closes (population standard deviation, divide by n)."""
    mid = sma(closes, n)
    upper: Series = [None] * len(closes)
    lower: Series = [None] * len(closes)
    for t in range(n - 1, len(closes)):
        m = mid[t]
        ss = 0.0
        for v in closes[t - n + 1:t + 1]:
            d = v - m
            ss += d * d
        sd = math.sqrt(ss / n)
        upper[t] = m + k * sd
        lower[t] = m - k * sd
    return upper, mid, lower


def roc(closes: Sequence[float], n: int = 14) -> Series:
    """Rate of change in percent: (C(t) / C(t-n) - 1) * 100."""
    out: Series = [None] * len(closes)
    for t in range(n, len(closes)):
        if closes[t - n] != 0:
            out[t] = (closes[t] / closes[t - n] - 1.0) * 100.0
    return out


def volume_ratio(volumes: Sequence[float], n: int = 20) -> Series:
    """Today's volume divided by the n-day average volume (the average includes today)."""
    avg = sma(volumes, n)
    return [
        (v / a) if a is not None and a > 0 else None
        for v, a in zip(volumes, avg)
    ]
