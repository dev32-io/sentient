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


def test_detect_lang_by_script():
    assert detect_lang("It costs fifty dollars.") == "en"
    assert detect_lang("这个价格是五十美元。") == "zh"
    assert detect_lang("これはテストです。") == "ja"


def test_detect_lang_mixed_prefers_cjk():
    # A CJK sentence with embedded latin is still CJK.
    assert detect_lang("价格 $50 and it costs $20 too.") == "zh"


def test_resolve_lang_honours_a_concrete_declaration():
    assert resolve_lang("zh", "plain english text") == "zh"
    assert resolve_lang("en", "这是中文") == "en"


def test_resolve_lang_detects_when_declared_auto():
    # THE production bug: "auto" used to collapse to "en", so Chinese was
    # normalized by the English engine and spoke "fifty dollars".
    assert resolve_lang("auto", "这个价格是 $50。") == "zh"
    assert resolve_lang("auto", "It costs $50.") == "en"


def test_auto_chinese_normalizes_to_chinese_currency(norm):
    lang = resolve_lang("auto", "这个价格是 $50。")
    out = norm.normalize("这个价格是 $50。", lang)
    assert "美元" in out
    assert "dollars" not in out
