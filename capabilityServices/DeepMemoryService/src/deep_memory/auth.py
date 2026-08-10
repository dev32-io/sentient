"""Split-credential bearer auth — two planes, ADMIN and DATA.

The service speaks exactly two bearer tokens, injected as environment
variables by the launcher (never on disk in config):

* ``DEEP_MEMORY_ADMIN_TOKEN`` — control-plane operations that mutate the scope
  topology or wipe data: ``register-scope``, ``purge``, ``rebuild``.
* ``DEEP_MEMORY_DATA_TOKEN`` — hot-path data operations: ``upsert``,
  ``search``, ``set-status``.

Plane rule: the admin token is a superset — it is accepted on data endpoints
too. The data token is NOT accepted on admin endpoints (a leaked data token
must not be able to re-point or drop a scope). Token comparison is
constant-time (``hmac.compare_digest``) so a timing side-channel can't recover
a token byte-by-byte.
"""

from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from enum import Enum

_BEARER_PREFIX = "Bearer "

_ADMIN_TOKEN_ENV = "DEEP_MEMORY_ADMIN_TOKEN"
_DATA_TOKEN_ENV = "DEEP_MEMORY_DATA_TOKEN"


class AuthError(RuntimeError):
    """Raised at startup when a required token env var is missing."""


class Plane(Enum):
    """The two credential planes. ADMIN is a superset of DATA."""

    ADMIN = "admin"
    DATA = "data"


@dataclass(frozen=True)
class Tokens:
    """The two live bearer tokens the service checks."""

    admin: str
    data: str


def load_tokens_from_env() -> Tokens:
    """Read both tokens from the environment, failing loud if either is unset.

    An empty or missing token is a hard startup error — the service must never
    come up accepting an empty bearer.
    """
    admin = os.environ.get(_ADMIN_TOKEN_ENV, "")
    data = os.environ.get(_DATA_TOKEN_ENV, "")
    if not admin:
        raise AuthError(f"{_ADMIN_TOKEN_ENV} is unset or empty")
    if not data:
        raise AuthError(f"{_DATA_TOKEN_ENV} is unset or empty")
    return Tokens(admin=admin, data=data)


def _extract_bearer(auth_header: str | None) -> str | None:
    """Pull the raw token out of an ``Authorization: Bearer <token>`` header."""
    if not auth_header or not auth_header.startswith(_BEARER_PREFIX):
        return None
    token = auth_header[len(_BEARER_PREFIX):].strip()
    return token or None


def authenticate(auth_header: str | None, tokens: Tokens) -> Plane | None:
    """Resolve the request's plane from its Authorization header.

    Returns the matched ``Plane`` (the admin token resolves to ``ADMIN``, the
    data token to ``DATA``), or ``None`` when the header is missing or the
    token matches neither.
    """
    presented = _extract_bearer(auth_header)
    if presented is None:
        return None
    if hmac.compare_digest(presented, tokens.admin):
        return Plane.ADMIN
    if hmac.compare_digest(presented, tokens.data):
        return Plane.DATA
    return None


def plane_satisfies(actual: Plane, required: Plane) -> bool:
    """True when ``actual`` may act on an endpoint that requires ``required``.

    ADMIN satisfies everything; DATA satisfies only DATA endpoints.
    """
    if actual is Plane.ADMIN:
        return True
    return required is Plane.DATA
