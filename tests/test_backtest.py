"""Backtest maths (FR-HIST-03) and the paged Binance download."""
import json
from pathlib import Path

import pytest

import backtest as B
import fetch_data
import signals as S

FIX = Path(__file__).parent / "fixtures"
DAY = 86_400_000
BT = {"years": 2, "horizons_days": [2], "fee_pct": 0.0}


def make(closes):
    return [{"time": i * DAY, "close_time": (i + 1) * DAY, "open": c, "high": c, "low": c, "close": c, "volume": 1}
            for i, c in enumerate(closes)]


@pytest.fixture
def fake_signals(monkeypatch):
    """Replace the rules with a fixed list of signals (None = warm-up)."""
    def use(sigs):
        monkeypatch.setattr(B.S, "evaluate_series",
                            lambda candles, cfg: [{"signal": s} if s else None for s in sigs])
    return use


def test_hit_rates_count_each_turn_once(fake_signals):
    closes = [100, 100, 110, 120, 130, 120, 110, 100, 90]
    fake_signals([None, "HOLD", "BUY", "BUY", "HOLD", "SELL", "SELL", "HOLD", "HOLD"])
    r = B.run_asset(make(closes), {}, BT)
    h = r["horizons"][0]
    # BUY on day 2 (110 -> 130 two days later: right). SELL on day 5 (120 -> 100: right).
    assert (h["buy_count"], h["buy_hit_rate"]) == (1, 1.0)
    assert (h["sell_count"], h["sell_hit_rate"]) == (1, 1.0)
    assert h["buy_avg_change_pct"] == pytest.approx(round((130 / 110 - 1) * 100, 2))
    assert r["signal_changes"] == 4          # HOLD>BUY, BUY>HOLD, HOLD>SELL, SELL>HOLD
    assert (r["buy_signals"], r["sell_signals"]) == (1, 1)


def test_signals_without_a_result_yet_are_not_counted(fake_signals):
    fake_signals([None, "HOLD", "HOLD", "HOLD", "BUY"])
    h = B.run_asset(make([1, 1, 1, 1, 1]), {}, BT)["horizons"][0]
    assert h["buy_count"] == 0 and h["buy_hit_rate"] is None


def test_wrong_signals(fake_signals):
    fake_signals([None, "HOLD", "BUY", "HOLD", "SELL", "HOLD", "HOLD"])
    h = B.run_asset(make([100, 100, 100, 90, 80, 90, 95]), {}, BT)["horizons"][0]
    assert h["buy_hit_rate"] == 0.0 and h["sell_hit_rate"] == 0.0


def test_strategy_holds_from_buy_to_sell(fake_signals):
    closes = [100, 100, 110, 121, 100, 50, 60]
    fake_signals([None, "HOLD", "BUY", "HOLD", "SELL", "HOLD", "BUY"])
    r = B.run_asset(make(closes), {}, BT)
    # bought at 110, HOLD keeps it, sold at 100; bought again at 60 on the last day
    assert r["strategy_return_pct"] == pytest.approx(round((100 / 110 - 1) * 100, 2))
    assert r["buy_hold_return_pct"] == pytest.approx(-40.0)
    assert r["trades"] == 3 and r["still_holding"] is True
    assert r["start"] == "1970-01-03" and r["days"] == 5


def test_fees_are_charged_per_trade(fake_signals):
    fake_signals([None, "BUY", "BUY", "SELL"])
    r = B.run_asset(make([100, 100, 100, 100]), {}, {**BT, "fee_pct": 1.0})
    assert r["strategy_return_pct"] == pytest.approx(round((0.99 * 0.99 - 1) * 100, 2))


def test_always_buy_without_fees_equals_buy_and_hold(fake_signals):
    closes = [100, 103, 99, 120, 80, 140]
    fake_signals(["BUY"] * 6)
    r = B.run_asset(make(closes), {}, BT)
    assert r["strategy_return_pct"] == r["buy_hold_return_pct"] == 40.0
    assert r["time_in_market_pct"] == 100.0


def test_period_is_limited_to_the_configured_years(fake_signals):
    fake_signals(["HOLD"] * 900)
    r = B.run_asset(make([1] * 900), {}, {**BT, "years": 1})
    assert r["days"] == 364 and r["period"] == "364 days" and not r["short_history"]
    r = B.run_asset(make([1] * 300), {}, {**BT, "years": 1})
    assert r["short_history"] is True


def test_not_enough_history():
    cfg = json.loads((Path(__file__).parents[1] / "config/config.json").read_text())
    r = B.run_asset(make([1.0] * 100), cfg["signal"], BT)
    assert r["status"] == "insufficient_history"


def real_candles(sym="BTC"):
    raw = json.loads((FIX / "parity_candles.json").read_text())["assets"][sym]
    return [{"time": r[0], "close_time": r[0] + DAY, "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}
            for r in raw]


def test_real_rules_on_fixture_data():
    cfg = json.loads((Path(__file__).parents[1] / "config/config.json").read_text())
    r = B.run_asset(real_candles(), cfg["signal"], {"years": 2, "horizons_days": [7, 30], "fee_pct": 0.1})
    assert r["status"] == "ok" and r["short_history"] is True      # the fixture has 500 days
    assert r["days"] == 500 - cfg["signal"]["min_candles"]
    for h in r["horizons"]:
        for k in ("buy", "sell"):
            assert h[f"{k}_count"] > 0 and 0 <= h[f"{k}_hit_rate"] <= 1
    # no look-ahead: cutting off the last 40 days does not change any earlier signal
    full = S.evaluate_series(real_candles(), cfg["signal"])
    cut = S.evaluate_series(real_candles()[:-40], cfg["signal"])
    assert full[:-40] == cut


def test_run_reports_errors_and_summary(tmp_path):
    cfg = json.loads((Path(__file__).parents[1] / "config/config.json").read_text())

    class Fetch:
        def daily_candles(self, cfg, coin, now_ms, days):
            assert days == 2 * 365 + cfg["signal"]["min_candles"]
            if coin["symbol"] == "SOL":
                raise fetch_data.DataError("down")
            return real_candles(coin["symbol"]), "binance"

    out = B.run(cfg, fetch=Fetch())
    by = {a["symbol"]: a for a in out["assets"]}
    assert by["SOL"]["status"] == "error" and by["BTC"]["status"] == "ok"
    s = out["summary"]
    assert s["coins"] == len(out["assets"]) - 1
    assert s["horizons"][0]["buy_count"] == sum(a["horizons"][0]["buy_count"] for a in by.values() if a["status"] == "ok")
    assert "Past results" in out["method"]


def test_binance_download_is_paged(monkeypatch):
    # 2500 daily candles exist; the last one is still open
    rows = [[i * DAY, "1", "1", "1", str(i), "1", (i + 1) * DAY - 1] for i in range(2500)]
    calls = []

    def fake_get(url, params):
        calls.append(params)
        end = params.get("endTime", 10 ** 15)
        part = [r for r in rows if r[0] <= end][-params["limit"]:]
        return part

    monkeypatch.setattr(fetch_data, "_get", fake_get)
    cfg = {"data": {"providers": {"binance": {"rest": "x"}}}}
    out = fetch_data.binance_daily(cfg, "BTCUSDT", 2200, now_ms=2499 * DAY + 5)
    assert len(out) == 2200 and len(calls) == 3
    assert [c["close"] for c in out] == [float(i) for i in range(299, 2499)]   # open candle dropped, no gaps
    # few candles: one request, as before
    calls.clear()
    assert len(fetch_data.binance_daily(cfg, "BTCUSDT", 400, now_ms=2499 * DAY + 5)) == 400 and len(calls) == 1
