import pytest

from local_tts.text_frontend.phrases import phrase
from local_tts.text_frontend.policy import SpeechPolicy


def test_policy_is_frozen():
    p = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)
    assert p.table_max_cells == 24
    with pytest.raises(Exception):
        p.table_max_cells = 1  # frozen dataclass


def test_english_phrases():
    assert phrase("en", "command") == "a command"
    assert phrase("en", "file_path") == "a file path"
    assert phrase("en", "link") == "a link"


def test_chinese_phrases_differ():
    assert phrase("zh", "command") != phrase("en", "command")
    assert phrase("zh", "cell_sep") == "，"


def test_unknown_lang_falls_back_to_english():
    # "auto" is the shipped default_lang value.
    assert phrase("auto", "command") == phrase("en", "command")
    assert phrase("ko", "link") == phrase("en", "link")


def test_table_summary_is_a_format_template():
    out = phrase("en", "table_summary").format(rows=12, cols=6)
    assert "12" in out and "6" in out


def test_unknown_key_raises():
    with pytest.raises(KeyError):
        phrase("en", "not_a_key")
