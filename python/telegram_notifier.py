"""Telegram messages (spec 4.6) and sending them through the Bot API."""
from __future__ import annotations

import html
import time
from datetime import datetime
from typing import Callable, Optional

import requests

DISCLAIMER = "Info only — rule-based technical indicators, not financial advice."
ICONS = {("BUY", True): "\U0001F7E2\U0001F7E2", ("BUY", False): "\U0001F7E2",
         ("HOLD", False): "\U0001F7E1", ("HOLD", True): "\U0001F7E1",
         ("SELL", False): "\U0001F534", ("SELL", True): "\U0001F534\U0001F534"}
GROUP_ICON = {"BUY": "\U0001F7E2", "HOLD": "\U0001F7E1", "SELL": "\U0001F534"}
EVENT_TEXT = {"golden_cross": "SMA 50 crossed above SMA 200", "death_cross": "SMA 50 crossed below SMA 200",
              "rsi_overbought": "RSI entered overbought", "rsi_oversold": "RSI entered oversold"}


class TelegramError(Exception):
    pass


def fmt_price(p: float) -> str:
    """$104,820 / $3,912.55 / $2.418 / $0.2214, as in spec Figure 2."""
    if p >= 10_000:
        return f"${p:,.0f}"
    if p >= 10:
        return f"${p:,.2f}"
    if p >= 1:
        return f"${p:,.3f}"
    if p >= 0.01:
        return f"${p:.4f}"
    return f"${p:.8f}".rstrip("0")


def fmt_pct(x: Optional[float]) -> str:
    return "n/a" if x is None else f"{x:+.1f}%"


def fmt_myt(dt: datetime, weekday: bool = False) -> str:
    """'11 Nov 2026, 08:10 MYT' (FR-TIME-03); with weekday: 'Wed 11 Nov 2026, 08:10 MYT'."""
    s = f"{dt.day} {dt:%b %Y, %H:%M} MYT"
    return f"{dt:%a} {s}" if weekday else s


def _e(s) -> str:
    return html.escape(str(s), quote=False)


def daily_report(assets: list[dict], now: datetime, candle_close: datetime, dashboard_url: str,
                 price_alerts: list[str], test: bool = False) -> str:
    """The daily message (Figure 2). `assets` are signals.json entries."""
    lines = []
    if test:
        lines.append("<b>[TEST]</b>")
    lines.append(f"\U0001F4CA <b>Daily Crypto Signals — {_e(fmt_myt(now, weekday=True))}</b>")
    lines.append(f"Daily candle closed {candle_close:%H:%M} MYT · timeframe 1D")
    width = max([len(a["symbol"]) for a in assets] + [4])
    for group in ("BUY", "HOLD", "SELL"):
        members = sorted((a for a in assets if a.get("status") == "ok" and a["signal"] == group),
                         key=lambda a: -a["score"])
        if not members:
            continue
        lines.append("")
        lines.append(f"{GROUP_ICON[group]} <b>{group}</b>")
        rows = []
        for a in members:
            row = f"{a['symbol']:<{width}} {fmt_price(a['close']):>11} {fmt_pct(a.get('change_24h_pct')):>7}  score {a['score']:+4d}"
            if a.get("strong"):
                row += "  strong"
            if a.get("changed") and a.get("previous_signal"):
                arrow = "⬆" if _rank(a["signal"]) > _rank(a["previous_signal"]) else "⬇"
                row += f"  {arrow} (was {a['previous_signal']})"
            rows.append(_e(row))
        lines.append("<pre>" + "\n".join(rows) + "</pre>")
    missing = [a for a in assets if a.get("status") != "ok"]
    if missing:
        lines.append("")
        lines.append("⚠️ <b>Data unavailable</b>")
        lines.append(_e(", ".join(f"{a['symbol']} ({a.get('message', 'data unavailable')})" for a in missing)))
    lines.append("")
    changes = [f"{a['symbol']} → {a['signal']}" for a in assets if a.get("status") == "ok" and a.get("changed")]
    lines.append("<b>What changed:</b> " + _e(" · ".join(changes) if changes else "no signal changes"))
    events = [f"{a['symbol']}: {EVENT_TEXT[e]}" for a in assets if a.get("status") == "ok"
              for e in a.get("events", []) if e in EVENT_TEXT]
    if events:
        lines.append("<b>Events:</b> " + _e(" · ".join(events)))
    if price_alerts:
        lines.append("")
        lines.append("\U0001F3AF <b>Price targets reached</b>")
        lines.extend(_e(p) for p in price_alerts)
    lines.append("")
    lines.append(f"Dashboard: {_e(dashboard_url)}")
    lines.append(f"<i>{_e(DISCLAIMER)}</i>")
    return "\n".join(lines)


def _rank(signal: str) -> int:
    return {"SELL": 0, "HOLD": 1, "BUY": 2}.get(signal, 1)


def price_alert(lines: list[str], now: datetime, test: bool = False) -> str:
    head = "<b>[TEST]</b>\n" if test else ""
    return (f"{head}\U0001F3AF <b>Price target reached</b> — {_e(fmt_myt(now))}\n"
            + "\n".join(_e(l) for l in lines) + f"\n\n<i>{_e(DISCLAIMER)}</i>")


def signal_change_alert(changes: list[dict], now: datetime, dashboard_url: str, test: bool = False) -> str:
    head = "<b>[TEST]</b>\n" if test else ""
    body = "\n".join(
        _e(f"{c['symbol']}  {c['previous']} → {c['signal']}  score {c['score']:+d}  {fmt_price(c['price'])}")
        for c in changes)
    return (f"{head}\U0001F514 <b>Live signal change</b> — {_e(fmt_myt(now))}\n<pre>{body}</pre>\n"
            "Provisional: today's candle is still open, so this can change before the 08:00 MYT close.\n"
            f"Dashboard: {_e(dashboard_url)}\n<i>{_e(DISCLAIMER)}</i>")


def failure_alert(error: str, now: datetime, test: bool = False) -> str:
    head = "<b>[TEST]</b>\n" if test else ""
    return (f"{head}⚠️ <b>Crypto Signal Monitor: daily job failed</b> — {_e(fmt_myt(now))}\n"
            f"<pre>{_e(error[:1500])}</pre>\nCheck the daily-signal run on GitHub Actions.\n"
            f"<i>{_e(DISCLAIMER)}</i>")


def send(keys: dict, text: str, retries: int = 3,
         post: Callable = requests.post, sleep: Callable = time.sleep) -> dict:
    """Send with up to `retries` attempts (FR-TG-05). The token is never logged."""
    url = f"https://api.telegram.org/bot{keys['telegram_bot_token']}/sendMessage"
    payload = {"chat_id": keys["telegram_chat_id"], "text": text, "parse_mode": "HTML",
               "disable_web_page_preview": True}
    last = ""
    for attempt in range(1, retries + 1):
        try:
            r = post(url, json=payload, timeout=20)
            data = r.json()
            if data.get("ok"):
                return data
            last = f"Telegram refused the message: {data.get('description', r.status_code)}"
            if r.status_code in (400, 401, 403, 404):
                break  # wrong token / chat ID / bad text: retrying will not help
        except (requests.RequestException, ValueError) as e:
            last = f"could not reach Telegram ({type(e).__name__})"
        if attempt < retries:
            sleep(2 * attempt)
    raise TelegramError(last)
