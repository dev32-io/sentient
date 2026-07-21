from local_tts.text_frontend.residual import sweep_residual_symbols


def test_pipe_becomes_a_sentence_break():
    out = sweep_residual_symbols("Partly cloudy, 22.7C | Humidity 71% | Wind 3.6")
    assert "|" not in out
    assert "22.7C. Humidity" in out
    assert "71%. Wind" in out


def test_pipe_does_not_double_existing_terminal_punctuation():
    # "foo. | bar" must not become "foo.. bar"
    out = sweep_residual_symbols("First done. | Second next")
    assert ".." not in out
    assert "done. Second" in out


def test_repeated_pipes_collapse_to_one_break():
    out = sweep_residual_symbols("a || b")
    assert "|" not in out
    assert out.count(".") == 1


def test_stray_emphasis_markers_are_dropped():
    assert "*" not in sweep_residual_symbols("Some *unclosed emphasis here")
    assert "~" not in sweep_residual_symbols("Trailing ~ tilde and ~unclosed")


def test_hash_dropped_but_sharp_language_names_survive():
    assert sweep_residual_symbols("#tag").strip() == "tag"
    assert "C#" in sweep_residual_symbols("I write C# daily")


def test_underscores_in_prose_become_spaces():
    assert sweep_residual_symbols("snake_case_word here") == "snake case word here"


def test_ordinary_prose_is_untouched():
    s = "The weather is nice today, and it costs $50 (roughly)."
    assert sweep_residual_symbols(s) == s


def test_symbols_the_normalizer_handles_well_are_left_alone():
    s = "Tom & Jerry, a^2, x = y, 5 < 6 > 4"
    assert sweep_residual_symbols(s) == s


def test_sentinel_tokens_are_untouched():
    # Masked spans are letters-only; no rule here may alter one.
    s = "call zqxmaskaz and zqxmaskba now"
    assert sweep_residual_symbols(s) == s
