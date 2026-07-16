"""Formatting helpers for surfacing exceptions to the UI."""
import re

_SECRET_PATTERNS = (
    re.compile(r"(?i)(PWD\s*=\s*)(\{[^}]*\}|[^\s;]+)"),
    re.compile(r"(?i)(Password\s*=\s*)(\{[^}]*\}|[^\s;]+)"),
    re.compile(r"(?i)(pwd|password|passwd|secret|token|auth_pass|api[_-]?key)\s*[:=]\s*([^\s,;]+)"),
    re.compile(r"(?i)(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]+)"),
    re.compile(r"(?i)(Authorization:\s*Bearer\s+)(\S+)"),
)
_SK_TOKEN = re.compile(r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b")


def redact_secrets(text):
    """Strip connection-string / credential fragments from diagnostic text."""
    if text is None:
        return ""
    out = str(text)
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(lambda m: m.group(1) + "***", out)
    out = _SK_TOKEN.sub("sk-***", out)
    return out


def err_str(exc):
    """Render an exception as "TypeName: message" -- the single format used
    across the HTTP layer and the session for the ``error`` field of API
    replies. Previously this exact construction was inlined (in both f-string
    and %-format spellings) at dozens of call sites."""
    return "%s: %s" % (type(exc).__name__, redact_secrets(exc))
