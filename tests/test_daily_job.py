"""Daily job tests with fake market data and a fake Telegram (no network)."""
import copy
import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

import alerts
import config as C
import fetch_data
import main as M
import telegram_notifier as tg

MYT = ZoneInfo("Asia/Kuala_Lumpur")
FIX = Path(__file__).resolve().parent / "fixtures" / "parity_candles.json"
RAW = json.loads(FIX.read_text(encoding="utf-8"))["assets"]
DAY = 86_400_000
KEYS = {"telegram_bot_token": "x", "telegram_chat_id": "1"}


def candles(sym, drop_last=0):
    rows = RAW[sym][: len(RAW[sym]) - drop_last] if drop_last else RAW[sym]
    return [{"time": r[0], "close_time": r[0] + DAY, "open": r[1], "high": r[2], "low": r[3],
             "close": r[4], "volume": r[5]} for r in rows]


def last_close_myt(sym="BTC", drop_last=0):
    return M.ms_to_myt(candles(sym, drop_last)[-1]["close_time"], MYT)


class FakeFetch:
    DataError = fetch_data.DataError

    def __init__(self, broken=(), drop_last=0, live_factor=1.0):
        self.broken, self.drop_last, self.live_factor = set(broken), drop_last, live_factor

    def daily_candles(self, cfg, coin, now_ms, days=None):
        if coin["symbol"] in self.broken:
            raise fetch_data.DataError("bad pair")
        return candles(coin["symbol"], self.drop_last), "binance"

    def binance_today(self, cfg, pair, days):
        sym = pair.replace("USDT", "")
        cs = candles(sym, self.drop_last)
        if self.live_factor == 1.0:
            return cs                       # nothing new since the close
        last = dict(cs[-1])
        last["close"] = last["close"] * self.live_factor
        return cs + [dict(last, time=last["time"] + DAY, close_time=last["close_time"] + DAY)]

    def binance_prices(self, cfg, pairs):
        return {p: candles(p.replace("USDT", ""), self.drop_last)[-1]["close"] * self.live_factor for p in pairs}


@pytest.fixture
def cfg():
    return C.load_config(C.ROOT / "tests" / "fixtures" / "config_base.json")


@pytest.fixture
def sent():
    return []


def make_job(cfg, tmp_path, sent, now=None, test=False, fetch=None):
    now = now or last_close_myt() + timedelta(minutes=10)
    return M.Job(cfg, KEYS, now, test=test, data_dir=tmp_path, fetch=fetch or FakeFetch(),
                 send=lambda keys, text, retries=3: sent.append(text), log=lambda *a: None)


# ---------- report timing ----------

@pytest.mark.parametrize("hhmm, last, expected", [
    ("08:10", None, True), ("08:10", "2026-11-10", True), ("08:10", "2026-11-11", False),
    ("08:11", None, False), ("07:00", None, True), ("23:59", None, False),
])
def test_report_due(hhmm, last, expected):
    now = datetime(2026, 11, 11, 8, 10, tzinfo=MYT)
    assert M.report_due(now, hhmm, last) is expected


# ---------- daily run ----------

def test_daily_run_writes_files_and_sends_report(cfg, tmp_path, sent):
    make_job(cfg, tmp_path, sent).run()
    sig = json.loads((tmp_path / "signals.json").read_text(encoding="utf-8"))
    assert [a["symbol"] for a in sig["assets"]] == [c["symbol"] for c in C.enabled_symbols(cfg)]
    assert all(a["status"] == "ok" and a["signal"] in ("BUY", "HOLD", "SELL") for a in sig["assets"])
    assert sig["candle_close"].endswith("+08:00") and sig["generated_at"].endswith("+08:00")   # FR-TIME-04
    hist = json.loads((tmp_path / "history" / "BTC.json").read_text(encoding="utf-8"))
    assert len(hist) > 200 and hist[-1]["date"] == last_close_myt().date().isoformat()
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["last_report_date"] == last_close_myt().date().isoformat()
    assert len(sent) == 1
    msg = sent[0]
    assert "Daily Crypto Signals" in msg and tg.DISCLAIMER in msg and cfg["telegram"]["dashboard_url"] in msg
    assert "[TEST]" not in msg


def test_second_run_same_day_does_not_resend(cfg, tmp_path, sent):
    make_job(cfg, tmp_path, sent).run()
    make_job(cfg, tmp_path, sent, now=last_close_myt() + timedelta(minutes=25)).run()
    assert sum("Daily Crypto Signals" in m for m in sent) == 1


def test_test_mode_saves_nothing(cfg, tmp_path, sent):
    make_job(cfg, tmp_path, sent, test=True).run()
    assert list(tmp_path.iterdir()) == []
    assert sent[0].startswith("<b>[TEST]</b>")


def test_one_coin_missing_still_reports(cfg, tmp_path, sent):
    make_job(cfg, tmp_path, sent, fetch=FakeFetch(broken={"ALGO"})).run()
    sig = json.loads((tmp_path / "signals.json").read_text(encoding="utf-8"))
    algo = next(a for a in sig["assets"] if a["symbol"] == "ALGO")
    assert algo["status"] == "unavailable"
    assert "Data unavailable" in sent[0] and "ALGO (data unavailable)" in sent[0]


def test_all_coins_missing_is_a_failure(cfg, tmp_path, sent):
    with pytest.raises(RuntimeError, match="no market data"):
        make_job(cfg, tmp_path, sent, fetch=FakeFetch(broken={c["symbol"] for c in cfg["symbols"]})).run()


def test_next_day_uses_yesterdays_signal_and_appends_history(cfg, tmp_path, sent):
    day1 = last_close_myt(drop_last=1) + timedelta(minutes=10)
    make_job(cfg, tmp_path, sent, now=day1, fetch=FakeFetch(drop_last=1)).run()
    sig1 = {a["symbol"]: a for a in json.loads((tmp_path / "signals.json").read_text())["assets"]}
    n1 = len(json.loads((tmp_path / "history" / "ETH.json").read_text()))
    make_job(cfg, tmp_path, sent).run()
    sig2 = {a["symbol"]: a for a in json.loads((tmp_path / "signals.json").read_text())["assets"]}
    assert all(sig2[s]["previous_signal"] == sig1[s]["signal"] for s in sig2)
    hist = json.loads((tmp_path / "history" / "ETH.json").read_text())
    assert len(hist) == n1 + 1 and hist == sorted(hist, key=lambda h: h["date"])
    assert len(sent) == 2


def test_history_is_trimmed(cfg, tmp_path, sent):
    cfg = copy.deepcopy(cfg)
    cfg["data"]["history_keep_days"] = 30
    make_job(cfg, tmp_path, sent).run()
    assert len(json.loads((tmp_path / "history" / "BTC.json").read_text())) == 30


# ---------- price targets ----------

def test_daily_price_target_reported_once(cfg, tmp_path, sent):
    cfg = copy.deepcopy(cfg)
    cfg["alerts"]["targets"] = [{"symbol": "BTC", "below": 10_000_000}]
    day1 = last_close_myt(drop_last=1) + timedelta(minutes=10)
    make_job(cfg, tmp_path, sent, now=day1, fetch=FakeFetch(drop_last=1)).run()
    make_job(cfg, tmp_path, sent).run()
    assert "Price targets reached" in sent[0] and "BTC is at or below $10,000,000" in sent[0]
    assert "Price targets reached" not in sent[1]


def test_intraday_price_target_sent_between_reports(cfg, tmp_path, sent):
    cfg = copy.deepcopy(cfg)
    cfg["alerts"].update(check="intraday", signal_change=False, targets=[{"symbol": "ETH", "above": 1}])
    make_job(cfg, tmp_path, sent).run()                                   # report, no target check
    later = last_close_myt() + timedelta(hours=3)
    make_job(cfg, tmp_path, sent, now=later).run()                         # intraday: fires
    make_job(cfg, tmp_path, sent, now=later + timedelta(minutes=15)).run()  # still above: silent
    assert len(sent) == 2 and "Price target reached" in sent[1] and "ETH is at or above $1.000" in sent[1]


def test_targets_rearm_after_moving_back():
    t = [{"symbol": "BTC", "above": 100}]
    f1, s = alerts.check_targets(t, {"BTC": 101}, {})
    f2, s = alerts.check_targets(t, {"BTC": 102}, s)
    f3, s = alerts.check_targets(t, {"BTC": 99}, s)
    f4, s = alerts.check_targets(t, {"BTC": 100}, s)
    assert [len(f1), len(f2), len(f3), len(f4)] == [1, 0, 0, 1]


def test_target_without_price_keeps_state():
    t = [{"symbol": "BTC", "below": 50}]
    f, s = alerts.check_targets(t, {}, {"BTC:below:50": {"armed": False}})
    assert f == [] and s == {"BTC:below:50": {"armed": False}}


# ---------- live signal changes ----------

def test_signal_change_alert(cfg, tmp_path, sent):
    make_job(cfg, tmp_path, sent).run()                     # sets official signals
    later = last_close_myt() + timedelta(hours=2)
    make_job(cfg, tmp_path, sent, now=later, fetch=FakeFetch(live_factor=1.0)).run()
    quiet = len(sent)
    make_job(cfg, tmp_path, sent, now=later + timedelta(minutes=15), fetch=FakeFetch(live_factor=0.5)).run()
    assert quiet == 1                                       # unchanged market: no alert
    assert len(sent) == 2 and "Live signal change" in sent[1] and "Provisional" in sent[1]


def test_signal_changes_first_sighting_is_silent():
    changes, last = alerts.signal_changes({"BTC": {"signal": "BUY", "score": 40, "price": 1}}, {})
    assert changes == [] and last == {"BTC": "BUY"}


# ---------- Telegram ----------

@pytest.mark.parametrize("price, text", [
    (104820, "$104,820"), (3912.55, "$3,912.55"), (212.4, "$212.40"), (24.36, "$24.36"),
    (2.418, "$2.418"), (0.2214, "$0.2214"), (0.742, "$0.7420"),
])
def test_price_format_matches_figure_2(price, text):
    assert tg.fmt_price(price) == text


def test_time_format():
    assert tg.fmt_myt(datetime(2026, 11, 11, 8, 10, tzinfo=MYT)) == "11 Nov 2026, 08:10 MYT"
    assert tg.fmt_myt(datetime(2026, 11, 11, 8, 10, tzinfo=MYT), weekday=True) == "Wed 11 Nov 2026, 08:10 MYT"


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def test_send_retries_then_succeeds():
    calls = []
    def post(url, json, timeout):
        calls.append(1)
        return Resp(502, {"ok": False}) if len(calls) < 3 else Resp(200, {"ok": True})
    tg.send(KEYS, "hi", retries=3, post=post, sleep=lambda s: None)
    assert len(calls) == 3


def test_send_gives_up_after_retries():
    with pytest.raises(tg.TelegramError):
        tg.send(KEYS, "hi", retries=3, post=lambda *a, **k: Resp(502, {"ok": False}), sleep=lambda s: None)


def test_send_stops_on_bad_token():
    calls = []
    def post(url, json, timeout):
        calls.append(1)
        return Resp(401, {"ok": False, "description": "Unauthorized"})
    with pytest.raises(tg.TelegramError, match="Unauthorized"):
        tg.send(KEYS, "hi", retries=3, post=post, sleep=lambda s: None)
    assert len(calls) == 1


def test_report_escapes_html_and_groups():
    a = {"symbol": "X<Y", "status": "ok", "signal": "BUY", "score": 50, "close": 1.0, "change_24h_pct": 1.0,
         "strong": False, "changed": True, "previous_signal": "HOLD", "events": []}
    now = datetime(2026, 11, 11, 8, 10, tzinfo=MYT)
    msg = tg.daily_report([a], now, now.replace(minute=0), "https://x", [])
    assert "X&lt;Y" in msg and "⬆ (was HOLD)" in msg and "X&lt;Y → BUY" in msg


# ---------- coins added or removed (step 10) ----------

def test_new_coin_is_backtested_in_the_daily_run(cfg, tmp_path, sent):
    import backtest as B
    btc = {"symbol": "BTC", **B.run_asset(candles("BTC"), cfg["signal"], B.settings(cfg)), "marker": 1}
    old = {"generated_at": "x", "settings": {}, "assets": [btc, dict(btc, symbol="GONE")]}
    (tmp_path / "backtest.json").write_text(json.dumps(old), encoding="utf-8")
    make_job(cfg, tmp_path, sent).run()
    bt = json.loads((tmp_path / "backtest.json").read_text(encoding="utf-8"))
    assert [a["symbol"] for a in bt["assets"]] == [c["symbol"] for c in C.enabled_symbols(cfg)]
    assert bt["assets"][0].get("marker") == 1                      # existing results kept as they are
    assert all(a["status"] == "ok" for a in bt["assets"][1:])      # the others were worked out now
    assert bt["summary"]["coins"] == len(bt["assets"])
    assert len(sent) == 1


def test_no_backtest_work_when_nothing_changed(cfg, tmp_path, sent):
    syms = [c["symbol"] for c in C.enabled_symbols(cfg)]
    old = {"assets": [{"symbol": s, "status": "ok"} for s in syms]}
    (tmp_path / "backtest.json").write_text(json.dumps(old), encoding="utf-8")
    job = make_job(cfg, tmp_path, sent)
    job.run()
    assert json.loads((tmp_path / "backtest.json").read_text(encoding="utf-8")) == old


def test_backtest_trouble_does_not_stop_the_report(cfg, tmp_path, sent):
    class NoHistory(FakeFetch):
        def daily_candles(self, cfg, coin, now_ms, days=None):
            if days:
                raise RuntimeError("boom")
            return super().daily_candles(cfg, coin, now_ms)
    make_job(cfg, tmp_path, sent, fetch=NoHistory()).run()
    assert len(sent) == 1 and (tmp_path / "signals.json").exists()


def test_report_with_30_coins_fits_one_telegram_message(cfg):
    assets = [{"symbol": f"1000C{i:02d}", "status": "ok", "signal": ("BUY", "HOLD", "SELL")[i % 3], "score": 90 - i * 6,
               "close": 0.00001234 * (i + 1), "change_24h_pct": -12.34, "strong": True, "changed": True,
               "previous_signal": "HOLD" if i % 3 != 1 else "BUY"} for i in range(30)]
    now = datetime(2026, 11, 12, 8, 10, tzinfo=MYT)
    text = tg.daily_report(assets, now, now, cfg["telegram"]["dashboard_url"],
                           ["BTC rose above $80,000 (now $81,000)"] * 3)
    assert len(text) < 4096                                        # Telegram's limit per message
    assert all(f"1000C{i:02d}" in text for i in range(30))
