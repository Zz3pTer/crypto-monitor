"""Load and check config/config.json and config/keys.json.

Both the daily job and the tests go through this module, so a bad
config is reported the same way everywhere (FR-CFG-08).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "config.json"
KEYS_PATH = ROOT / "config" / "keys.json"

MAX_COINS = 30  # FR-CFG-03
WEIGHT_KEYS = ("trend", "cross", "macd", "rsi", "bollinger", "momentum", "volume")
PERIOD_KEYS = ("sma_fast", "sma_slow", "ema", "rsi", "bb", "bb_std",
               "macd_fast", "macd_slow", "macd_signal", "roc", "vol_avg")
KEY_FIELDS = ("telegram_bot_token", "telegram_chat_id")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class ConfigError(Exception):
    """config.json or keys.json is missing or invalid."""


def _read_json(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError as e:
        raise ConfigError(f"{path.name} not found at {path}") from e
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path.name} is not valid JSON (line {e.lineno}, column {e.colno}): {e.msg}") from e


def validate(cfg: dict) -> list[str]:
    """Return a list of problems; empty means the config is usable."""
    problems: list[str] = []

    def need(section: str) -> dict:
        val = cfg.get(section)
        if not isinstance(val, dict):
            problems.append(f'"{section}" section is missing')
            return {}
        return val

    symbols = cfg.get("symbols")
    if not isinstance(symbols, list) or not symbols:
        problems.append('"symbols" must be a non-empty list')
        symbols = []
    seen: set[str] = set()
    for i, s in enumerate(symbols):
        label = f"symbols[{i}]"
        if not isinstance(s, dict):
            problems.append(f"{label} must be an object")
            continue
        for field in ("symbol", "name", "pair"):
            if not isinstance(s.get(field), str) or not s.get(field):
                problems.append(f'{label} needs a text "{field}"')
        sym = s.get("symbol")
        if sym in seen:
            problems.append(f'{label}: symbol "{sym}" is listed twice')
        seen.add(sym)
        if "enabled" in s and not isinstance(s["enabled"], bool):
            problems.append(f'{label}: "enabled" must be true or false')
    enabled = [s for s in symbols if isinstance(s, dict) and s.get("enabled", True)]
    if symbols and not enabled:
        problems.append("no coin is enabled")
    if len(enabled) > MAX_COINS:
        problems.append(f"{len(enabled)} coins enabled; the maximum is {MAX_COINS}")

    refresh = need("refresh")
    opts = refresh.get("options_sec")
    if not isinstance(opts, list) or not opts or not all(isinstance(o, int) and o > 0 for o in opts):
        problems.append('refresh.options_sec must be a list of positive whole seconds')
    elif refresh.get("default_sec") not in opts:
        problems.append("refresh.default_sec must be one of refresh.options_sec")

    if need("theme").get("default") not in ("dark", "bright"):
        problems.append('theme.default must be "dark" or "bright"')

    if need("data").get("lookback_days", 0) < 220:
        problems.append("data.lookback_days must be at least 220 (FR-SIG-02)")

    sig = need("signal")
    periods = sig.get("periods", {})
    weights = sig.get("weights", {})
    for k in PERIOD_KEYS:
        if not isinstance(periods.get(k), (int, float)) or periods.get(k) <= 0:
            problems.append(f"signal.periods.{k} must be a positive number")
    for k in WEIGHT_KEYS:
        if not isinstance(weights.get(k), (int, float)) or weights.get(k) < 0:
            problems.append(f"signal.weights.{k} must be a number of 0 or more")
    if all(isinstance(weights.get(k), (int, float)) for k in WEIGHT_KEYS):
        total = sum(weights[k] for k in WEIGHT_KEYS)
        if total != 100:
            problems.append(f"signal.weights add up to {total}; they must add up to 100 so the score runs from -100 to +100")
    th = sig.get("thresholds", {})
    try:
        if not (th["strong_sell"] < th["sell"] < 0 < th["buy"] < th["strong_buy"]):
            problems.append("signal.thresholds must satisfy strong_sell < sell < 0 < buy < strong_buy")
    except (KeyError, TypeError):
        problems.append("signal.thresholds needs strong_buy, buy, sell and strong_sell")

    tg = need("telegram")
    if not _TIME_RE.match(str(tg.get("report_time", ""))):
        problems.append('telegram.report_time must be "HH:MM" in 24-hour MYT, e.g. "08:10"')

    alerts = need("alerts")
    if alerts.get("check") not in ("daily", "intraday"):
        problems.append('alerts.check must be "daily" or "intraday"')
    for i, t in enumerate(alerts.get("targets", [])):
        label = f"alerts.targets[{i}]"
        if not isinstance(t, dict) or t.get("symbol") not in seen:
            problems.append(f"{label}: symbol must match a coin in \"symbols\"")
            continue
        levels = [k for k in ("above", "below") if k in t]
        if len(levels) != 1 or not isinstance(t[levels[0]], (int, float)) or t[levels[0]] <= 0:
            problems.append(f'{label}: needs exactly one of "above" or "below" with a positive price')

    return problems


def load_config(path: Path = CONFIG_PATH) -> dict:
    cfg = _read_json(path)
    problems = validate(cfg)
    if problems:
        raise ConfigError("config.json has problems:\n- " + "\n- ".join(problems))
    return cfg


def enabled_symbols(cfg: dict) -> list[dict]:
    return [s for s in cfg["symbols"] if s.get("enabled", True)]


def load_keys(path: Path = KEYS_PATH) -> dict:
    keys = _read_json(path)
    missing = [k for k in KEY_FIELDS if not str(keys.get(k, "")).strip() or str(keys.get(k)).startswith("<")]
    if missing:
        raise ConfigError(f"keys.json is missing: {', '.join(missing)}")
    return keys
