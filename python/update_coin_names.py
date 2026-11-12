"""Saves the full coin names (e.g. HBAR -> "Hedera Hashgraph") to data/coin-names.json.

The coin search on the dashboard reads the names live from Binance's product
list. That list is not part of Binance's official API, so this saved copy is
used whenever it cannot be reached. Run it now and then to pick up new coins:

    python python/update_coin_names.py

(It may be refused from GitHub's US servers; run it on your own computer.)
"""
from __future__ import annotations

import json
import sys

import config as C
import fetch_data
from main import DATA_DIR

PRODUCTS = "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=false"


def build(cfg: dict) -> dict[str, str]:
    quote = cfg["data"].get("quote", "USDT")
    rest = cfg["data"]["providers"]["binance"]["rest"]
    info = fetch_data._get(f"{rest}/api/v3/exchangeInfo",
                           {"permissions": "SPOT", "symbolStatus": "TRADING", "showPermissionSets": "false"})
    bases = {s["baseAsset"] for s in info["symbols"] if s["quoteAsset"] == quote}
    rows = fetch_data._get(PRODUCTS)["data"]
    names = {r["b"]: r["an"] for r in rows if r.get("q") == quote and r.get("an") and r["b"] in bases}
    for c in cfg["symbols"]:            # the names chosen in config.json win
        names[c["symbol"]] = c["name"]
    return dict(sorted(names.items()))


def main() -> int:
    names = build(C.load_config())
    if len(names) < 50:
        print(f"only {len(names)} names found; not saving", file=sys.stderr)
        return 1
    path = DATA_DIR / "coin-names.json"
    path.write_text("{\n" + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in names.items())
                    + "\n}\n", encoding="utf-8")
    print(f"wrote {path.name}: {len(names)} coins")
    return 0


if __name__ == "__main__":
    sys.exit(main())
