from wetext import Normalizer

from local_tts.text_frontend.mask import MaskTable


def test_add_returns_distinct_sentinels():
    m = MaskTable()
    a = m.add("v1.2.3")
    b = m.add("8080")
    assert a != b


def test_restore_round_trips():
    m = MaskTable()
    s = m.add("--save-dev")
    assert m.restore(f"run {s} now") == "run --save-dev now"


def test_restore_is_noop_without_sentinels():
    assert MaskTable().restore("plain text") == "plain text"


def test_sentinels_are_letters_only():
    m = MaskTable()
    for i in range(60):  # forces the second base-26 digit
        assert m.add(f"x{i}").isalpha()


def test_sentinels_survive_wetext_normalization():
    # THE reason this module exists: any sentinel shape containing digits
    # or underscores gets verbalized by wetext and the restore misses.
    m = MaskTable()
    sentinels = [m.add(f"tok{i}") for i in range(30)]
    text = " and ".join(sentinels)
    out = Normalizer(lang="en", operator="tn").normalize(text)
    for s in sentinels:
        assert s in out, f"sentinel {s} did not survive TN"
