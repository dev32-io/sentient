import pytest

from local_tts.text_frontend.mask import MaskTable
from local_tts.text_frontend.policy import SpeechPolicy
from local_tts.text_frontend.spans import (
    classify_code_span,
    render_code_span,
    replace_bare_spans,
)


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


@pytest.mark.parametrize("raw", ["flush", "config.yaml", "v1.2.3", "8080", "snake_case_name"])
def test_word_like_spans_are_kept(raw, policy):
    assert classify_code_span(raw, policy).keep is True


@pytest.mark.parametrize(
    ("raw", "expected_key"),
    [
        ("npm install --save-dev @types/node", "command"),
        ("--save-dev", "command"),
        ("/Users/kev/dev/sentient/gateway/src/a.ts", "file_path"),
        ("~/.sentient/gateway/config.yaml", "file_path"),
        ("https://example.com/a?b=1", "link"),
        ("www.example.com", "link"),
    ],
)
def test_non_prose_spans_are_dropped_with_the_right_phrase(raw, expected_key, policy):
    verdict = classify_code_span(raw, policy)
    assert verdict.keep is False
    assert verdict.phrase_key == expected_key


def test_over_length_span_is_dropped(policy):
    long_word = "a" * (policy.code_span_max_chars + 1)
    assert classify_code_span(long_word, policy).keep is False


def test_render_kept_span_is_masked(policy):
    masks = MaskTable()
    out = render_code_span("v1.2.3", policy, "en", masks)
    assert "v1.2.3" not in out          # masked for the TN pass
    assert masks.restore(out) == "v1.2.3"


def test_render_dropped_span_speaks_a_phrase(policy):
    out = render_code_span("npm i --save-dev x", policy, "en", MaskTable())
    assert out == "a command"


def test_render_dropped_span_is_silent_when_disabled():
    quiet = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=False)
    assert render_code_span("npm i --save-dev x", quiet, "en", MaskTable()) == ""


def test_replace_bare_url_in_prose(policy):
    out = replace_bare_spans("Also www.example.com here.", policy, "en")
    assert "www" not in out
    assert "a link" in out


def test_replace_bare_path_in_prose(policy):
    out = replace_bare_spans("Path: /Users/kev/dev/a.ts done.", policy, "en")
    assert "/Users" not in out
    assert "a file path" in out


def test_replace_bare_spans_leaves_prose_alone(policy):
    s = "The weather is nice today, e.g. sunny."
    assert replace_bare_spans(s, policy, "en") == s


def test_replace_bare_spans_does_not_eat_simple_division(policy):
    # A single slash between words is prose, not a path.
    s = "a 50/50 split and and/or logic"
    assert replace_bare_spans(s, policy, "en") == s
