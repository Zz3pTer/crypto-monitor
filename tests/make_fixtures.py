"""Build the shared JS/Python test files (FR-SIG-05).

    .venv\\Scripts\\python tests\\make_fixtures.py            # refresh candles from Binance + expected results
    .venv\\Scripts\\python tests\\make_fixtures.py --offline  # keep saved candles, only recompute expected results

fixtures/parity_candles.json  real daily candles (saved once, so tests never touch the network)
fixtures/expected.json        what the Python engine says for those candles; JS must give the same
Run --offline after any change to python/indicators.py or python/signals.py, then run both test suites.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))

import config as C  # noqa: E402
import signals as S  # noqa: E402
import backtest as B  # noqa: E402

CANDLES = HERE / "fixtures" / "parity_candles.json"
EXPECTED = HERE / "fixtures" / "expected.json"
DAYS = 500


def fetch_candles(cfg: dict) -> dict:
    import requests
    base = cfg["data"]["providers"]["binance"]["rest"]
    now_ms = time.time() * 1000
    out = {}
    for s in C.enabled_symbols(cfg):
        rows = requests.get(f"{base}/api/v3/klines",
                            params={"symbol": s["pair"], "interval": "1d", "limit": DAYS + 1}, timeout=30).json()
        # [open_time_ms, open, high, low, close, volume], completed candles only
        out[s["symbol"]] = [[r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
                            for r in rows if r[6] < now_ms][-DAYS:]
    return out


DAY_MS = 86_400_000
BACKTEST = {"years": 1, "horizons_days": [7, 30], "fee_pct": 0.1}   # 1 year: fits in the 500-day fixture


def to_candles(rows: list) -> list[dict]:
    return [{"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]} for r in rows]


def build_expected(cfg: dict, raw: dict) -> dict:
    sig = cfg["signal"]
    out = {}
    for sym, rows in raw.items():
        candles = to_candles(rows)
        series = S.evaluate_series(candles, sig)
        prev = series[-2]["signal"] if series[-2] else None
        out[sym] = {
            "series": [None if d is None else {k: d[k] for k in ("score", "signal", "strong", "votes")} for d in series],
            "last": S.evaluate(candles, sig, previous=prev),
            "indicators": S.compute_indicators(candles, sig),
            "backtest": B.run_asset([dict(c, close_time=c["time"] + DAY_MS) for c in candles], sig, BACKTEST),
        }
    return {"signal_config": sig, "backtest_config": BACKTEST, "assets": out}


def main() -> None:
    cfg = C.load_config(C.ROOT / "tests" / "fixtures" / "config_base.json")
    if "--offline" in sys.argv:
        raw = json.loads(CANDLES.read_text(encoding="utf-8"))["assets"]
    else:
        raw = fetch_candles(cfg)
        CANDLES.write_text(json.dumps({"source": "Binance data-api.binance.vision, 1d klines",
                                       "fields": ["open_time_ms", "open", "high", "low", "close", "volume"],
                                       "assets": raw}, separators=(",", ":")), encoding="utf-8")
    EXPECTED.write_text(json.dumps(build_expected(cfg, raw), separators=(",", ":")), encoding="utf-8")
    print(f"wrote {CANDLES.name} ({len(raw)} assets) and {EXPECTED.name}")


if __name__ == "__main__":
    main()
