import pytest

from local_tts.text_frontend.normalize import Normalizer


@pytest.fixture(scope="module")
def norm():
    return Normalizer()


def test_currency_expands(norm):
    assert "dollars" in norm.normalize("$12.50", "en").lower()


def test_percent_and_units(norm):
    out = norm.normalize("90% done at 100km/h", "en").lower()
    assert "percent" in out
    assert "kilometers per hour" in out


def test_range_does_not_corrupt_following_word(norm):
    # Regression: bare wetext turns "5-10 minutes" into "... minutes inutes"
    # (a spurious duplicated tail-word). NOTE: "inutes" is a substring of
    # "minutes" itself (m-inutes), so a raw `"inutes" not in out` check is
    # unsatisfiable by construction once "minutes" is required to be
    # present — check for the standalone corrupted word token instead.
    out = norm.normalize("Wait 5-10 minutes.", "en").lower()
    words = out.replace(".", "").split()
    assert "inutes" not in words  # no spurious duplicated tail-word
    assert "minutes" in out
    assert "to" in out  # "five to ten minutes"


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
