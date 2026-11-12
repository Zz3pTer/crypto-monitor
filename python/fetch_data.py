"""Market data for the daily job. Every provider sits behind this one module (FR-DATA-05).

Candles are returned oldest first as dicts:
    {"time": open_time_ms, "close_time": close_time_ms, "open", "high", "low", "close", "volume"}
Only completed candles are returned; the still-open one is dropped.
"""
from __future__ import annotations

import json
import time
from typing import Callable, Optional

import requests

DAY_MS = 86_400_000
TIMEOUT = 20
_session = requests.Session()
_session.headers["User-Agent"] = "crypto-signal-monitor"


class DataError(Exception):
    """A provider could not supply data for a coin."""


def _get(url: str, params: Optional[dict] = None, tries: int = 3):
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = _session.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 429 or r.status_code >= 500:  # rate limit / server trouble: wait and retry
                raise DataError(f"HTTP {r.status_code} from {url}")
            if r.status_code >= 400:
                raise DataError(f"HTTP {r.status_code} from {url}: {r.text[:200]}")
            return r.json()
        except (requests.RequestException, DataError, ValueError) as e:
            last = e
            if isinstance(e, DataError) and "HTTP 4" in str(e) and "HTTP 429" not in str(e):
                break  # a bad pair will not fix itself
            time.sleep(2 ** attempt)
    raise DataError(str(last))


# ---------- Binance (public market-data service) ----------

def binance_daily(cfg: dict, pair: str, days: int, now_ms: float) -> list[dict]:
    base = cfg["data"]["providers"]["binance"]["rest"]
    rows: list[list] = []
    want = days + 1                                          # +1: the still-open candle is dropped
    end: Optional[int] = None
    while len(rows) < want:                                  # Binance returns at most 1000 per request
        params = {"symbol": pair, "interval": "1d", "limit": min(want - len(rows), 1000)}
        if end is not None:
            params["endTime"] = end
        part = _get(f"{base}/api/v3/klines", params)
        if not part:
            break
        rows = part + rows
        if len(part) < params["limit"]:
            break                                            # no older candles exist
        end = part[0][0] - 1
    return [{"time": r[0], "close_time": r[0] + DAY_MS, "open": float(r[1]), "high": float(r[2]),
             "low": float(r[3]), "close": float(r[4]), "volume": float(r[5])}
            for r in rows if r[6] < now_ms][-days:]


def binance_today(cfg: dict, pair: str, days: int) -> list[dict]:
    """Daily candles including today's still-forming one (for the provisional signal)."""
    base = cfg["data"]["providers"]["binance"]["rest"]
    rows = _get(f"{base}/api/v3/klines", {"symbol": pair, "interval": "1d", "limit": min(days + 1, 1000)})
    return [{"time": r[0], "close_time": r[0] + DAY_MS, "open": float(r[1]), "high": float(r[2]),
             "low": float(r[3]), "close": float(r[4]), "volume": float(r[5])} for r in rows]


def binance_prices(cfg: dict, pairs: list[str]) -> dict[str, float]:
    """Last price per pair. One request for all pairs; falls back to one per pair
    if the batch is refused (e.g. one bad pair), so the others still work."""
    base = cfg["data"]["providers"]["binance"]["rest"]
    try:
        rows = _get(f"{base}/api/v3/ticker/price", {"symbols": json.dumps(pairs, separators=(",", ":"))})
        return {r["symbol"]: float(r["price"]) for r in rows}
    except DataError:
        out = {}
        for p in pairs:
            try:
                out[p] = float(_get(f"{base}/api/v3/ticker/price", {"symbol": p})["price"])
            except DataError:
                pass
        return out


# ---------- Coinbase (fallback, USD) ----------

def coinbase_daily(cfg: dict, symbol: str, days: int, now_ms: float) -> list[dict]:
    prov = cfg["data"]["providers"]["coinbase"]
    product = f"{symbol}-{prov.get('quote', 'USD')}"
    end_s = int(now_ms // DAY_MS * DAY_MS // 1000)          # start of the current (open) UTC day
    start_s = end_s - days * 86_400
    rows: dict[int, list] = {}
    chunk = 300 * 86_400                                     # Coinbase returns at most 300 candles
    t = start_s
    while t < end_s:
        part = _get(f"{prov['rest']}/products/{product}/candles",
                    {"granularity": 86_400, "start": t, "end": min(t + chunk, end_s)})
        for r in part:                                       # [time, low, high, open, close, volume]
            rows[r[0]] = r
        t += chunk
    out = [{"time": r[0] * 1000, "close_time": r[0] * 1000 + DAY_MS, "open": float(r[3]), "high": float(r[2]),
            "low": float(r[1]), "close": float(r[4]), "volume": float(r[5])}
           for k, r in sorted(rows.items()) if r[0] * 1000 + DAY_MS <= now_ms]
    return out[-days:]


# ---------- Public entry points ----------

def daily_candles(cfg: dict, coin: dict, now_ms: Optional[float] = None,
                  days: Optional[int] = None) -> tuple[list[dict], str]:
    """Completed daily candles for one coin, from the main provider or the fallback.
    `days` defaults to data.lookback_days. Returns (candles, provider_name).
    Raises DataError if both fail."""
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    days = days or cfg["data"]["lookback_days"]
    providers: list[tuple[str, Callable[[], list[dict]]]] = []
    for name in (cfg["data"]["history_provider"], cfg["data"].get("fallback_history_provider")):
        if name == "binance":
            providers.append((name, lambda: binance_daily(cfg, coin["pair"], days, now_ms)))
        elif name == "coinbase":
            providers.append((name, lambda: coinbase_daily(cfg, coin["symbol"], days, now_ms)))
    errors = []
    for name, fn in providers:
        try:
            candles = fn()
            if candles:
                return candles, name
            errors.append(f"{name}: no candles")
        except DataError as e:
            errors.append(f"{name}: {e}")
    raise DataError("; ".join(errors) or "no provider configured")
