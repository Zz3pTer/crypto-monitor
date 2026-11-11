import math
import random

import pandas as pd
import pytest

import indicators as ind


def close_enough(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(b))


@pytest.fixture(scope="module")
def walk():
    """A reproducible random price walk (300 days)."""
    rng = random.Random(42)
    price, out = 100.0, []
    for _ in range(300):
        price *= 1 + rng.uniform(-0.04, 0.04)
        out.append(price)
    return out


def test_sma_small_example():
    assert ind.sma([1, 2, 3, 4, 5], 3) == [None, None, 2.0, 3.0, 4.0]


def test_sma_matches_pandas(walk):
    ref = pd.Series(walk).rolling(50).mean().tolist()
    mine = ind.sma(walk, 50)
    assert mine[:49] == [None] * 49
    assert all(close_enough(m, r) for m, r in zip(mine[49:], ref[49:]))


def test_ema_is_seeded_with_sma():
    out = ind.ema([2, 4, 6, 8], 3)  # alpha = 0.5, seed = mean(2,4,6) = 4
    assert out == [None, None, 4.0, 6.0]


def test_ema_matches_pandas_with_sma_seed(walk):
    n = 20
    seeded = pd.Series([sum(walk[:n]) / n] + walk[n:])
    ref = seeded.ewm(span=n, adjust=False).mean().tolist()
    mine = ind.ema(walk, n)[n - 1:]
    assert all(close_enough(m, r) for m, r in zip(mine, ref))


def test_ema_skips_leading_none():
    assert ind.ema([None, None, 2, 4, 6, 8], 3) == [None, None, None, None, 4.0, 6.0]


# StockCharts' published Wilder RSI(14) example ("RSI" ChartSchool article).
STOCKCHARTS_CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
                      46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
                      43.42, 42.66, 43.13]
STOCKCHARTS_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38,
                   54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77]


def test_rsi_matches_published_wilder_example():
    # StockCharts rounds the average gain/loss to 4 decimals at each step, which
    # puts their figures about 0.07 above exact arithmetic (70.53 vs 70.46).
    out = ind.rsi(STOCKCHARTS_CLOSES, 14)
    assert out[:14] == [None] * 14
    assert out[14:] == pytest.approx(STOCKCHARTS_RSI, abs=0.1)


def test_rsi_matches_independent_pandas_wilder(walk):
    n = 14
    change = pd.Series(walk).diff()
    gains, losses = change.clip(lower=0), (-change).clip(lower=0)
    def wilder(x):
        seeded = pd.Series([x[1:n + 1].mean()] + x[n + 1:].tolist())
        return seeded.ewm(alpha=1 / n, adjust=False).mean()
    ag, al = wilder(gains), wilder(losses)
    ref = (100 - 100 / (1 + ag / al)).tolist()
    mine = ind.rsi(walk, n)[n:]
    assert all(close_enough(m, r, 1e-8) for m, r in zip(mine, ref))


def test_rsi_extremes():
    assert ind.rsi(list(range(1, 30)), 14)[-1] == 100.0        # only gains
    assert ind.rsi(list(range(30, 1, -1)), 14)[-1] == 0.0      # only losses
    assert ind.rsi([5.0] * 30, 14)[-1] == 50.0                 # no movement


def test_rsi_stays_in_range(walk):
    vals = [v for v in ind.rsi(walk, 14) if v is not None]
    assert all(0 <= v <= 100 for v in vals)


def test_macd_parts_fit_together(walk):
    line, sig, hist = ind.macd(walk, 12, 26, 9)
    first_line = 25
    first_sig = first_line + 8
    assert line[first_line - 1] is None and line[first_line] is not None
    assert sig[first_sig - 1] is None and sig[first_sig] is not None
    for t in range(first_sig, len(walk)):
        assert close_enough(hist[t], line[t] - sig[t])


def test_macd_line_matches_pandas(walk):
    s = pd.Series(walk)
    def seeded_ema(n):
        seeded = pd.Series([s[:n].mean()] + s[n:].tolist())
        return [None] * (n - 1) + seeded.ewm(span=n, adjust=False).mean().tolist()
    ref = [a - b for a, b in zip(seeded_ema(12)[25:], seeded_ema(26)[25:])]
    line, _, _ = ind.macd(walk, 12, 26, 9)
    assert all(close_enough(m, r, 1e-8) for m, r in zip(line[25:], ref))


def test_bollinger_flat_prices_have_zero_width():
    up, mid, lo = ind.bollinger([10.0] * 25, 20, 2)
    assert up[-1] == mid[-1] == lo[-1] == 10.0


def test_bollinger_uses_population_std(walk):
    up, mid, lo = ind.bollinger(walk, 20, 2)
    ref_std = pd.Series(walk).rolling(20).std(ddof=0).tolist()
    for t in range(19, len(walk)):
        assert close_enough(up[t] - mid[t], 2 * ref_std[t], 1e-7)
        assert close_enough(mid[t] - lo[t], 2 * ref_std[t], 1e-7)


def test_roc():
    out = ind.roc([100, 101, 102, 110], 3)
    assert out[:3] == [None] * 3
    assert out[3] == pytest.approx(10.0)


def test_volume_ratio():
    vols = [100.0] * 19 + [300.0]
    out = ind.volume_ratio(vols, 20)
    assert out[-1] == pytest.approx(300 / 110)
    assert out[18] is None
