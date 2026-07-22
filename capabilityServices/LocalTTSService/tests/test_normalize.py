import pytest

from local_tts.text_frontend.normalize import Normalizer, detect_lang, resolve_lang


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


# Mirrors config.example.yaml's text_frontend.cjk_ratio default -- the
# minimum share of a block's non-whitespace characters that must be CJK
# before it is treated as Chinese/Japanese.
_CJK_RATIO = 0.2


def test_detect_lang_by_script():
    assert detect_lang("It costs fifty dollars.", _CJK_RATIO) == "en"
    assert detect_lang("这个价格是五十美元。", _CJK_RATIO) == "zh"
    assert detect_lang("これはテストです。", _CJK_RATIO) == "ja"


def test_detect_lang_mixed_prefers_cjk_when_ratio_is_high():
    # A CJK-DOMINANT sentence with embedded latin/currency is still CJK.
    assert detect_lang("这个东西的价格是 $50，别的东西是 $20。", _CJK_RATIO) == "zh"


def test_detect_lang_mixed_falls_back_to_en_when_ratio_is_low():
    # Finding 2: sparse CJK inside a mostly-English sentence must not flip
    # the whole block to the Chinese engine -- this used to be "zh" under
    # the old any-Han-present rule.
    assert detect_lang("价格 $50 and it costs $20 too.", _CJK_RATIO) == "en"


def test_detect_lang_korean_is_not_chinese():
    # Finding 1: _HAN_RE's second range was typo'd to start at U+8C48 (a
    # normal ideograph that LOOKS like U+F900 in most fonts) instead of
    # U+F900 itself, which silently widened the range over the whole
    # Hangul Syllables block. Korean text was being routed to the Chinese
    # WFST engine and spoken with Chinese number words.
    text = "가격은 $50이고 온도는 -5도입니다. 회의는 7:30에 시작합니다."
    assert detect_lang(text, _CJK_RATIO) == "en"


def test_detect_lang_ignores_a_single_incidental_han_character():
    # Finding 2: one quoted CJK character (a name, a dish) must not flip an
    # entire English block to the Chinese engine.
    text = "The character 好 means good, and it costs $50 for 2 items."
    assert detect_lang(text, _CJK_RATIO) == "en"


def test_detect_lang_still_detects_short_chinese_strings():
    # Finding 2 regression guard: the ratio gate must not raise the bar so
    # high that ordinary short Chinese lines stop detecting.
    assert detect_lang("这个价格是 $50。", _CJK_RATIO) == "zh"
    assert detect_lang("多云 | 湿度 71% | 有风", _CJK_RATIO) == "zh"


def test_detect_lang_kana_middle_dot_and_prolonger_do_not_force_japanese():
    # Finding 7: U+30FB (katakana middle dot) and U+30FC (prolonged sound
    # mark) are common in CHINESE text for transliterated foreign names
    # ("史蒂夫・乔布斯" = Steve Jobs) -- they must not force a "ja" verdict.
    assert detect_lang("史蒂夫・乔布斯的价格是 $50。", _CJK_RATIO) == "zh"
    # Kana priority still holds for genuine Japanese.
    assert detect_lang("これはテスト", _CJK_RATIO) == "ja"


def test_resolve_lang_honours_a_concrete_declaration():
    assert resolve_lang("zh", "plain english text", _CJK_RATIO) == "zh"
    assert resolve_lang("en", "这是中文", _CJK_RATIO) == "en"


def test_resolve_lang_detects_when_declared_auto():
    # THE production bug: "auto" used to collapse to "en", so Chinese was
    # normalized by the English engine and spoke "fifty dollars".
    assert resolve_lang("auto", "这个价格是 $50。", _CJK_RATIO) == "zh"
    assert resolve_lang("auto", "It costs $50.", _CJK_RATIO) == "en"


def test_auto_chinese_normalizes_to_chinese_currency(norm):
    lang = resolve_lang("auto", "这个价格是 $50。", _CJK_RATIO)
    out = norm.normalize("这个价格是 $50。", lang)
    assert "美元" in out
    assert "dollars" not in out
