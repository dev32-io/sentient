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


def test_replace_bare_url_at_end_of_sentence_keeps_period(policy):
    # A URL followed directly by a period is ordinary English punctuation --
    # the sentence's terminal period must survive the rewrite so the
    # synthesizer keeps its prosodic boundary.
    out = replace_bare_spans("See https://example.com/a.", policy, "en")
    assert out.endswith(".")
    assert "a link" in out


def test_replace_bare_path_at_end_of_sentence_keeps_period(policy):
    out = replace_bare_spans("Config at /Users/kev/notes.md.", policy, "en")
    assert out.endswith(".")
    assert "a file path" in out


def test_replace_bare_spans_preserves_dotted_path_leading_segment(policy):
    # Regression guard: stopping short of trailing sentence punctuation must
    # not break a path whose segment legitimately starts with a dot.
    out = replace_bare_spans("Edit ~/.sentient/gateway/config.yaml now.", policy, "en")
    assert "~/.sentient" not in out
    assert "a file path" in out


def test_replace_bare_email_in_prose(policy):
    out = replace_bare_spans("Contact user@example.com for help.", policy, "en")
    assert "user" not in out
    assert "@" not in out
    assert "an email address" in out


def test_replace_bare_complex_email_in_prose(policy):
    out = replace_bare_spans("Mail first.last+tag@sub.example.co.uk now.", policy, "en")
    assert "@" not in out
    assert "sub.example.co.uk" not in out
    assert "an email address" in out


def test_replace_bare_email_at_end_of_sentence_keeps_period(policy):
    # Same guarantee as the URL/path scanners: the sentence's terminal
    # period must survive the rewrite, not get swallowed into the match.
    out = replace_bare_spans("Email me at user@example.com.", policy, "en")
    assert out.endswith(".")
    assert "an email address" in out


def test_replace_bare_email_is_silent_when_disabled():
    quiet = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=False)
    out = replace_bare_spans("Contact user@example.com for help.", quiet, "en")
    assert "user" not in out
    assert "@" not in out
    assert "an email address" not in out


def test_replace_bare_url_in_chinese_sentence_preserves_trailing_text(policy):
    # Chinese has no inter-word spaces, so a body-class that doesn't stop at
    # CJK punctuation swallows the entire rest of the line.
    out = replace_bare_spans("参考 www.example.com，然后再看看别的。", policy, "zh")
    assert "然后再看看别的" in out
    assert "一个链接" in out


def test_replace_bare_email_inside_url_userinfo_does_not_mangle_the_url(policy):
    # A URL's userinfo ("https://user:pass@host/x") looks exactly like an
    # email address to the bare-email scanner. The email scan runs first
    # (see test below for why) but must not fire INSIDE a URL, or the URL
    # scanner is left with a broken fragment.
    out = replace_bare_spans("See https://ex.com/a.b@c.d/e now.", policy, "en")
    assert out == "See a link now."


def test_replace_bare_email_before_url_scan_still_protects_www_email(policy):
    # THE reason email must still run before the URL scan (not after, and
    # not removed): an address like user@www.example.com contains a
    # "www." that _BARE_URL_RE would otherwise match on its own, mangling
    # the email into "user@a link".
    out = replace_bare_spans("Mail user@www.example.com now.", policy, "en")
    assert out == "Mail an email address now."


def test_replace_bare_spans_leaves_at_sign_without_domain_alone(policy):
    # An "@" with no domain after it (a price marker, not an address).
    s = "Costs $5 @ the store"
    assert replace_bare_spans(s, policy, "en") == s
