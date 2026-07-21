from local_tts.text_frontend import TextFrontend, build_frontend


def test_end_to_end_markdown_currency_emoji():
    fe = build_frontend(normalize_enabled=True)
    doc = "## Weather 🎉\n\nIt costs **$50** for `2` items.\n\n```py\nx=1\n```"
    out = fe.process(doc, "en").lower()
    assert "dollars" in out
    assert "🎉" not in out and "weather" in out
    assert "x=1" not in out  # code block dropped
    assert "$" not in out


def test_normalize_disabled_keeps_symbols_but_strips_markdown():
    fe = build_frontend(normalize_enabled=False)
    out = fe.process("Cost is **$50** 🎉", "en")
    assert "$50" in out  # not normalized
    assert "🎉" not in out  # still stripped


def test_empty_after_strip_returns_empty():
    fe = build_frontend(normalize_enabled=True)
    assert fe.process("```\njust code\n```", "en").strip() == ""


def test_collapses_double_space_from_dropped_inline_node():
    fe = build_frontend(normalize_enabled=False)
    out = fe.process("Look ![alt](a.png) here", "en")
    assert "  " not in out
    assert "Look here" in out


def test_preserves_paragraph_breaks_for_prosody():
    fe = build_frontend(normalize_enabled=False)
    out = fe.process("# Title\n\nBody text here.", "en")
    assert "\n\n" in out


def test_normalize_preserves_paragraph_breaks():
    fe = build_frontend(normalize_enabled=True)
    out = fe.process("# Weather\n\nIt costs $50 today.", "en")
    assert "\n\n" in out                 # prosodic gap survives normalization
    assert "dollars" in out.lower()      # normalization still ran


def test_normalize_does_not_glue_blocks():
    fe = build_frontend(normalize_enabled=True)
    out = fe.process("Here is a list:\n\n- apples\n- oranges", "en")
    # Blocks are joined with "\n\n", not glued directly — checking against
    # the raw output (not newline-stripped) is the real invariant: stripping
    # ALL newlines would recreate "list:apples" even on correctly-preserved
    # \n\n-separated blocks, since strip_markdown emits "list:" and "apples"
    # as adjacent blocks with no space between them.
    assert "list:apples" not in out  # no cross-block gluing
    assert "\n\n" in out
