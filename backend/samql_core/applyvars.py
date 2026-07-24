"""Workflow variables: a ``variable`` node declares name -> value pairs, and
``${name}`` tokens anywhere in the other nodes' string config are replaced with
those values before the graph is compiled to SQL.

This is a pure graph -> graph preprocessing pass (no engine, no signature
changes downstream): the run/export/probe paths call ``resolve_graph(graph)``
once, up front, and everything after sees a plain graph with the tokens already
filled in. The iterator (a later node) reuses the same pass by passing a
per-iteration ``extra`` context that overrides the static definitions.

Substitution comes in two forms. ``${name}`` is raw -- replaced with the
value's text verbatim -- so the author controls quoting (``${n}`` for a bare
number/identifier, ``'${as_of}'`` for a string literal). ``{{name}}`` inserts
the value as a quoted SQL string literal automatically, so you can just write
``{{name}}`` for a text value instead of ``'${name}'``. Tokens with no matching
variable are left untouched so a typo surfaces instead of silently vanishing.
"""
import copy
import datetime as _dt
import re

# ${name}; name is a normal identifier (letters/digits/underscore, not leading
# digit). Anything else (e.g. ${1} or ${a-b}) is left alone.
_TOKEN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
# {{name}}; the value is substituted as a SQL string literal (auto-quoted and
# escaped) so you can write {{col}} instead of '${col}' for a text value. Bare
# ${col} is still the raw form (numbers / identifiers / SQL fragments).
_QTOKEN = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
# A {{name}} token the author already wrapped in single quotes -- absorbed as
# one literal by substitute_text so it can't double-quote into ''value''.
_QTOKEN_QUOTED = re.compile(r"'\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}'")
# {{in}} / {{input}} are reserved by the SQL node for splicing its input table,
# so the auto-quote never touches them (a variable that happens to be named
# "in"/"input" must use ${...} instead).
_RESERVED_MUSTACHE = ("in", "input")
# nodes whose templated field is a raw value (a URL, a file path), not SQL --
# {{name}} (which inserts a quoted SQL string) is always wrong in these, so it
# is flagged with a context-appropriate "use ${name}" message.
_RAW_VALUE_NODES = {
    "apinode": ("API", "a URL or query parameter"),
    "webscrape": ("Web scrape", "a URL"),
    "sharepoint": ("SharePoint", "a site URL"),
    "filebrowser": ("file browser", "a file path"),
}


def _sql_str_literal(value):
    """Render a value as a single-quoted SQL string literal, escaping quotes.

    Delegates to :func:`sqlutil.sql_str_literal` so a pasted ISO date like
    ``'2026-01-26'`` is not double-wrapped into ``'''2026-01-26'''``.
    """
    from .sqlutil import sql_str_literal
    return sql_str_literal(value)


# ---- expression-valued variables ------------------------------------------
# A variable row may carry ``kind: "expr"``: its ``value`` is then a SQL
# expression evaluated ONCE per run (like a formula node's expression, but
# scalar and with no input relation) and the resulting value becomes the
# variable's text. That is what makes ``${as_of}`` usable in a SQL Server WHERE
# clause: the expression is evaluated locally by DuckDB and substituted as a
# plain literal, so the remote dialect never has to understand the function.
#
# Friendly zero-arg aliases so an author does not need DuckDB spellings. Only
# zero-arg forms are rewritten (``NAME()``), which cannot collide with a real
# function call that takes arguments.
_VAR_FUNCS = {
    "date_time_now": "current_timestamp",
    "datetime_now": "current_timestamp",
    "date_now": "current_date",
    "today": "current_date",
    "now": "current_timestamp",
    "utc_now": "current_timestamp",
}

_ZERO_ARG_CALL = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)")


def expand_var_functions(expr):
    """Rewrite friendly zero-arg aliases (``DATE_TIME_NOW()`` -> engine SQL).

    Unknown zero-arg calls are left alone so real engine functions still work.
    """
    if not expr or "(" not in expr:
        return expr

    def repl(m):
        target = _VAR_FUNCS.get(m.group(1).lower())
        return target if target else m.group(0)

    return _ZERO_ARG_CALL.sub(repl, expr)


def render_scalar(value):
    """Render an evaluated scalar as the variable's substitution text.

    Dates / timestamps are rendered ISO-style WITHOUT timezone suffix or
    microseconds so the text drops straight into another dialect's literal
    (notably a SQL Server ``WHERE d >= '...'``). Everything else is ``str``.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None, microsecond=0).isoformat(sep=" ")
    if isinstance(value, _dt.date):
        return value.isoformat()
    return str(value)


def is_expr_row(row):
    """True when a variable row's value is a SQL expression, not literal text.

    ``kind: "expr"`` is the explicit marker written by the variable node's
    Expression mode. Rows with no ``kind`` stay literal text, so every saved
    workflow keeps its existing meaning.
    """
    if not isinstance(row, dict):
        return False
    return str(row.get("kind") or "text").strip().lower() == "expr"


def collect_vars(graph, evaluate=None):
    """Build {name: value_text} from every ``variable`` node in the graph.

    A variable node's config is ``{"vars": [{"name", "value", "kind"}, ...]}``.
    Blank names are skipped; later definitions win on a duplicate name.

    Rows marked ``kind: "expr"`` hold a SQL expression. When an ``evaluate``
    callable is supplied it is called with the (alias-expanded) expression and
    must return the scalar result; the rendered scalar becomes the value. With
    no evaluator the expression text is used verbatim -- callers that only need
    the *names* (probes, brace checks) therefore do not pay for engine work.
    """
    ctx = {}
    if not isinstance(graph, dict):
        return ctx
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != "variable":
            continue
        cfg = node.get("config") or {}
        for row in cfg.get("vars") or []:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            val = row.get("value")
            text = "" if val is None else str(val)
            if is_expr_row(row) and evaluate is not None and text.strip():
                text = render_scalar(
                    evaluate(expand_var_functions(text.strip()), name))
            ctx[name] = text
    return ctx


def substitute_text(text, ctx):
    """Replace variable tokens in ``text`` from ``ctx``. ``${name}`` is the raw
    form (value inserted verbatim -- you control quoting); ``{{name}}`` inserts
    the value as a quoted SQL string literal (the easy default for text). Tokens
    with no matching variable are returned unchanged (a typo surfaces). The
    ``{{in}}`` / ``{{input}}`` SQL-splice keywords are never auto-quoted.

    A token the author already wrapped in single quotes (``'{{name}}'``) is
    absorbed as one literal -- otherwise the auto-quote double-quotes it into
    ``''value''``, which is a syntax error on every engine."""
    if not text or not ctx:
        return text
    if "${" not in text and "{{" not in text:
        return text

    def repl_raw(m):
        name = m.group(1)
        return ctx[name] if name in ctx else m.group(0)

    def repl_quoted(m):
        name = m.group(1)
        if name in _RESERVED_MUSTACHE:
            return m.group(0)
        return _sql_str_literal(ctx[name]) if name in ctx else m.group(0)

    text = _TOKEN.sub(repl_raw, text)
    # Author-quoted tokens first: `'{{x}}'` -> one literal, not two.
    text = _QTOKEN_QUOTED.sub(repl_quoted, text)
    text = _QTOKEN.sub(repl_quoted, text)
    return text


def _sub_tree(obj, ctx):
    """Substitute in every string within a nested config structure."""
    if isinstance(obj, str):
        return substitute_text(obj, ctx)
    if isinstance(obj, list):
        return [_sub_tree(x, ctx) for x in obj]
    if isinstance(obj, dict):
        return {k: _sub_tree(v, ctx) for k, v in obj.items()}
    return obj


def resolve_graph(graph, extra=None, evaluate=None):
    """Return a copy of ``graph`` with ``${name}`` tokens resolved from its
    variable nodes (overridden by ``extra``, used by the iterator). The variable
    nodes themselves are left untouched so they can't reference each other (no
    chaining / cycles). When there is nothing to resolve, the original graph is
    returned unchanged (no copy).

    ``evaluate`` (see :func:`collect_vars`) turns ``kind: "expr"`` rows into
    their computed scalar, so a date variable can be defined once as
    ``DATE_TIME_NOW()`` and land in every downstream node as a plain literal."""
    if not isinstance(graph, dict):
        return graph
    ctx = collect_vars(graph, evaluate=evaluate)
    if extra:
        ctx.update({str(k): ("" if v is None else str(v))
                    for k, v in extra.items()})
    if not ctx:
        return graph
    out = copy.deepcopy(graph)
    for node in out.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") == "variable":
            continue
        if isinstance(node.get("config"), (dict, list)):
            node["config"] = _sub_tree(node["config"], ctx)
    return out


def unresolved_tokens(obj):
    """Return the sorted unique variable names still present in a config
    structure as ``${name}`` or ``{{name}}``. After substitution, anything that
    remains is an unbound variable (a typo, or a name that doesn't match the
    values it should). Used to turn the engine's cryptic ``unrecognized token``
    error into a clear, actionable message that names the offending variable.
    The ``{{in}}`` / ``{{input}}`` SQL-splice keywords are not reported."""
    found = set()

    def walk(o):
        if isinstance(o, str):
            for m in _TOKEN.finditer(o):
                found.add(m.group(1))
            for m in _QTOKEN.finditer(o):
                if m.group(1) not in _RESERVED_MUSTACHE:
                    found.add(m.group(1))
        elif isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)

    walk(obj)
    return sorted(found)


def _brace_names_in(obj):
    """Collect every non-reserved ``{{name}}`` token in a config structure,
    in document order (duplicates kept so the first occurrence wins)."""
    out = []

    def walk(o):
        if isinstance(o, str):
            for m in _QTOKEN.finditer(o):
                if m.group(1) not in _RESERVED_MUSTACHE:
                    out.append(m.group(1))
        elif isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)

    walk(obj)
    return out


def _is_numeric(value):
    """True if ``value`` parses as a plain number (int/float, +/-, exponent)."""
    if value is None:
        return False
    try:
        float(str(value).strip())
        return True
    except (TypeError, ValueError):
        return False


def _brace_misuse_node(node, ctx):
    """Return a clear error for the first ``{{name}}`` misuse in one node (and,
    for containers, its children), or None."""
    if not isinstance(node, dict):
        return None
    ntype = node.get("type")
    cfg = node.get("config")
    # containers: check the body too (a formula / API inside an iterator/group)
    if ntype in ("group", "iterator") and isinstance(cfg, dict):
        for child in cfg.get("children") or []:
            err = _brace_misuse_node(child, ctx)
            if err:
                return err
    names = _brace_names_in(cfg)
    # an API URL / a file-browser path needs the raw value, never a quoted SQL
    # string -- so any {{name}} there is wrong regardless of the value
    if ntype in _RAW_VALUE_NODES and names:
        kind, where = _RAW_VALUE_NODES[ntype]
        n = names[0]
        return ("The %s node uses {{%s}}, which inserts a quoted SQL string "
                "('value') -- wrong in %s. Use ${%s} for the raw value "
                "instead." % (kind, n, where, n))
    # elsewhere {{name}} is the auto-quote form, so a numeric value is a misuse:
    # the author almost certainly wanted the bare number via ${name}
    for n in names:
        if n in ctx and _is_numeric(ctx[n]):
            v = str(ctx[n]).strip()
            return ("{{%s}} quotes the value as text, but \"%s\" is a number. "
                    "Use ${%s} for the number (or '${%s}' for the literal "
                    "text \"%s\")." % (n, v, n, n, v))
    return None


def brace_misuse(graph, ctx):
    """Return a clear error string for the first ``{{name}}`` *misuse* in the
    graph's node configs given ``ctx`` (name -> value), or None if all uses are
    fine. ``{{name}}`` inserts a quoted SQL string literal, so two uses are
    wrong and should use the raw ``${name}`` form instead: a numeric value (you
    want the bare number, not '42'); and anywhere in an API node (a URL needs
    the raw value, not SQL quotes). The ``{{in}}`` / ``{{input}}`` SQL-splice
    keywords are never flagged. Used to turn a silently-wrong substitution into
    an actionable up-front error."""
    if not isinstance(graph, dict):
        return None
    ctx = ctx or {}
    for node in graph.get("nodes") or []:
        err = _brace_misuse_node(node, ctx)
        if err:
            return err
    return None
