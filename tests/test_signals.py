import copy
import random

import pytest

import config as C
import signals as S


@pytest.fixture(scope="module")
def sig():
    return C.load_config()["signal"]


def make_candles(closes, volumes=None):
    volumes = volumes or [1000.0] * len(closes)
    return [{"open": c, "high": c, "low": c, "close": c, "volume": v} for c, v in zip(closes, volumes)]


def trend(n, start=100.0, step=0.003, seed=1):
    rng = random.Random(seed)
    out, p = [], start
    for _ in range(n):
        p *= 1 + step + rng.uniform(-0.01, 0.01)
        out.append(p)
    return out


# ---- thresholds and hysteresis (spec 4.4 table, FR-SIG-03) ----

@pytest.mark.parametrize("score, signal, strong", [
    (100, "BUY", True), (65, "BUY", True), (64, "BUY", False), (35, "BUY", False),
    (34, "HOLD", False), (0, "HOLD", False), (-34, "HOLD", False),
    (-35, "SELL", False), (-64, "SELL", False), (-65, "SELL", True), (-100, "SELL", True),
])
def test_thresholds_without_history(sig, score, signal, strong):
    assert S.classify(score, None, sig) == (signal, strong)


@pytest.mark.parametrize("previous, score, expected", [
    ("BUY", 34, "BUY"), ("BUY", 30, "BUY"), ("BUY", 29, "HOLD"),       # BUY stays BUY until below +30
    ("SELL", -34, "SELL"), ("SELL", -30, "SELL"), ("SELL", -29, "HOLD"),
    ("HOLD", 34, "HOLD"), ("HOLD", -34, "HOLD"),                       # no buffer when entering
    ("BUY", -40, "SELL"), ("SELL", 40, "BUY"),                         # full swing goes straight across
])
def test_hysteresis(sig, previous, score, expected):
    assert S.classify(score, previous, sig)[0] == expected


def test_strong_only_from_score(sig):
    assert S.classify(32, "BUY", sig) == ("BUY", False)


# ---- individual rules ----

def series_for(**today):
    """Two-day series where day 1 has the given values and day 0 the 'prev_' ones."""
    base = {"close": 100.0, "volume": 1000.0, "sma50": 100.0, "sma200": 100.0, "ema20": 100.0,
            "rsi14": 50.0, "macd": 0.0, "macd_signal": 0.0, "macd_hist": 0.0,
            "bb_upper": 110.0, "bb_middle": 100.0, "bb_lower": 90.0, "roc14": 0.0, "vol_ratio": 1.0}
    prev = {k: base[k] for k in base}
    cur = dict(base)
    for k, v in today.items():
        if k.startswith("prev_"):
            prev[k[5:]] = v
        else:
            cur[k] = v
    return {k: [prev[k], cur[k]] for k in base}


@pytest.mark.parametrize("values, rule, vote", [
    ({"close": 101, "bb_upper": 200}, "trend", 1),
    ({"close": 99}, "trend", -1),
    ({"sma50": 105}, "cross", 1),
    ({"sma50": 95}, "cross", -1),
    ({"macd": 2, "macd_signal": 1, "macd_hist": 1, "prev_macd_hist": 0.5}, "macd", 1),
    ({"macd": 2, "macd_signal": 1, "macd_hist": 1, "prev_macd_hist": 1.5}, "macd", 0),   # above but falling
    ({"macd": 1, "macd_signal": 2, "macd_hist": -1, "prev_macd_hist": -0.5}, "macd", -1),
    ({"rsi14": 29.9}, "rsi", 1),
    ({"rsi14": 30}, "rsi", 0),
    ({"rsi14": 70.1}, "rsi", -1),
    ({"close": 89, "sma200": 80}, "bollinger", 1),
    ({"close": 111, "sma200": 120}, "bollinger", -1),
    ({"roc14": 5.1}, "momentum", 1),
    ({"roc14": 5.0}, "momentum", 0),
    ({"roc14": -5.1}, "momentum", -1),
    ({"vol_ratio": 1.6, "close": 101, "prev_close": 100}, "volume", 1),
    ({"vol_ratio": 1.6, "close": 99, "prev_close": 100}, "volume", -1),
    ({"vol_ratio": 1.5, "close": 101, "prev_close": 100}, "volume", 0),
])
def test_rule_votes(sig, values, rule, vote):
    assert S.votes_at(series_for(**values), 1, sig)[rule] == vote


def test_score_is_weighted_sum(sig):
    votes = {"trend": 1, "cross": 1, "macd": -1, "rsi": 0, "bollinger": 0, "momentum": 1, "volume": -1}
    assert S.score_of(votes, sig) == 20 + 15 - 20 + 10 - 10


def test_all_bullish_scores_100(sig):
    assert S.score_of({r: 1 for r in S.RULES}, sig) == 100


# ---- evaluate ----

def test_not_enough_history(sig):
    out = S.evaluate(make_candles(trend(219)), sig)
    assert out["status"] == "insufficient_history"
    assert out["message"] == "Not enough history"


def test_steady_uptrend_is_bullish_on_trend_rules(sig):
    out = S.evaluate(make_candles(trend(400)), sig, previous="HOLD")
    assert out["status"] == "ok"
    assert out["votes"]["trend"] == 1 and out["votes"]["cross"] == 1
    assert -100 <= out["score"] <= 100
    assert out["score"] == S.score_of(out["votes"], sig)
    assert set(out["indicators"]) == set(S.INDICATOR_KEYS)
    assert out["changed"] == (out["signal"] != "HOLD")


def test_steady_downtrend_is_bearish_on_trend_rules(sig):
    out = S.evaluate(make_candles(trend(400, step=-0.003)), sig)
    assert out["votes"]["trend"] == -1 and out["votes"]["cross"] == -1


def test_series_has_no_look_ahead(sig):
    closes = trend(400, step=0.0, seed=7)
    full = S.evaluate_series(make_candles(closes), sig)
    part = S.evaluate_series(make_candles(closes[:300]), sig)
    assert full[:300] == part


def test_series_last_day_matches_evaluate(sig):
    closes = trend(400, step=0.0, seed=3)
    series = S.evaluate_series(make_candles(closes), sig)
    prev = series[-2]["signal"]
    single = S.evaluate(make_candles(closes), sig, previous=prev)
    assert (single["score"], single["signal"]) == (series[-1]["score"], series[-1]["signal"])


def test_config_changes_are_used(sig):
    closes = make_candles(trend(400))
    custom = copy.deepcopy(sig)
    custom["weights"] = {"trend": 100, "cross": 0, "macd": 0, "rsi": 0, "bollinger": 0, "momentum": 0, "volume": 0}
    assert S.evaluate(closes, custom)["score"] == 100


# ---- events (FR-SIG-06) ----

def test_golden_cross_event(sig):
    s = series_for(sma50=101, prev_sma50=99)
    assert "golden_cross" in S.events_at(s, 1, "HOLD", "HOLD", sig)


def test_death_cross_event(sig):
    s = series_for(sma50=99, prev_sma50=101)
    assert "death_cross" in S.events_at(s, 1, "HOLD", "HOLD", sig)


def test_rsi_entry_events(sig):
    assert "rsi_overbought" in S.events_at(series_for(rsi14=71, prev_rsi14=69), 1, "HOLD", "HOLD", sig)
    assert "rsi_oversold" in S.events_at(series_for(rsi14=29, prev_rsi14=31), 1, "HOLD", "HOLD", sig)
    assert S.events_at(series_for(rsi14=75, prev_rsi14=72), 1, "HOLD", "HOLD", sig) == []


def test_signal_changed_event(sig):
    assert S.events_at(series_for(), 1, "BUY", "HOLD", sig) == ["signal_changed"]
    assert S.events_at(series_for(), 1, "HOLD", None, sig) == []
