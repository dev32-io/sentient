import mistune
import pytest

from local_tts.text_frontend.policy import SpeechPolicy
from local_tts.text_frontend.table import render_table

_PARSE = mistune.create_markdown(renderer=None, plugins=["table"])


def _first_table(doc):
    return [t for t in _PARSE(doc) if t["type"] == "table"][0]


def _plain_cell(children):
    return "".join(c.get("raw", "") for c in children)


SMALL = "| Service | Port |\n|---|---|\n| gateway | 8080 |\n| tts | 8888 |\n"


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def test_small_table_is_linearized_with_header_prefixes(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "en")
    assert "Service gateway, Port 8080." in out
    assert "Service tts, Port 8888." in out
    assert "|" not in out


def test_large_table_is_summarized(policy):
    rows = "\n".join(f"| r{i} | v{i} |" for i in range(20))
    doc = f"| A | B |\n|---|---|\n{rows}\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "20" in out and "2" in out
    assert "r0" not in out


def test_zh_uses_chinese_separators(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "zh")
    assert "，" in out
    assert ", " not in out


def test_empty_body_summarizes_rather_than_emitting_junk(policy):
    doc = "| A | B |\n|---|---|\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "|" not in out
    assert out.strip() != ""


def test_all_blank_rows_summarize_rather_than_vanishing(policy):
    # One body row, both cells blank: passes the size gate (1 row, 2 cols, 2
    # cells <= table_max_cells) but has zero speakable content once blank
    # rows are filtered out of the linearized join. Must fall through to the
    # summary phrase instead of returning "".
    doc = "| A | B |\n|---|---|\n|   |   |\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert out.strip() != ""
    assert "1" in out and "2" in out


def test_render_cell_dropping_all_content_summarizes(policy):
    # Simulates the real inline renderer dropping every cell's content (e.g.
    # a row whose only content is an image, which the inline drop-set
    # removes). Even though the table itself is small and well-formed, an
    # all-blank render_cell result must summarize, not vanish.
    out = render_table(_first_table(SMALL), lambda ch: "", policy, "en")
    assert out.strip() != ""
    assert "2" in out


def test_size_gate_boundary_is_strictly_greater_than(policy):
    # 2 columns x N rows == table_max_cells must linearize; the same table
    # plus one more row (2 * (N+1) cells, one more than the cap) must
    # summarize. table_max_cells=6 -> boundary table has 3 rows (2*3=6
    # cells, exactly at the cap); the over table has 4 rows (2*4=8 cells,
    # 2 over the cap) since a table needs a whole extra row to add cells.
    boundary_policy = SpeechPolicy(table_max_cells=6, code_span_max_chars=32, speak_dropped_spans=True)

    at_cap_rows = "\n".join(f"| r{i} | v{i} |" for i in range(3))
    at_cap_doc = f"| A | B |\n|---|---|\n{at_cap_rows}\n"
    at_cap_out = render_table(_first_table(at_cap_doc), _plain_cell, boundary_policy, "en")
    assert "r0" in at_cap_out and "|" not in at_cap_out

    over_cap_rows = "\n".join(f"| r{i} | v{i} |" for i in range(4))
    over_cap_doc = f"| A | B |\n|---|---|\n{over_cap_rows}\n"
    over_cap_out = render_table(_first_table(over_cap_doc), _plain_cell, boundary_policy, "en")
    assert "r0" not in over_cap_out
