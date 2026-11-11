"""Daily job (spec 3, 4.6, 4.7). GitHub Actions runs it every 15 minutes.

    python python/main.py            # normal run: report if due, then intraday alerts
    python python/main.py --test     # report now, prefixed [TEST], nothing saved (FR-TG-06)
    python python/main.py --force    # report now even if today's was already sent (saves data)

The report is due on the first run at or after telegram.report_time (MYT)
that has not already sent today's report (state in data/state.json).
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import alerts
import config as C
import fetch_data
import signals as S
import telegram_notifier as tg

DATA_DIR = C.ROOT / "data"


# ---------- small helpers ----------

def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, value, one_line_per_item: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if one_line_per_item and isinstance(value, list):
        text = "[\n" + ",\n".join(json.dumps(v, separators=(", ", ": ")) for v in value) + "\n]\n"
    else:
        text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")


def report_due(now: datetime, report_time: str, last_report_date: str | None) -> bool:
    hh, mm = (int(x) for x in report_time.split(":"))
    passed = (now.hour, now.minute) >= (hh, mm)
    return passed and last_report_date != now.date().isoformat()


def ms_to_myt(ms: float, tz) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(tz)


# ---------- the job ----------

class Job:
    def __init__(self, cfg: dict, keys: dict, now: datetime, test: bool = False,
                 data_dir: Path = DATA_DIR, fetch=fetch_data, send=tg.send, log=print):
        self.cfg, self.keys, self.now, self.test = cfg, keys, now, test
        self.tz = now.tzinfo
        self.data_dir = data_dir
        self.fetch, self._send, self.log = fetch, send, log
        self.state = read_json(data_dir / "state.json", {})
        self.state.setdefault("alert_states", {})
        self.state.setdefault("live_signals", {})
        self.signals = read_json(data_dir / "signals.json", None)
        self.dirty: dict[Path, tuple] = {}     # files to write at the end (skipped in test mode)

    def send(self, text: str) -> None:
        self._send(self.keys, text, retries=self.cfg["telegram"].get("send_retries", 3))

    # ----- daily report -----

    def _previous_signal(self, sym: str, candle_close_iso: str, series) -> str | None:
        """Yesterday's official signal: from signals.json, or worked out from history."""
        old = {a["symbol"]: a for a in (self.signals or {}).get("assets", [])}.get(sym)
        if old and old.get("status") == "ok":
            if (self.signals or {}).get("candle_close") == candle_close_iso:   # re-run of the same day
                return old.get("previous_signal")
            return old.get("signal")
        day_before = series[-2] if len(series) >= 2 else None
        return day_before["signal"] if day_before else None

    def daily(self) -> None:
        sig_cfg = self.cfg["signal"]
        assets, closes, latest_close_ms = [], {}, 0
        histories: dict[str, list] = {}
        for coin in C.enabled_symbols(self.cfg):
            sym = coin["symbol"]
            base = {"symbol": sym, "name": coin["name"], "pair": coin["pair"]}
            try:
                candles, provider = self.fetch.daily_candles(self.cfg, coin, self.now.timestamp() * 1000)
            except fetch_data.DataError as e:
                self.log(f"{sym}: data unavailable ({e})")
                assets.append({**base, "status": "unavailable", "message": "data unavailable"})
                continue
            close_iso = ms_to_myt(candles[-1]["close_time"], self.tz).isoformat()
            series = S.evaluate_series(candles, sig_cfg)
            prev = self._previous_signal(sym, close_iso, series)
            res = S.evaluate(candles, sig_cfg, previous=prev)
            entry = {**base, "provider": provider, "candle_close": close_iso, **res}
            if res["status"] == "ok":
                p0, p1 = candles[-2]["close"], candles[-1]["close"]
                entry["change_24h_pct"] = (p1 / p0 - 1) * 100 if p0 else None
                entry["change_24h"] = p1 - p0
                closes[sym] = p1
                histories[sym] = self._history(sym, candles, series, res)
            assets.append(entry)
            latest_close_ms = max(latest_close_ms, candles[-1]["close_time"])

        if not closes:
            raise RuntimeError("no market data for any coin: " + ", ".join(a["symbol"] for a in assets))

        candle_close = ms_to_myt(latest_close_ms, self.tz)
        self.signals = {"schema_version": 1, "generated_at": self.now.isoformat(timespec="seconds"),
                        "candle_close": candle_close.isoformat(), "timeframe": "1d", "assets": assets}

        # Price targets judged on the daily close (alerts.check == "daily")
        fired = []
        if self.cfg["alerts"]["check"] == "daily":
            fired, self.state["alert_states"] = alerts.check_targets(
                self.cfg["alerts"].get("targets", []), closes, self.state["alert_states"])

        # Live signal-change alerts compare against today's official signals from now on
        self.state["live_signals"] = {a["symbol"]: a["signal"] for a in assets if a.get("status") == "ok"}

        text = tg.daily_report(assets, self.now, candle_close, self.cfg["telegram"]["dashboard_url"],
                               fired, test=self.test)
        self.send(text)
        self.log(f"daily report sent ({len(assets)} coins, {len(fired)} price targets)")
        self.state["last_report_date"] = self.now.date().isoformat()

        self.dirty[self.data_dir / "signals.json"] = (self.signals, False)
        for sym, hist in histories.items():
            self.dirty[self.data_dir / "history" / f"{sym}.json"] = (hist, True)

    def _history(self, sym: str, candles, series, res) -> list[dict]:
        """data/history/<SYMBOL>.json: one line per day, latest history_keep_days days (FR-HIST-01)."""
        path = self.data_dir / "history" / f"{sym}.json"
        hist = read_json(path, [])
        by_date = {h["date"]: h for h in hist}
        if not hist:   # first run for this coin: rebuild from the downloaded candles
            for c, d in zip(candles, series):
                if d:
                    day = ms_to_myt(c["close_time"], self.tz).date().isoformat()
                    by_date[day] = {"date": day, "close": d["close"], "score": d["score"], "signal": d["signal"]}
        day = ms_to_myt(candles[-1]["close_time"], self.tz).date().isoformat()
        by_date[day] = {"date": day, "close": res["close"], "score": res["score"], "signal": res["signal"]}
        keep = self.cfg["data"].get("history_keep_days", 730)
        return [by_date[d] for d in sorted(by_date)][-keep:]

    # ----- during the day -----

    def intraday(self) -> None:
        coins = C.enabled_symbols(self.cfg)
        acfg = self.cfg["alerts"]
        if acfg["check"] == "intraday" and acfg.get("targets"):
            by_pair = self.fetch.binance_prices(self.cfg, [c["pair"] for c in coins])
            prices = {c["symbol"]: by_pair[c["pair"]] for c in coins if c["pair"] in by_pair}
            fired, self.state["alert_states"] = alerts.check_targets(acfg["targets"], prices, self.state["alert_states"])
            if fired:
                self.send(tg.price_alert(fired, self.now, test=self.test))
                self.log(f"price alert sent ({len(fired)})")
        if acfg.get("signal_change"):
            official = {a["symbol"]: a for a in (self.signals or {}).get("assets", []) if a.get("status") == "ok"}
            current = {}
            for c in coins:
                if c["symbol"] not in official:
                    continue        # new coin: no official signal yet (FR-CFG-04)
                try:
                    candles = self.fetch.binance_today(self.cfg, c["pair"], self.cfg["data"]["lookback_days"])
                except fetch_data.DataError as e:
                    self.log(f"{c['symbol']}: live data unavailable ({e})")
                    continue
                r = S.evaluate(candles, self.cfg["signal"], previous=official[c["symbol"]]["signal"])
                if r["status"] == "ok":
                    current[c["symbol"]] = {"signal": r["signal"], "score": r["score"], "price": r["close"]}
            changes, self.state["live_signals"] = alerts.signal_changes(current, self.state["live_signals"])
            if changes:
                self.send(tg.signal_change_alert(changes, self.now, self.cfg["telegram"]["dashboard_url"], test=self.test))
                self.log(f"signal-change alert sent ({len(changes)})")

    # ----- run -----

    def run(self, force_report: bool = False) -> None:
        reported = False
        if force_report or self.test or report_due(self.now, self.cfg["telegram"]["report_time"],
                                                   self.state.get("last_report_date")):
            self.daily()
            reported = True
        if not reported:
            try:
                self.intraday()
            except Exception as e:   # noqa: BLE001 - intraday trouble: alert at most once a day
                self.log(f"intraday check failed: {e}")
                today = self.now.date().isoformat()
                if self.state.get("intraday_error_date") != today:
                    self.state["intraday_error_date"] = today
                    self.send(tg.failure_alert(f"Intraday alert check failed: {e}", self.now, test=self.test))
        self.dirty[self.data_dir / "state.json"] = (self.state, False)
        if self.test:
            self.log("test mode: nothing saved")
            return
        for path, (value, per_line) in self.dirty.items():
            write_json(path, value, per_line)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test", action="store_true", help="send the report now, prefixed [TEST], save nothing")
    ap.add_argument("--force", action="store_true", help="send the report now even if already sent today")
    args = ap.parse_args(argv)

    try:
        keys = C.load_keys()
    except C.ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    tz = ZoneInfo("Asia/Kuala_Lumpur")
    now = datetime.now(tz)
    try:
        cfg = C.load_config()
        tz = ZoneInfo(cfg.get("timezone", "Asia/Kuala_Lumpur"))
        Job(cfg, keys, now.astimezone(tz), test=args.test).run(force_report=args.force)
        return 0
    except Exception as e:   # noqa: BLE001 - whole job failed: tell the owner (FR-TG-04)
        traceback.print_exc()
        # Alert at most once per day, so a lasting outage does not message every 15 minutes.
        state_path = DATA_DIR / "state.json"
        state = read_json(state_path, {})
        today = now.date().isoformat()
        if args.test or state.get("failure_alert_date") != today:
            try:
                tg.send(keys, tg.failure_alert(f"{type(e).__name__}: {e}", now, test=args.test))
                if not args.test:
                    state["failure_alert_date"] = today
                    write_json(state_path, state)
            except tg.TelegramError as te:
                print(f"ERROR: failure alert could not be sent: {te}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
