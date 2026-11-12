# Crypto Signal Monitor

A live dashboard of crypto prices with rule-based **BUY / HOLD / SELL** signals, and a daily Telegram report.

- **Dashboard:** https://zz3pter.github.io/crypto-monitor/ (GitHub Pages)
- **Daily job:** Python on GitHub Actions, reports to Telegram at 08:10 Malaysia time (configurable)
- **Spec:** Crypto Signal Monitor Requirements Specification v1.2

> Signals are the mechanical output of technical-analysis rules applied to price history.
> They are information only, **not financial advice**.

> **Status:** under construction (steps 0–10 of 11 done; step 11 is the go-live check).

---

## How it works

| Part | Runs on | Does |
|---|---|---|
| Dashboard (`index.html`, `css/`, `js/`) | Your browser, served by GitHub Pages | Live prices from Binance, refresh every 5 s – 15 min, provisional signal, charts, official signal from `data/signals.json` |
| Daily job (`python/`) | GitHub Actions, every 15 min | After the report time: downloads daily candles, calculates the official signal, saves `data/`, sends the Telegram report. In between: checks alerts |

Market data: Binance public market-data service (`data-api.binance.vision`, `data-stream.binance.vision`), no key needed. Coinbase is the fallback for the daily job.

All times are Malaysia time (MYT, UTC+8). The daily candle closes at 08:00 MYT.

---

## Configuration — `config/config.json`

Everything adjustable is in this one file. Both the dashboard and the daily job read it. A change takes effect on the next page load (dashboard) and the next daily run (official signal and Telegram).

### `symbols` — the coin list

| Field | Meaning |
|---|---|
| `symbol` | Short name shown everywhere, e.g. `BTC`. Must be unique |
| `name` | Full name, e.g. `Bitcoin` |
| `pair` | Binance trading pair, e.g. `BTCUSDT`. Must exist on Binance |
| `coingecko_id` | CoinGecko ID (kept for reference / spare provider) |
| `enabled` | `true` to show, `false` to hide it for a while without deleting the line |

Between 1 and 30 coins can be enabled.

### Adding and removing coins on the website

Press **+ Add coin** on the overview (or *Search and add a coin* in Settings → Shared settings). Search any of the ~500 coins traded against USDT on Binance by name or symbol. Picking one shows its price, 24h change, 7-day chart, current signal and a quick backtest before you add it. Then:

| Choice | Who can | Dashboard | Telegram report |
|---|---|---|---|
| **Add for everyone** | People with a GitHub token (Settings → Shared settings) | Everyone's, at once in your browser, for others within about a minute | From the next daily report |
| **Add to my view only** | Anyone | This browser only (marked *my view*) | No |

To remove a coin, open it and press **Manage coin**: *Remove for everyone* (token needed; its price targets go too) or *Remove from my view*. At most 30 coins are shown at a time.

A coin added for everyone is changed in `config.json` by a commit from the dashboard. The next daily run includes it in the report and works out its backtest; until then the detail screen works the backtest out in the browser. Full names come from Binance's product list, with a saved copy in `data/coin-names.json` (refresh it with `python python/update_coin_names.py`).

**Add a coin by hand** — add one line, e.g. Dogecoin:

```json
{"symbol": "DOGE", "name": "Dogecoin", "pair": "DOGEUSDT", "coingecko_id": "dogecoin", "enabled": true},
```

It shows a live price and provisional signal on the next page load. Its official signal and Telegram line appear after the next daily run.

**Delete a coin** — remove its line (watch the commas: the last line in the list has none). Or set `"enabled": false` to hide it temporarily.

If a pair is wrong, only that coin shows "data unavailable"; the others carry on.

### `refresh` — auto-refresh frequency

| Field | Meaning | Default |
|---|---|---|
| `options_sec` | Choices in the header's Refresh selector, in seconds | `[5, 10, 15, 30, 60, 300, 900]` |
| `default_sec` | Frequency used when the page opens (must be one of the options) | `30` |
| `hidden_tab_sec` | Frequency while the browser tab is hidden (if "slow down" is on) | `300` |
| `polling_min_sec` | Fastest allowed refresh when the live stream is unavailable and the page polls instead | `5` |

### `theme`, `timezone`

| Field | Meaning | Default |
|---|---|---|
| `theme.default` | Starting theme: `"dark"` or `"bright"`. The header switch overrides it per browser | `"dark"` |
| `timezone` | Always `Asia/Kuala_Lumpur`. Not meant to be changed | |

### `data` — market data

| Field | Meaning | Default |
|---|---|---|
| `live_provider` | Dashboard price source | `"binance"` |
| `history_provider` | Daily job candle source | `"binance"` |
| `fallback_history_provider` | Used if the main source fails | `"coinbase"` |
| `quote` | Quote currency | `"USDT"` |
| `lookback_days` | Daily candles downloaded per coin (at least 220) | `400` |
| `history_keep_days` | Days kept in `data/history/<SYMBOL>.json` | `730` |
| `stale_after_intervals` | Card greys out as "stale" after this many refresh intervals without an update | `3` |
| `official_stale_hours` | Warning banner if the official signals are older than this | `26` |
| `providers` | Provider addresses | |

### `signal` — the rules

The score is the sum of each rule's vote (+1, 0 or −1) times its weight, from −100 to +100.

| Field | Meaning | Default |
|---|---|---|
| `min_candles` | Fewer completed daily candles than this shows "Not enough history" | `220` |
| `periods` | Indicator lengths in days: SMA 50/200, EMA 20, RSI 14, Bollinger 20 × 2 std, MACD 12/26/9, ROC 14, volume average 20 | |
| `weights` | Points per rule: `trend` 20, `cross` 15, `macd` 20, `rsi` 15, `bollinger` 10, `momentum` 10, `volume` 10. **Must add up to 100** | |
| `thresholds` | Score for `strong_buy` (65), `buy` (35), `sell` (−35), `strong_sell` (−65) | |
| `hysteresis` | A BUY or SELL only returns to HOLD after the score moves this far back inside the threshold | `5` |
| `rsi_oversold`, `rsi_overbought` | RSI levels | `30`, `70` |
| `roc_pct` | Momentum: 14-day change above +this % is bullish, below −this % bearish | `5` |
| `volume_spike` | Volume rule: volume above this × the 20-day average | `1.5` |
| `cross_lookback_days` | Flag an SMA 50 / SMA 200 cross within this many days | `3` |

### `telegram`

| Field | Meaning | Default |
|---|---|---|
| `report_time` | Daily report time, `"HH:MM"` 24-hour MYT. Accurate to about 15 minutes (see below) | `"08:10"` |
| `dashboard_url` | Link at the end of each message | |
| `send_retries` | Attempts before reporting a send failure | `3` |

The daily workflow runs every 15 minutes (at :10, :25, :40, :55). The report goes out on the first run after `report_time` that hasn't already sent today's report. GitHub sometimes starts scheduled runs a few minutes late.

### `alerts`

| Field | Meaning | Default |
|---|---|---|
| `check` | `"daily"`: price targets are judged on the daily close and listed in the report. `"intraday"`: also checked every 15 minutes and sent straight away | `"daily"` |
| `signal_change` | Send an extra message during the day when a coin's live signal changes | `true` |
| `targets` | Price targets, each `{"symbol": "BTC", "above": 80000}` or `{"symbol": "SOL", "below": 70}` | example values |

An alert fires once when the price crosses its target, and again only after the price has moved back across it.

### `backtest`

| Field | Meaning | Default |
|---|---|---|
| `years` | Years of history replayed | `2` |
| `horizons_days` | Check whether BUY/SELL were right after these many days | `[7, 30]` |
| `fee_pct` | Cost of each buy or sell in the "following the signals" result, in percent | `0.1` |

How the backtest works (`python/backtest.py`, results in `data/backtest.json`, shown on each coin's detail screen):

- **Hit rate:** every day the official signal *turns* BUY (or SELL) counts once. A BUY was right after N days if the close N days later is higher; a SELL was right if it is lower. Signals too close to today to have an N-day result are left out.
- **Following the signals:** buy at the close of a day the signal turns BUY, sell at the close of a day it turns SELL; HOLD keeps whatever you have. Compared with **just holding** from the first to the last day.
- Each day only uses prices known on that day. Past results do not predict future results.

Run it by hand with `python python/backtest.py` (or `python python/backtest.py BTC SOL` for some coins only).

---

## Keys — `config/keys.json`

Keys are kept apart from the settings because this repository is public. **`config/keys.json` is never uploaded** (it is in `.gitignore`, and the tests fail if it is ever committed).

```json
{
  "telegram_bot_token": "<token from @BotFather>",
  "telegram_chat_id":   "<your chat ID>",
  "market_api_key":     ""
}
```

Copy `config/keys.example.json` to `config/keys.json` and fill it in. For GitHub, its whole content is stored once as the Actions secret `KEYS_JSON`; the workflow recreates the file on each run. The dashboard never reads keys.

If the bot token is ever exposed, revoke it in @BotFather (`/revoke`) and update `keys.json` and the `KEYS_JSON` secret.

---

## Setup *(full steps completed in step 10)*

1. Create the GitHub repository and push the code. *(done)*
2. Edit `config/config.json`: check the coin list, refresh frequency, report time and alert targets.
3. In Telegram, open @BotFather, create a bot with `/newbot` and copy the bot token.
4. Send any message to the new bot, then read your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
5. Copy `config/keys.example.json` to `config/keys.json` and fill in the token and chat ID.
6. GitHub → Settings → Secrets and variables → Actions: create the secret `KEYS_JSON` with the content of `keys.json`.
7. GitHub → Settings → Pages: publish from the `main` branch. Settings → Actions → General: allow workflows read and write permission.
8. Actions → daily-signal → Run workflow with **test** ticked; check the `[TEST]` message arrives.
9. Run it once normally to create the first `signals.json`, then open the dashboard.

---

## Workflows (GitHub Actions)

| Workflow | When | What it does |
|---|---|---|
| `daily-signal.yml` | Every 15 min (:10, :25, :40, :55) and on manual run | Report on the first run after `telegram.report_time`; alerts in between; commits `data/` when it changes |
| `tests.yml` | Every push and pull request | Python tests, JavaScript tests, JS/Python match check |
| `backtest-weekly.yml` | Sundays 09:00 MYT and on manual run | Backtest, saves `data/backtest.json` |

**Manual run:** GitHub → Actions → daily-signal → Run workflow, then pick a mode:
- `test`: sends the report now prefixed `[TEST]` and saves nothing;
- `force`: sends the report now and saves the data, even if today's was already sent;
- `auto`: the same as a scheduled run.

Two runs never overlap. Scheduled runs on GitHub can start a few minutes late; a missed run is caught up by the next one.

If no repository activity happens for 60 days, GitHub pauses scheduled workflows. The daily data commits normally prevent this; if it happens, open Actions → daily-signal → Enable workflow.

## Development

Requires Python 3.12 and Node.js 20+. No npm packages are used.

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r python\requirements.txt
.venv\Scripts\python -m pytest          # Python tests
npm test                                # JavaScript tests + JS/Python match check
.venv\Scripts\python tests\make_fixtures.py --offline   # after changing the signal engine: refresh expected results
py -3.12 -m http.server 8000            # preview the dashboard at http://localhost:8000
```

## Project layout

```
index.html, css/, js/       dashboard
config/                     config.json (settings), keys.example.json, keys.json (local only)
data/                       signals.json, history/, backtest.json, state.json (written by the workflow), coin-names.json
python/                     daily job, signal engine, backtest
tests/                      Python and JavaScript tests, shared JS/Python test file
.github/workflows/          daily-signal.yml, tests.yml, backtest-weekly.yml
```
