"""Price-target and signal-change alerts (owner request + FR-TG-08).

An alert fires once when its condition becomes true and is re-armed only
after the price has moved back across the target, so a price hovering
around a target does not send a message every 15 minutes.
"""
from __future__ import annotations

from telegram_notifier import fmt_price


def target_key(t: dict) -> str:
    side = "above" if "above" in t else "below"
    return f"{t['symbol']}:{side}:{t[side]}"


def check_targets(targets: list[dict], prices: dict[str, float], states: dict) -> tuple[list[str], dict]:
    """prices: symbol -> price. states: target_key -> {"armed": bool}.
    Returns (lines for the coins whose target was reached, new states).
    Targets whose coin has no price are left untouched."""
    fired: list[str] = []
    new_states: dict = {}
    for t in targets:
        key = target_key(t)
        armed = states.get(key, {}).get("armed", True)
        price = prices.get(t["symbol"])
        if price is None:
            new_states[key] = {"armed": armed}
            continue
        side = "above" if "above" in t else "below"
        level = t[side]
        hit = price >= level if side == "above" else price <= level
        if hit and armed:
            word = "at or above" if side == "above" else "at or below"
            fired.append(f"{t['symbol']} is {word} {fmt_price(level)} — now {fmt_price(price)}")
            armed = False
        elif not hit:
            armed = True
        new_states[key] = {"armed": armed}
    return fired, new_states


def signal_changes(current: dict[str, dict], last: dict[str, str]) -> tuple[list[dict], dict[str, str]]:
    """current: symbol -> {"signal", "score", "price"} (provisional, live).
    last: symbol -> signal last reported. A coin seen for the first time is
    recorded without an alert."""
    changes: list[dict] = []
    new_last = dict(last)
    for sym, cur in current.items():
        before = last.get(sym)
        if before is not None and cur["signal"] != before:
            changes.append({"symbol": sym, "previous": before, **cur})
        new_last[sym] = cur["signal"]
    return changes, new_last
