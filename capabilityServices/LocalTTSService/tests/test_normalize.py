import pytest

from local_tts.text_frontend.normalize import Normalizer, detect_lang, resolve_lang, script_share


@pytest.fixture(scope="module")
def norm():
    return Normalizer()


def test_currency_expands(norm):
    assert "dollars" in norm.normalize("$12.50", "en").lower()


def test_percent_and_units(norm):
    out = norm.normalize("90% done at 100km/h", "en").lower()
    assert "percent" in out
    assert "kilometers per hour" in out


def test_plain_prose_untouched(norm):
    s = "The weather is nice today and I feel great."
    assert norm.normalize(s, "en") == s


def test_zh_currency_and_negative(norm):
    out = norm.normalize("价格是$50，温度是-5度。", "zh")
    assert "美元" in out
    assert "负" in out


def test_normalizer_cached_per_lang(norm):
    a = norm._for("en")
    b = norm._for("en")
    assert a is b


# Mirrors config.example.yaml's text_frontend.script_confidence default --
# how script-pure a block must be before its own content decides the
# language, rather than falling back to a declared value.
C = 0.9


@pytest.mark.parametrize(("text", "expected"), [
    ("这个价格是 $50。", "zh"),              # neutral chars must not dilute
    ("会议在 7:30 开始。", "zh"),
    ("これは 500 円です。", "ja"),
    ("Wait 5-10 minutes and it costs $50.", "en"),
    ("The character 好 means good, and it costs $50 for 2 items.", "en"),
    ("가격은 $50이고 온도는 -5도입니다.", "en"),   # no Han/kana/Latin -> not CJK
])
def test_detect_lang_on_pure_blocks(text, expected):
    assert detect_lang(text, C) == expected


def test_detect_lang_returns_none_when_genuinely_mixed():
    assert detect_lang("我买了 iPhone，价格是 $50。", C) is None


def test_detect_lang_kana_middle_dot_and_prolonger_do_not_force_japanese():
    # Finding 7: U+30FB (katakana middle dot) and U+30FC (prolonged sound
    # mark) are common in CHINESE text for transliterated foreign names
    # ("史蒂夫・乔布斯" = Steve Jobs) -- they must not force a "ja" verdict.
    assert detect_lang("史蒂夫・乔布斯的价格是 $50。", C) == "zh"
    # Kana priority still holds for genuine Japanese.
    assert detect_lang("これはテスト", C) == "ja"


def test_mixed_block_uses_the_declared_language():
    mixed = "我买了 iPhone，价格是 $50。"
    assert resolve_lang("zh", mixed, C) == "zh"
    assert resolve_lang("auto", mixed, C) == "en"   # undeclared -> English


def test_declared_language_never_overrides_a_pure_block():
    # A declared value is a stale prior: the assistant can switch language
    # mid-conversation, so content wins whenever content is unambiguous.
    assert resolve_lang("zh", "Wait 5-10 minutes.", C) == "en"
    assert resolve_lang("en", "这个价格是 $50。", C) == "zh"


def test_script_share_ignores_neutral_characters():
    assert script_share("$50 7:30 71% -- ...") == 0.0
    assert script_share("这个价格是 $50。") == 1.0


def test_auto_chinese_normalizes_to_chinese_currency(norm):
    lang = resolve_lang("auto", "这个价格是 $50。", C)
    out = norm.normalize("这个价格是 $50。", lang)
    assert "美元" in out
    assert "dollars" not in out
