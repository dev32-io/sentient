"""Tests for sentient-plugin REST surface.

Run inside the Hermes container venv:

    /opt/hermes/.venv/bin/python -m pytest test_plugin_api.py -v

Tests use FastAPI's TestClient and monkeypatch ``plugin_api._session_db``
so we never need a real HERMES_HOME / SessionDB instance.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import plugin_api


BEARER = "test-bearer-secret"


@pytest.fixture(autouse=True)
def _set_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTIENT_HERMES_BEARER", BEARER)


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace plugin_api._session_db with a MagicMock-backed fake."""

    db = MagicMock()
    monkeypatch.setattr(plugin_api, "_session_db", lambda: db)
    return db


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router)
    return TestClient(app)


def _hdr(token: str = BEARER) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class TestBearerAuth:
    def test_missing_header_rejected(self, client: TestClient) -> None:
        r = client.get("/search?q=hello")
        assert r.status_code == 401

    def test_wrong_token_rejected(self, client: TestClient) -> None:
        r = client.get("/search?q=hello", headers=_hdr("not-the-token"))
        assert r.status_code == 401

    def test_non_bearer_scheme_rejected(self, client: TestClient) -> None:
        r = client.get("/search?q=hello", headers={"Authorization": "Basic xyz"})
        assert r.status_code == 401

    def test_unconfigured_env_returns_503(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("SENTIENT_HERMES_BEARER", raising=False)
        r = client.get("/search?q=hello", headers=_hdr())
        assert r.status_code == 503

    def test_empty_env_treated_as_unconfigured(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("SENTIENT_HERMES_BEARER", "")
        r = client.get("/search?q=hello", headers=_hdr())
        assert r.status_code == 503


# ---------------------------------------------------------------------------
# /search
# ---------------------------------------------------------------------------


class TestSearch:
    def test_empty_query_returns_empty_list(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        r = client.get("/search?q=", headers=_hdr())
        assert r.status_code == 200
        assert r.json() == {"sessions": [], "nextCursor": None}
        fake_db.search_messages.assert_not_called()

    def test_dedupes_by_session_id(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.search_messages.return_value = [
            {
                "session_id": "s1",
                "snippet": "hello >>>moon<<<",
                "role": "user",
                "source": "sentient",
                "model": "gpt",
                "session_started": 1,
            },
            # second hit on same session — should be dropped
            {
                "session_id": "s1",
                "snippet": "another moon",
                "role": "assistant",
                "source": "sentient",
                "model": "gpt",
                "session_started": 1,
            },
            {
                "session_id": "s2",
                "snippet": ">>>moon<<< rise",
                "role": "user",
                "source": "sentient",
                "model": "gpt",
                "session_started": 2,
            },
        ]
        r = client.get("/search?q=moon&limit=10", headers=_hdr())
        assert r.status_code == 200
        body = r.json()
        assert body["nextCursor"] is None
        assert [s["sessionId"] for s in body["sessions"]] == ["s1", "s2"]

    def test_prefix_query_appended(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.search_messages.return_value = []
        r = client.get("/search?q=stor%20deploy", headers=_hdr())
        assert r.status_code == 200
        called_query = fake_db.search_messages.call_args.kwargs["query"]
        assert called_query == "stor* deploy*"

    def test_quoted_phrase_kept_verbatim(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.search_messages.return_value = []
        r = client.get('/search?q=%22exact%20phrase%22', headers=_hdr())
        assert r.status_code == 200
        called_query = fake_db.search_messages.call_args.kwargs["query"]
        assert called_query == '"exact phrase"'


# ---------------------------------------------------------------------------
# GET /sessions/{id}
# ---------------------------------------------------------------------------


class TestGetSession:
    def test_returns_rich_row(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.resolve_session_id.return_value = "abc123"
        fake_db._get_session_rich_row.return_value = {
            "id": "abc123",
            "title": "demo",
            "preview": "hello",
            "last_active": 42,
        }
        r = client.get("/sessions/abc", headers=_hdr())
        assert r.status_code == 200
        assert r.json()["id"] == "abc123"
        fake_db.resolve_session_id.assert_called_once_with("abc")

    def test_unresolved_id_404s(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.resolve_session_id.return_value = None
        r = client.get("/sessions/missing", headers=_hdr())
        assert r.status_code == 404

    def test_resolved_but_row_missing_404s(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.resolve_session_id.return_value = "abc123"
        fake_db._get_session_rich_row.return_value = None
        r = client.get("/sessions/abc", headers=_hdr())
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /sessions/{id}/messages
# ---------------------------------------------------------------------------


class TestGetMessages:
    def test_returns_messages_and_resolved_id(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.resolve_session_id.return_value = "abc123"
        fake_db.get_messages.return_value = [
            {"role": "user", "content": "hi", "timestamp": 1},
            {"role": "assistant", "content": "hello", "timestamp": 2},
        ]
        r = client.get("/sessions/abc/messages", headers=_hdr())
        assert r.status_code == 200
        body = r.json()
        assert body["sessionId"] == "abc123"
        assert len(body["messages"]) == 2
        fake_db.get_messages.assert_called_once_with("abc123")

    def test_unresolved_id_404s(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.resolve_session_id.return_value = None
        r = client.get("/sessions/nope/messages", headers=_hdr())
        assert r.status_code == 404
        fake_db.get_messages.assert_not_called()


# ---------------------------------------------------------------------------
# DELETE /sessions/{id}
# ---------------------------------------------------------------------------


class TestDeleteSession:
    def test_delete_returns_ok(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.delete_session.return_value = True
        r = client.delete("/sessions/abc123", headers=_hdr())
        assert r.status_code == 200
        assert r.json() == {"ok": True, "sessionId": "abc123"}
        fake_db.delete_session.assert_called_once_with("abc123")

    def test_delete_missing_404s(
        self,
        client: TestClient,
        fake_db: MagicMock,
    ) -> None:
        fake_db.delete_session.return_value = False
        r = client.delete("/sessions/missing", headers=_hdr())
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Helpers (pure functions — no monkeypatch needed)
# ---------------------------------------------------------------------------


class TestBuildPrefixQuery:
    def test_simple_terms_get_star(self) -> None:
        assert plugin_api._build_prefix_query("docker deploy") == "docker* deploy*"

    def test_quoted_phrase_kept(self) -> None:
        assert plugin_api._build_prefix_query('"exact phrase" docker') == '"exact phrase" docker*'

    def test_already_starred_kept(self) -> None:
        assert plugin_api._build_prefix_query("foo* bar") == "foo* bar*"

    def test_empty_input(self) -> None:
        assert plugin_api._build_prefix_query("") == ""


def test_module_level_router_has_expected_routes() -> None:
    paths = sorted({r.path for r in plugin_api.router.routes})
    assert paths == [
        "/search",
        "/sessions/{session_id}",
        "/sessions/{session_id}/messages",
    ]
    methods_per_path: dict[str, set[str]] = {}
    for r in plugin_api.router.routes:
        methods_per_path.setdefault(r.path, set()).update(getattr(r, "methods", set()))
    assert "DELETE" in methods_per_path["/sessions/{session_id}"]
    assert "GET" in methods_per_path["/sessions/{session_id}"]
