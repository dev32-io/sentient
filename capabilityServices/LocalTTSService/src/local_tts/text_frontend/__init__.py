"""Text frontend: markdown/emoji strip + normalization before synthesis."""

from .frontend import TextFrontend, build_frontend
from .policy import SpeechPolicy

__all__ = ["SpeechPolicy", "TextFrontend", "build_frontend"]
