"""Formatting helpers for surfacing exceptions to the UI."""


def err_str(exc):
    """Render an exception as "TypeName: message" -- the single format used
    across the HTTP layer and the session for the ``error`` field of API
    replies. Previously this exact construction was inlined (in both f-string
    and %-format spellings) at dozens of call sites."""
    return "%s: %s" % (type(exc).__name__, exc)
