import pytest

from local_tts.text_frontend import SpeechPolicy, build_frontend


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


# Mirrors config.example.yaml's text_frontend.cjk_ratio default.
_CJK_RATIO = 0.2


def _fe(policy, langs=("zh", "ja")):
    return build_frontend(
        normalize_enabled=True, normalize_languages=langs, policy=policy, cjk_ratio=_CJK_RATIO
    )


# Pre-existing pipeline tests below predate the per-language gate and are not
# about it -- they pin markdown/mask/whitespace behaviour. All three
# languages are enabled so their original always-on-normalization assertions
# still hold.
_ALL_LANGS = ("en", "zh", "ja")


def test_english_is_not_normalized(policy):
    out = _fe(policy).process("It costs $50 for 2 items.", "auto")
    assert "$50" in out          # left for the model, which speaks it correctly
    assert "dollars" not in out


def test_chinese_is_normalized(policy):
    out = _fe(policy).process("这个价格是 $50。", "auto")
    assert "美元" in out
    assert "dollars" not in out


def test_phrase_language_is_decided_on_the_stripped_text(policy):
    # The strip picks the phrase language, but the strip is also what removes
    # the URL and code span that dilute the script ratio: this document scores
    # 0.164 CJK raw (below the 0.2 threshold, so "en") and 0.375 once stripped.
    # Measuring the raw form emitted English phrases mid-Chinese sentence.
    out = _fe(policy).process(
        "这是链接 https://example.com/a/b ，请运行 `flush --now --verbose` 命令。", "auto"
    )
    assert "一个链接" in out
    assert "一条命令" in out
    assert "a link" not in out


def test_mixed_document_normalizes_only_the_cjk_block(policy):
    out = _fe(policy).process("It costs $50.\n\n这个价格是 $50。", "auto")
    assert "$50" in out          # english block untouched
    assert "美元" in out          # chinese block normalized


def test_pipe_is_left_for_the_model(policy):
    # Measured: the model renders a prose pipe as a natural pause, and the
    # English normalizer is what used to say "vertical bar".
    out = _fe(policy).process("Cloudy | Humidity 71% | Windy", "auto")
    assert "|" in out


def test_end_to_end_markdown_currency_emoji(policy):
    fe = build_frontend(
        normalize_enabled=True, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    doc = "## Weather 🎉\n\nIt costs **$50** for 2 items.\n\n```py\nx=1\n```"
    out = fe.process(doc, "en").lower()
    assert "dollars" in out
    assert "🎉" not in out and "weather" in out
    assert "x=1" not in out
    assert "$" not in out


def test_normalize_disabled_keeps_symbols_but_strips_markdown(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Cost is **$50** 🎉", "en")
    assert "$50" in out
    assert "🎉" not in out


def test_empty_after_strip_returns_empty(policy):
    fe = build_frontend(
        normalize_enabled=True, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    assert fe.process("```\njust code\n```", "en").strip() == ""


def test_masked_span_is_restored_verbatim_after_normalization(policy):
    fe = build_frontend(
        normalize_enabled=True, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Then call `flush` and check `v1.2.3`.", "en")
    assert "flush" in out
    assert "v1.2.3" in out            # NOT "one point two point three"
    assert "zqxmask" not in out       # no sentinel leaked


def test_table_survives_the_full_pipeline(policy):
    fe = build_frontend(
        normalize_enabled=True, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("| Service | Port |\n|---|---|\n| gateway | 8080 |\n", "en")
    assert "vertical bar" not in out
    assert "Service gateway" in out


def test_no_orphan_punctuation_after_dropped_spans(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("See [x](https://a.b) , and ( ) done.", "en")
    assert " ," not in out
    assert "( )" not in out and "()" not in out


def test_paragraph_gaps_are_preserved(policy):
    fe = build_frontend(
        normalize_enabled=True, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("First para.\n\nSecond para.", "en")
    assert "\n\n" in out


def test_ellipsis_after_comma_survives(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Wait, ... what?", "en")
    assert "..." in out
    assert "what" in out


def test_ellipsis_with_no_space_survives_and_keeps_the_space(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("So, ...anyway.", "en")
    assert "..." in out
    assert ",anyway" not in out
    assert ", ..." in out


def test_ellipsis_in_prose_keeps_its_leading_space(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Hello ... world", "en")
    assert out == "Hello ... world"


def test_repeated_punct_still_cleans_a_dropped_span_artifact(policy):
    # The image is dropped entirely (policy: drop), stranding the colon
    # against the following full stop -- exactly the artifact this rule
    # exists to clean up.
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Reference: ![diagram](fig.png). See below.", "en")
    assert out == "Reference. See below."


def test_ordinary_list_prose_is_untouched(policy):
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("one, two, three.", "en")
    assert out == "one, two, three."


def test_space_before_punct_still_cleans_a_dropped_span_artifact(policy):
    # The image is dropped entirely, stranding a space against the
    # following comma -- exactly the ordinary artifact _SPACE_BEFORE_PUNCT
    # exists to clean up (not an ellipsis, so it must still fire).
    fe = build_frontend(
        normalize_enabled=False, normalize_languages=_ALL_LANGS, policy=policy, cjk_ratio=_CJK_RATIO
    )
    out = fe.process("Check the chart ![chart](fig.png) , it changes weekly.", "en")
    assert out == "Check the chart, it changes weekly."


