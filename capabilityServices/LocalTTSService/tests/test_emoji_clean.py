from local_tts.text_frontend.emoji_clean import strip_emoji, strip_pause_tags


def test_strip_emoji_removes_emoji_keeps_words():
    assert strip_emoji("great job 🎉👏 today") == "great job  today"


def test_strip_emoji_noop_on_plain_text():
    assert strip_emoji("no emoji here") == "no emoji here"


def test_strip_pause_tags_removes_bracket_tags():
    assert strip_pause_tags("[pause] hello [short pause] world").strip() == "hello  world".strip()


def test_strip_pause_tags_removes_cjk_pause_tags():
    assert "停顿" not in strip_pause_tags("你好[长停顿]世界")
