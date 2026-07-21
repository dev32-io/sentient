import mistune
import pytest

from local_tts.text_frontend.policy import SpeechPolicy
from local_tts.text_frontend.table import render_table

_PARSE = mistune.create_markdown(renderer=None, plugins=["table"])


def _first_table(doc):
    return [t for t in _PARSE(doc) if t["type"] == "table"][0]


def _plain_cell(children):
    return "".join(c.get("raw", "") for c in children)


SMALL = "| Service | Port |\n|---|---|\n| gateway | 8080 |\n| tts | 8888 |\n"


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def test_small_table_is_linearized_with_header_prefixes(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "en")
    assert "Service gateway, Port 8080." in out
    assert "Service tts, Port 8888." in out
    assert "|" not in out


def test_large_table_is_summarized(policy):
    rows = "\n".join(f"| r{i} | v{i} |" for i in range(20))
    doc = f"| A | B |\n|---|---|\n{rows}\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "20" in out and "2" in out
    assert "r0" not in out


def test_zh_uses_chinese_separators(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "zh")
    assert "，" in out
    assert ", " not in out


def test_cells_go_through_the_injected_renderer(policy):
    doc = "| A |\n|---|\n| x |\n"
    out = render_table(_first_table(doc), lambda ch: "RENDERED", policy, "en")
    assert "RENDERED" in out


def test_empty_body_summarizes_rather_than_emitting_junk(policy):
    doc = "| A | B |\n|---|---|\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "|" not in out
    assert out.strip() != ""
