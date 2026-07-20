from local_tts.text_frontend.markdown import strip_markdown


def test_drops_code_block_keeps_prose():
    doc = "Here is code:\n\n```py\nprint(1)\n```\n\nDone."
    out = strip_markdown(doc)
    assert "print" not in out
    assert "Here is code:" in out
    assert "Done." in out


def test_keeps_link_text_drops_url():
    out = strip_markdown("See [the docs](https://example.com/x) now.")
    assert "the docs" in out
    assert "example.com" not in out
    assert "https" not in out


def test_keeps_inline_code_and_emphasis_text():
    out = strip_markdown("Run `npm test` for **bold** and *italic* words.")
    assert "npm test" in out
    assert "bold" in out
    assert "italic" in out


def test_heading_and_list_become_separated_blocks():
    doc = "# Title\n\n- one\n- two"
    out = strip_markdown(doc)
    assert "Title" in out
    assert "one" in out and "two" in out
    # block elements separated by a blank line for the synth's prosodic gap
    assert "\n\n" in out


def test_drops_images_and_bare_urls():
    out = strip_markdown("Look ![alt](a.png) at https://raw.example.com here.")
    assert "a.png" not in out
    assert "raw.example.com" not in out
    assert "Look" in out and "here" in out


def test_empty_document_returns_empty():
    assert strip_markdown("") == ""
    assert strip_markdown("```\nonly code\n```").strip() == ""


def test_softbreak_does_not_concatenate_words():
    out = strip_markdown("quoted text here\nmore quote")
    assert "here more" in out
    assert "heremore" not in out


def test_multiline_blockquote_does_not_concatenate_words():
    out = strip_markdown("> line one\n> line two")
    assert "line one" in out and "line two" in out
    assert "onetwo" not in out


def test_strikethrough_keeps_text_drops_markers():
    out = strip_markdown("This is ~~struck~~ text.")
    assert "struck" in out
    assert "~~" not in out
