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


def test_ellipsis_after_comma_survives(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Wait, ... what?", "en")
    assert "..." in out
    assert "what" in out


def test_ellipsis_with_no_space_survives_and_keeps_the_space(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("So, ...anyway.", "en")
    assert "..." in out
    assert ",anyway" not in out
    assert ", ..." in out


def test_ellipsis_in_prose_keeps_its_leading_space(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Hello ... world", "en")
    assert out == "Hello ... world"


def test_repeated_punct_still_cleans_a_dropped_span_artifact(policy):
    # The image is dropped entirely (policy: drop), stranding the colon
    # against the following full stop -- exactly the artifact this rule
    # exists to clean up.
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Reference: ![diagram](fig.png). See below.", "en")
    assert out == "Reference. See below."


def test_ordinary_list_prose_is_untouched(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("one, two, three.", "en")
    assert out == "one, two, three."


def test_space_before_punct_still_cleans_a_dropped_span_artifact(policy):
    # The image is dropped entirely, stranding a space against the
    # following comma -- exactly the ordinary artifact _SPACE_BEFORE_PUNCT
    # exists to clean up (not an ellipsis, so it must still fire).
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Check the chart ![chart](fig.png) , it changes weekly.", "en")
    assert out == "Check the chart, it changes weekly."


def test_prose_pipe_separator_is_not_spoken(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("Partly cloudy, 22.7C | Humidity 71% | Wind 3.6 km/h", "en")
    assert "vertical bar" not in out
    assert "percent" in out and "kilometers per hour" in out


def test_numbered_hash_reference_is_spoken_as_number(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("issue #42", "en").lower()
    assert "number" in out
    assert "forty" in out and "two" in out
