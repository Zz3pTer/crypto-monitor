"""Backtest (spec 4.7, FR-HIST-03). Replays the signal rules over the past
`backtest.years` years of daily candles and writes data/backtest.json.

    python python/backtest.py              # all enabled coins
    python python/backtest.py BTC SOL      # only these coins

What it measures, per coin, over the test period:
  * Hit rate: every day the official signal turns BUY (or SELL) counts once.
    A BUY was "right" after N days if the close N days later is higher than the
    close on the signal day; a SELL was right if it is lower. Signals too close
    to the end of the period to have an N-day result are not counted.
  * Strategy: buy at the close of a day the signal turns BUY, sell at the
    close of a day it turns SELL; HOLD keeps whatever position you have.
    Each buy or sell costs backtest.fee_pct percent.
  * Buy-and-hold: buy at the first close of the period, sell at the last.
Each day only uses candles up to that day (no look-ahead). Past results do not
predict future results.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import config as C
import fetch_data
import signals as S
from main import DATA_DIR, read_json, write_json

DAY = 365


def settings(cfg: dict) -> dict:
    bt = cfg.get("backtest") or {}
    return {"years": bt.get("years", 2), "horizons_days": bt.get("horizons_days", [7, 30]),
            "fee_pct": bt.get("fee_pct", 0.1)}


def days_needed(cfg: dict) -> int:
    """Candles to download: the test period plus the indicator warm-up."""
    return int(settings(cfg)["years"] * DAY) + cfg["signal"]["min_candles"]


def _date(candle: dict, tz) -> str:
    """The MYT date on which a daily candle's signal is official (its close)."""
    return datetime.fromtimestamp(candle["close_time"] / 1000, tz=timezone.utc).astimezone(tz).date().isoformat()


def run_asset(candles: list[dict], sig_cfg: dict, bt: dict, tz=None) -> dict:
    """Backtest one coin. `candles` are completed daily candles, oldest first."""
    tz = tz or ZoneInfo("Asia/Kuala_Lumpur")
    series = S.evaluate_series(candles, sig_cfg)
    first = next((t for t, d in enumerate(series) if d), None)
    if first is None:
        return {"status": "insufficient_history", "message": "Not enough history", "candles": len(candles)}
    end = len(candles) - 1
    start = max(first, end - int(bt["years"] * DAY) + 1)
    closes = [float(c["close"]) for c in candles]
    sigs = [d["signal"] if d else None for d in series]

    # Days the signal turned BUY or SELL (one count per turn, not per day held)
    turns = [t for t in range(start, end + 1)
             if t > first and sigs[t] != sigs[t - 1]]
    entries = {s: [t for t in turns if sigs[t] == s] for s in (S.BUY, S.SELL)}

    horizons = []
    for n in bt["horizons_days"]:
        row = {"days": n}
        for s, key in ((S.BUY, "buy"), (S.SELL, "sell")):
            rets = [closes[t + n] / closes[t] - 1 for t in entries[s] if t + n <= end]
            right = [r for r in rets if (r > 0 if s == S.BUY else r < 0)]
            row[f"{key}_count"] = len(rets)
            row[f"{key}_hit_rate"] = round(len(right) / len(rets), 4) if rets else None
            row[f"{key}_avg_change_pct"] = round(sum(rets) / len(rets) * 100, 2) if rets else None
        horizons.append(row)

    # Strategy: in the market from a BUY until the next SELL
    fee = bt["fee_pct"] / 100
    equity, held, trades, days_in = 1.0, False, 0, 0
    for t in range(start, end + 1):
        if held and t > start:
            equity *= closes[t] / closes[t - 1]
            days_in += 1
        if sigs[t] == S.BUY and not held:
            held, trades, equity = True, trades + 1, equity * (1 - fee)
        elif sigs[t] == S.SELL and held:
            held, trades, equity = False, trades + 1, equity * (1 - fee)

    length = end - start
    return {
        "status": "ok",
        "start": _date(candles[start], tz),
        "end": _date(candles[end], tz),
        "days": length,
        "period": f"{length / DAY:.1f} years" if length >= DAY else f"{length} days",
        "short_history": length < int(bt["years"] * DAY) - 1,
        "signal_changes": len(turns),
        "buy_signals": len(entries[S.BUY]),
        "sell_signals": len(entries[S.SELL]),
        "horizons": horizons,
        "strategy_return_pct": round((equity - 1) * 100, 2),
        "buy_hold_return_pct": round((closes[end] / closes[start] - 1) * 100, 2),
        "trades": trades,
        "time_in_market_pct": round(days_in / length * 100, 1) if length else 0.0,
        "still_holding": held,
    }


def summary(assets: list[dict]) -> dict:
    """All coins together: hit rates over every signal, and how many coins beat holding."""
    ok = [a for a in assets if a.get("status") == "ok"]
    out = {"coins": len(ok), "horizons": []}
    if not ok:
        return out
    for i, h in enumerate(ok[0]["horizons"]):
        row = {"days": h["days"]}
        for key in ("buy", "sell"):
            n = sum(a["horizons"][i][f"{key}_count"] for a in ok)
            right = sum(round(a["horizons"][i][f"{key}_hit_rate"] * a["horizons"][i][f"{key}_count"])
                        for a in ok if a["horizons"][i][f"{key}_count"])
            row[f"{key}_count"] = n
            row[f"{key}_hit_rate"] = round(right / n, 4) if n else None
        out["horizons"].append(row)
    out["beat_buy_hold"] = sum(a["strategy_return_pct"] > a["buy_hold_return_pct"] for a in ok)
    out["avg_strategy_return_pct"] = round(sum(a["strategy_return_pct"] for a in ok) / len(ok), 2)
    out["avg_buy_hold_return_pct"] = round(sum(a["buy_hold_return_pct"] for a in ok) / len(ok), 2)
    return out


def merged(cfg: dict, old: dict | None, new_assets: list[dict]) -> list[dict]:
    """Old results with the new ones on top, in config order; removed coins are dropped."""
    by = {a["symbol"]: a for a in (old or {}).get("assets") or []}
    by.update({a["symbol"]: a for a in new_assets})
    return [by[c["symbol"]] for c in C.enabled_symbols(cfg) if c["symbol"] in by]


def run(cfg: dict, only: list[str] | None = None, fetch=fetch_data, now: datetime | None = None) -> dict:
    tz = ZoneInfo(cfg.get("timezone", "Asia/Kuala_Lumpur"))
    now = now or datetime.now(tz)
    bt = settings(cfg)
    days = days_needed(cfg)
    assets = []
    for coin in C.enabled_symbols(cfg):
        if only and coin["symbol"] not in only:
            continue
        row = {"symbol": coin["symbol"], "name": coin.get("name", coin["symbol"])}
        try:
            candles, provider = fetch.daily_candles(cfg, coin, now.timestamp() * 1000, days=days)
            row.update(run_asset(candles, cfg["signal"], bt, tz), provider=provider)
        except fetch_data.DataError as e:
            row.update(status="error", message=str(e))
        assets.append(row)
        print(f"{coin['symbol']}: {row.get('status')}"
              + (f", {row['signal_changes']} changes, strategy {row['strategy_return_pct']}%"
                 f" vs hold {row['buy_hold_return_pct']}%" if row.get("status") == "ok" else f" ({row.get('message')})"))
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "timezone": str(tz),
        "settings": bt,
        "method": ("Hit rate: share of BUY (SELL) signals followed by a higher (lower) close after N days. "
                   "Strategy: buy when the signal turns BUY, sell when it turns SELL, fee per trade. "
                   "Past results do not predict future results."),
        "summary": summary(assets),
        "assets": assets,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbols", nargs="*", help="only these coins (default: all enabled)")
    args = ap.parse_args(argv)
    cfg = C.load_config()
    t0 = time.time()
    result = run(cfg, [s.upper() for s in args.symbols] or None)
    if not any(a.get("status") == "ok" for a in result["assets"]):
        print("no coin could be backtested", file=sys.stderr)
        return 1
    if args.symbols:   # partial run: merge into the existing file
        result["assets"] = merged(cfg, read_json(DATA_DIR / "backtest.json", None), result["assets"])
        result["summary"] = summary(result["assets"])
    write_json(DATA_DIR / "backtest.json", result)
    print(f"wrote data/backtest.json in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
