import pytest

from local_tts.text_frontend.phrases import phrase


def test_unknown_lang_falls_back_to_english():
    # "auto" is the shipped default_lang value.
    assert phrase("auto", "command") == phrase("en", "command")
    assert phrase("ko", "link") == phrase("en", "link")


def test_unknown_key_raises():
    with pytest.raises(KeyError):
        phrase("en", "not_a_key")
