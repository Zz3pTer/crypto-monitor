import copy
import json
import subprocess

import pytest

import config as C


@pytest.fixture
def cfg():
    return C.load_config()


def test_repo_config_is_valid(cfg):
    assert C.validate(cfg) == []


def test_starting_coin_list(cfg):
    assert [s["symbol"] for s in C.enabled_symbols(cfg)] == [
        "BTC", "ETH", "SOL", "ADA", "XLM", "XRP", "ALGO", "HBAR", "LINK"]


def test_disabled_coin_is_skipped(cfg):
    cfg = copy.deepcopy(cfg)
    cfg["symbols"][0]["enabled"] = False
    assert "BTC" not in [s["symbol"] for s in C.enabled_symbols(cfg)]


@pytest.mark.parametrize("mutate, expected", [
    (lambda c: c["signal"]["weights"].update(trend=30), "add up to 110"),
    (lambda c: c["telegram"].update(report_time="8:10"), "report_time"),
    (lambda c: c["refresh"].update(default_sec=7), "default_sec"),
    (lambda c: c["alerts"]["targets"].append({"symbol": "DOGE", "above": 1}), "must match a coin"),
    (lambda c: c["alerts"]["targets"].append({"symbol": "BTC", "above": 1, "below": 2}), "exactly one"),
    (lambda c: c["symbols"].append(dict(c["symbols"][0])), "listed twice"),
    (lambda c: c["signal"]["thresholds"].update(buy=-1), "thresholds"),
])
def test_bad_config_is_reported(cfg, mutate, expected):
    cfg = copy.deepcopy(cfg)
    mutate(cfg)
    assert any(expected in p for p in C.validate(cfg))


def test_unreadable_config_raises_clear_error(tmp_path):
    bad = tmp_path / "config.json"
    bad.write_text("{ not json", encoding="utf-8")
    with pytest.raises(C.ConfigError, match="not valid JSON"):
        C.load_config(bad)


def test_keys_template_is_rejected_as_real_keys():
    with pytest.raises(C.ConfigError, match="telegram_bot_token"):
        C.load_keys(C.ROOT / "config" / "keys.example.json")


def test_keys_file_is_never_committed():
    """Leak guard: config/keys.json must not be tracked by git."""
    tracked = subprocess.run(["git", "ls-files", "config/keys.json"], cwd=C.ROOT,
                             capture_output=True, text=True, check=True).stdout.strip()
    assert tracked == "", "config/keys.json is committed - remove it and rotate the bot token"
    ignored = subprocess.run(["git", "check-ignore", "-q", "config/keys.json"], cwd=C.ROOT)
    assert ignored.returncode == 0, "config/keys.json is not in .gitignore"
