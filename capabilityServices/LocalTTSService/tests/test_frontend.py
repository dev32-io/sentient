import pytest

from local_tts.text_frontend import SpeechPolicy, build_frontend


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def test_end_to_end_markdown_currency_emoji(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    doc = "## Weather 🎉\n\nIt costs **$50** for 2 items.\n\n```py\nx=1\n```"
    out = fe.process(doc, "en").lower()
    assert "dollars" in out
    assert "🎉" not in out and "weather" in out
    assert "x=1" not in out
    assert "$" not in out


def test_normalize_disabled_keeps_symbols_but_strips_markdown(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Cost is **$50** 🎉", "en")
    assert "$50" in out
    assert "🎉" not in out


def test_empty_after_strip_returns_empty(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    assert fe.process("```\njust code\n```", "en").strip() == ""


def test_masked_span_is_restored_verbatim_after_normalization(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("Then call `flush` and check `v1.2.3`.", "en")
    assert "flush" in out
    assert "v1.2.3" in out            # NOT "one point two point three"
    assert "zqxmask" not in out       # no sentinel leaked


def test_table_survives_the_full_pipeline(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("| Service | Port |\n|---|---|\n| gateway | 8080 |\n", "en")
    assert "vertical bar" not in out
    assert "Service gateway" in out


def test_no_orphan_punctuation_after_dropped_spans(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("See [x](https://a.b) , and ( ) done.", "en")
    assert " ," not in out
    assert "( )" not in out and "()" not in out


def test_paragraph_gaps_are_preserved(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("First para.\n\nSecond para.", "en")
    assert "\n\n" in out
