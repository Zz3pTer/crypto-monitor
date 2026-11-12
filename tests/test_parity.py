r"""The saved expected results must still match the Python engine.
If this fails after an intended change to the engine, run:
    .venv\Scripts\python tests\make_fixtures.py --offline
"""
import json
from pathlib import Path

import pytest

import signals as S
from make_fixtures import build_expected, to_candles  # noqa: F401

FIX = Path(__file__).resolve().parent / "fixtures"
EXPECTED = json.loads((FIX / "expected.json").read_text(encoding="utf-8"))
CANDLES = json.loads((FIX / "parity_candles.json").read_text(encoding="utf-8"))["assets"]


@pytest.mark.parametrize("symbol", sorted(CANDLES))
def test_python_reproduces_saved_expected(symbol):
    rebuilt = build_expected({"signal": EXPECTED["signal_config"]}, {symbol: CANDLES[symbol]})
    # round-trip through JSON so floats compare exactly as stored
    assert json.loads(json.dumps(rebuilt["assets"][symbol])) == EXPECTED["assets"][symbol]


def test_fixture_covers_every_signal_kind():
    seen = {d["signal"] for a in EXPECTED["assets"].values() for d in a["series"] if d}
    assert seen == {"BUY", "HOLD", "SELL"}
