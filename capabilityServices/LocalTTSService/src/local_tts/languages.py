"""Python mirror of the canonical Qwen3-TTS language codes.

The TS source of truth is shared/config/src/languages.ts. The service only
STORES the language string (the gateway validates on the way in), so this is
kept minimal — a frozenset for a defensive membership check + docs parity.
"""

SUPPORTED_LANGUAGES: frozenset[str] = frozenset(
    {"zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"}
)
