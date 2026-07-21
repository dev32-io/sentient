import pytest

from local_tts.text_frontend.markdown import strip_markdown
from local_tts.text_frontend.policy import SpeechPolicy


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def _text(doc, policy, lang="en"):
    return strip_markdown(doc, policy, lang).text


def test_drops_code_block_keeps_prose(policy):
    out = _text("Here is code:\n\n```py\nprint(1)\n```\n\nDone.", policy)
    assert "print" not in out
    assert "Here is code:" in out and "Done." in out


def test_keeps_link_text_drops_url(policy):
    out = _text("See [the docs](https://example.com/x) now.", policy)
    assert "the docs" in out
    assert "example.com" not in out


def test_heading_and_list_become_separated_blocks(policy):
    out = _text("# Title\n\n- one\n- two", policy)
    assert "Title" in out and "one" in out and "two" in out
    assert "\n\n" in out


def test_drops_images(policy):
    out = _text("Look ![alt](a.png) here.", policy)
    assert "a.png" not in out
    assert "Look" in out and "here" in out


def test_empty_document_returns_empty(policy):
    assert _text("", policy) == ""
    assert _text("```\nonly code\n```", policy).strip() == ""


# --- v2 behaviours ---------------------------------------------------------

def test_table_is_linearized_not_piped(policy):
    doc = "| Service | Port |\n|---|---|\n| gateway | 8080 |\n"
    out = _text(doc, policy)
    assert "|" not in out
    assert "Service gateway" in out and "Port 8080" in out


def test_table_nested_in_list_item_is_linearized_not_piped(policy):
    # An LLM commonly indents a table under a numbered list item; the bare
    # `table` plugin only registers into the root block parser, so without
    # table_in_list this table stays literal pipe text.
    doc = "1. **Services**\n\n   | Service | Port |\n   |---|---|\n   | gateway | 8080 |\n"
    out = _text(doc, policy)
    assert "|" not in out
    assert "Service gateway" in out and "Port 8080" in out


def test_table_nested_in_block_quote_is_linearized_not_piped(policy):
    doc = "> | Service | Port |\n> |---|---|\n> | gateway | 8080 |\n"
    out = _text(doc, policy)
    assert "|" not in out
    assert "Service gateway" in out and "Port 8080" in out


def test_task_list_markers_are_not_spoken(policy):
    out = _text("- [ ] undone\n- [x] done\n", policy)
    assert "[" not in out and "]" not in out
    assert "undone" in out and "done" in out


def test_math_is_dropped(policy):
    out = _text("Math $x^2$ here.\n\n$$\na=b\n$$\n", policy)
    assert "^" not in out and "$" not in out
    assert "Math" in out and "here." in out


def test_footnote_body_is_not_spoken(policy):
    out = _text("Text[^1]\n\n[^1]: secret note body\n", policy)
    assert "secret note body" not in out
    assert "Text" in out


def test_symbol_heavy_inline_code_becomes_a_phrase(policy):
    out = _text("Install with `npm i --save-dev @types/node` now.", policy)
    assert "--save-dev" not in out
    assert "a command" in out


def test_word_like_inline_code_is_kept_but_masked(policy):
    result = strip_markdown("Then call `flush` on it.", policy, "en")
    assert "flush" not in result.text          # masked until after TN
    assert "flush" in result.masks.restore(result.text)


def test_bare_url_in_prose_becomes_a_phrase(policy):
    out = _text("Also www.example.com here.", policy)
    assert "www" not in out
    assert "a link" in out


def test_html_is_dropped(policy):
    out = _text("<div>hidden</div>\n\nInline <b>bold</b> text.\n", policy)
    assert "hidden" not in out and "<b>" not in out
    assert "bold" in out and "text." in out


def test_autolink_speaks_the_phrase_exactly_once(policy):
    out = _text("See <https://example.com/x> now.", policy)
    assert out.count("a link") == 1


def test_email_autolink_is_not_read_verbatim(policy):
    out = _text("Mail <user@example.com> now.", policy)
    assert "user@example.com" not in out
    assert "@" not in out
    assert "an email address" in out


def test_email_autolink_is_silent_when_dropped_spans_not_spoken():
    silent_policy = SpeechPolicy(
        table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=False
    )
    out = _text("Mail <user@example.com> now.", silent_policy)
    assert "user@example.com" not in out
    assert "@" not in out
    assert "an email address" not in out


# --- restored regression coverage (dropped by the Task 5 rewrite) ----------


def test_softbreak_does_not_concatenate_words(policy):
    out = _text("quoted text here\nmore quote", policy)
    assert "here more" in out
    assert "heremore" not in out


def test_multiline_blockquote_does_not_concatenate_words(policy):
    out = _text("> line one\n> line two", policy)
    assert "line one" in out and "line two" in out
    assert "onetwo" not in out


def test_strikethrough_keeps_text_drops_markers(policy):
    out = _text("This is ~~struck~~ text.", policy)
    assert "struck" in out
    assert "~~" not in out
