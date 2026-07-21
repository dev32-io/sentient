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


def test_sentinels_are_prefix_free():
    # The old fixed-two-digits-then-grow scheme was NOT prefix-free: index 26
    # ("ba") is a proper prefix of index 676 ("baa"). restore()'s plain
    # str.replace() loop then corrupts the longer sentinel whenever the
    # shorter one happens to be substituted first. A genuinely prefix-free
    # code makes restore() order-independent regardless of span count.
    m = MaskTable()
    sentinels = [m.add(f"span{i}") for i in range(1001)]

    assert len(set(sentinels)) == len(sentinels), "sentinels must be unique"
    for s in sentinels:
        assert s.isalpha(), f"sentinel {s} is not letters-only"

    for i, shorter in enumerate(sentinels):
        for longer in sentinels:
            if shorter is longer:
                continue
            assert not longer.startswith(shorter), (
                f"sentinel {shorter!r} (index {i}) is a proper prefix of {longer!r}"
            )


def test_restore_at_prefix_collision_boundary():
    # Exact reproduction of the reviewer's corruption: with the old scheme,
    # sentinel[26] == "zqxmaskba" is a prefix of sentinel[676] == "zqxmaskbaa".
    # restore() replaces span 26's sentinel first (insertion order), which
    # matches *inside* span 676's sentinel, destroying span 676's text and
    # leaking span 26's text plus a stray trailing "a" into its place.
    m = MaskTable()
    texts = [f"SPAN{i}" for i in range(677)]
    sentinels = [m.add(t) for t in texts]

    out = m.restore(f"before {sentinels[676]} after")

    assert out == f"before {texts[676]} after"
    assert texts[26] not in out
