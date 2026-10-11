"""
tests/test_json_integrity.py
Focused RED->GREEN suite for the JSON parse-completeness / fail-closed fix.

Issues fixed:
- _iter_stream_records silently succeeds on truncated / malformed input.
- _skip_ws() used b[p] <= " " which silently consumed illegal control
  characters (NUL U+0000, VT U+000B, FF U+000C) as if they were legal JSON
  whitespace. Legal JSON whitespace is ONLY: space, tab, LF, CR.
- _detect_first_char() used str.lstrip(), which also strips VT/FF/U+001C-1F, so
  a file of legal whitespace plus one such control was classified as empty.

Run focused:
  SAMQL_ONLY="json integrity" SAMQL_GROUP=backend \\
      PYTHONDONTWRITEBYTECODE=1 /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only

Standalone under forced stdlib:
  SAMQL_JSON_READER=stdlib PYTHONDONTWRITEBYTECODE=1 \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/test_json_integrity.py

Standalone (normal / installed-ijson routing):
  PYTHONDONTWRITEBYTECODE=1 /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/test_json_integrity.py
"""
import json
import math
import os
import sys
import tempfile

# Allow direct execution from any working directory
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(os.path.dirname(_HERE), "backend")
for _p in (_HERE, _BACKEND):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from samql_core.flatten import stream_json_records


# ---------------------------------------------------------------------------
# tiny helpers
# ---------------------------------------------------------------------------

def _write(name, text, dd):
    p = os.path.join(dd, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


# Sentinel for missing dict key
_MISSING = object()

# Acceptable parser exception types for fail-closed checks.
# Both ValueError and json.JSONDecodeError (a subclass of ValueError) are
# expected; allow either so tests stay route-agnostic.
_PARSER_EXC = (ValueError, json.JSONDecodeError)


def _ijson_route():
    """True when stream_json_records currently routes '[' files through ijson
    (installed and not forced to stdlib)."""
    if os.environ.get("SAMQL_JSON_READER", "").lower() == "stdlib":
        return False
    try:
        import ijson  # noqa: F401
        return True
    except Exception:
        return False


# Parser-origin message fragments, per route and malformation kind. Under ijson
# the inline byte validator in _CountingReader rejects every raw illegal control;
# under the strict stdlib parser the rejection surfaces as one of its own
# truncated/garbage errors. An unrelated ValueError (loader, database, ...)
# matches neither, so it fails the test.
_CTL_FRAG_STDLIB = {
    "tail": "non-whitespace garbage",
    "sep": "truncated JSON array",
    "instr": "truncated JSON array",
}


def _ctl_frag(kind):
    return "illegal control character" if _ijson_route() else _CTL_FRAG_STDLIB[kind]


def _expect_error(path, label, exc_types=None, msg_fragment=None):
    """stream_json_records must raise on *path*; return None (pass) or a failure string.

    exc_types   - tuple of expected exception classes; a completely unrelated
                  exception class (e.g. RuntimeError, ImportError) is itself a
                  test failure rather than an accidental pass.
    msg_fragment - substring that must appear in the exception message.
    """
    try:
        list(stream_json_records(path))
        return "SILENT SUCCESS (expected error) for: %s" % label
    except Exception as e:
        if exc_types is not None and not isinstance(e, exc_types):
            return ("WRONG EXCEPTION TYPE for %s: got %s (%s), expected one of %s"
                    % (label, type(e).__name__, e,
                       ", ".join(t.__name__ for t in exc_types)))
        if msg_fragment is not None and msg_fragment not in str(e):
            return ("WRONG EXCEPTION MSG for %s: %r not in %r"
                    % (label, msg_fragment, str(e)))
        return None  # raised the expected kind of error


def _exact_eq(got, want, path="$"):
    """Strict ordered deep equality. Returns None if equal, else a string
    locating the first difference. Dict key SETS must match (extra keys fail),
    lists must match in length and order, scalar TYPES must match (so True is
    not 1 and 1 is not 1.0), and NaN equals NaN (the only intended leniency)."""
    if isinstance(want, dict):
        if not isinstance(got, dict):
            return "%s: got %s, want dict" % (path, type(got).__name__)
        if set(got) != set(want):
            return ("%s: key set differs: unexpected=%r missing=%r"
                    % (path, sorted(set(got) - set(want), key=str),
                       sorted(set(want) - set(got), key=str)))
        if list(got) != list(want):
            return "%s: key order differs: %r vs %r" % (path, list(got), list(want))
        for k in want:
            d = _exact_eq(got[k], want[k], "%s[%r]" % (path, k))
            if d:
                return d
        return None
    if isinstance(want, list):
        if not isinstance(got, list):
            return "%s: got %s, want list" % (path, type(got).__name__)
        if len(got) != len(want):
            return "%s: length %d, want %d" % (path, len(got), len(want))
        for i, (g, w) in enumerate(zip(got, want)):
            d = _exact_eq(g, w, "%s[%d]" % (path, i))
            if d:
                return d
        return None
    if type(got) is not type(want):
        return "%s: type %s (%r), want %s (%r)" % (
            path, type(got).__name__, got, type(want).__name__, want)
    if isinstance(want, float) and math.isnan(want):
        return None if math.isnan(got) else "%s: got %r, want NaN" % (path, got)
    if got != want:
        return "%s: got %r, want %r" % (path, got, want)
    return None


def _expect_ok(path, label, expected_count=None, expected_records=None):
    """stream_json_records must succeed; optionally assert the count and/or
    EXACT ordered equality of the whole record list (see _exact_eq)."""
    try:
        recs = list(stream_json_records(path))
    except Exception as e:
        return "UNEXPECTED ERROR for %s: %s" % (label, e)
    if expected_count is not None and len(recs) != expected_count:
        return "WRONG COUNT for %s: got %d, want %d" % (label, len(recs), expected_count)
    if expected_records is not None:
        diff = _exact_eq(recs, expected_records)
        if diff:
            return "NOT EXACT for %s: %s" % (label, diff)
    return None


# ---------------------------------------------------------------------------
# Helpers for Session.load_file tests
# ---------------------------------------------------------------------------

def _session_load_file_test(label, dd, prior_content, bad_content,
                             dest_name, exc_types, msg_fragment,
                             passes_list, failures_list):
    """Create a session with an existing populated table, attempt to load
    malformed/bad_content over it, assert parser-origin rejection, and verify
    the existing rows and catalog are exactly unchanged.

    Returns True if the test passed.
    """
    try:
        from samql_core import Session
    except Exception as e:
        failures_list.append("  FAIL: %s — Session import failed: %s" % (label, e))
        return False

    s = Session()
    s.fresh_run = False
    s.fresh_load = False
    try:
        # 1. Load prior (valid) content to create the destination table.
        prior_path = _write("prior_%s.json" % dest_name, prior_content, dd)
        s.load_file(prior_path, destination="sqlite", base_name=dest_name)

        # 2. Snapshot state: rows in existing table, full catalog.
        before_rows = s.run_query(
            "SELECT * FROM %s ORDER BY id" % dest_name, target="__local__"
        )["rows"]
        before_catalog = sorted(t["name"] for t in s.tables_tree())

        # 3. Attempt the malformed load.
        bad_path = _write("bad_%s.json" % dest_name, bad_content, dd)
        raised_exc = None
        try:
            s.load_file(bad_path, destination="sqlite", base_name=dest_name)
        except Exception as e:
            raised_exc = e

        # 4. Verify it raised.
        if raised_exc is None:
            failures_list.append(
                "  FAIL: %s — load_file returned success, should have raised" % label)
            return False

        # 5. Verify exception type is a parser exception, not e.g. AttributeError.
        if exc_types is not None and not isinstance(raised_exc, exc_types):
            failures_list.append(
                "  FAIL: %s — wrong exception type: got %s (%s), want one of %s"
                % (label, type(raised_exc).__name__, raised_exc,
                   ", ".join(t.__name__ for t in exc_types)))
            return False

        # 6. Verify exception message if requested.
        if msg_fragment is not None and msg_fragment not in str(raised_exc):
            failures_list.append(
                "  FAIL: %s — wrong exception message: %r not in %r"
                % (label, msg_fragment, str(raised_exc)))
            return False

        # 7. Verify rows unchanged.
        after_rows = s.run_query(
            "SELECT * FROM %s ORDER BY id" % dest_name, target="__local__"
        )["rows"]
        if after_rows != before_rows:
            failures_list.append(
                "  FAIL: %s — existing rows changed: before=%r after=%r"
                % (label, before_rows, after_rows))
            return False

        # 8. Verify no new tables appeared (no suffixed partial table).
        after_catalog = sorted(t["name"] for t in s.tables_tree())
        new_tables = [t for t in after_catalog if t not in before_catalog]
        if new_tables:
            failures_list.append(
                "  FAIL: %s — new/partial table(s) appeared after failed load: %r"
                % (label, new_tables))
            return False

        passes_list.append(label)
        return True
    finally:
        try:
            s.shutdown()
        except Exception:
            pass


def run_tests():
    dd = tempfile.mkdtemp(prefix="samql_ji_")
    failures = []
    passes_count = [0]
    passes_labels = []

    def check(label, error_msg):
        if error_msg:
            failures.append("  FAIL: " + error_msg)
            print("  FAIL:", label, "->", error_msg)
        else:
            passes_count[0] += 1
            print("  PASS:", label)

    # -----------------------------------------------------------------------
    # A. MUST FAIL (fail-closed) — malformed / truncated input
    # -----------------------------------------------------------------------
    print("\n=== A. Malformed / truncated (must raise) ===")

    # A1: truncated array after two complete records
    check("A1 truncated array after 2 records",
          _expect_error(_write("a1.json", '[{"id":1},{"id":2},{"id":', dd),
                        "truncated array after 2 records",
                        exc_types=_PARSER_EXC,
                        msg_fragment="truncated"))

    # A2: incomplete final element (only opening brace)
    check("A2 incomplete final element",
          _expect_error(_write("a2.json", '[{"id":1},{"id":2},{', dd),
                        "incomplete final element",
                        exc_types=_PARSER_EXC,
                        msg_fragment="truncated"))

    # A3: valid records followed by undecodable garbage
    check("A3 valid records then garbage",
          _expect_error(_write("a3.json", '[{"id":1},{"id":2}] GARBAGE!!!', dd),
                        "valid records then garbage",
                        exc_types=_PARSER_EXC))

    # A4: unterminated top-level array -- just '[' then EOF
    check("A4 bare '[' EOF",
          _expect_error(_write("a4.json", '[', dd),
                        "bare [ EOF",
                        exc_types=_PARSER_EXC,
                        msg_fragment="truncated"))

    # A5: '[{' then EOF
    check("A5 '[{' EOF",
          _expect_error(_write("a5.json", '[{', dd),
                        "[{ EOF",
                        exc_types=_PARSER_EXC,
                        msg_fragment="truncated"))

    # A6: leading comma in array
    check("A6 leading comma",
          _expect_error(_write("a6.json", '[,{"id":1}]', dd),
                        "leading comma",
                        exc_types=_PARSER_EXC,
                        msg_fragment="leading"))

    # A7: double comma in array
    check("A7 double comma",
          _expect_error(_write("a7.json", '[{"id":1},,{"id":2}]', dd),
                        "double comma",
                        exc_types=_PARSER_EXC,
                        msg_fragment="double comma"))

    # A8: trailing comma in array
    check("A8 trailing comma",
          _expect_error(_write("a8.json", '[{"id":1},{"id":2},]', dd),
                        "trailing comma",
                        exc_types=_PARSER_EXC,
                        msg_fragment="trailing comma"))

    # A9: adjacent elements with no comma
    check("A9 adjacent elements no comma",
          _expect_error(_write("a9.json", '[{"id":1}{"id":2}]', dd),
                        "adjacent elements no comma",
                        exc_types=_PARSER_EXC,
                        msg_fragment="missing"))

    # A10: unterminated array after 0 complete records
    check("A10 unterminated after 0 records",
          _expect_error(_write("a10.json", '[{"id":', dd),
                        "unterminated after 0 records",
                        exc_types=_PARSER_EXC,
                        msg_fragment="truncated"))

    # A11: garbage after a bare concatenated object (NDJSON style)
    check("A11 garbage after NDJSON record",
          _expect_error(_write("a11.jsonl", '{"id":1}\n{"id":2}\nNOT_JSON!!!', dd),
                        "garbage after ndjson records",
                        exc_types=_PARSER_EXC))

    # -----------------------------------------------------------------------
    # B. MUST SUCCEED -- valid inputs pass through unchanged with exact values
    # -----------------------------------------------------------------------
    print("\n=== B. Valid inputs (must succeed, exact records) ===")

    # B1: normal array of objects -- assert exact ordered records
    check("B1 normal array (exact records)",
          _expect_ok(_write("b1.json", '[{"id":1},{"id":2},{"id":3}]', dd),
                     "normal array",
                     expected_records=[{"id": 1}, {"id": 2}, {"id": 3}]))

    # B2: empty array
    check("B2 empty array (exact records)",
          _expect_ok(_write("b2.json", '[]', dd), "empty array",
                     expected_records=[]))

    # B3: empty file
    check("B3 empty file (exact records)",
          _expect_ok(_write("b3.json", '', dd), "empty file",
                     expected_records=[]))

    # B4: valid NDJSON -- assert exact ordered records
    check("B4 NDJSON (exact records)",
          _expect_ok(_write("b4.jsonl", '{"id":1}\n{"id":2}\n', dd), "ndjson",
                     expected_records=[{"id": 1}, {"id": 2}]))

    # B5: concatenated complete objects
    check("B5 concat objects (exact records)",
          _expect_ok(_write("b5.json", '{"id":1}{"id":2}{"id":3}', dd), "concat objects",
                     expected_records=[{"id": 1}, {"id": 2}, {"id": 3}]))

    # B6: concatenated arrays
    check("B6 concat arrays (exact records)",
          _expect_ok(_write("b6.json", '[{"id":1}][{"id":2}]', dd), "concat arrays",
                     expected_records=[{"id": 1}, {"id": 2}]))

    # B7: mixed -- object then array, exact records
    check("B7 mixed obj+array (exact records)",
          _expect_ok(_write("b7.json", '{"id":0}[{"id":1},{"id":2}]', dd), "mixed",
                     expected_records=[{"id": 0}, {"id": 1}, {"id": 2}]))

    # B8: single bare object
    check("B8 bare object (exact records)",
          _expect_ok(_write("b8.json", '{"only":true}', dd), "bare object",
                     expected_records=[{"only": True}]))

    # B9: bare scalar (integer)
    check("B9 bare scalar int (exact records)",
          _expect_ok(_write("b9.json", '42', dd), "bare scalar",
                     expected_records=[42]))

    # B10: NaN / Infinity tolerant literals -- assert exact ordered values
    # including the second record's -Infinity.
    _nan = float("nan")
    _inf = float("inf")
    _ninf = float("-inf")
    check("B10 NaN/Infinity tolerant literals (exact records)",
          _expect_ok(
              _write("b10.json", '[{"a":NaN,"b":Infinity},{"a":-Infinity}]', dd),
              "NaN/Infinity tolerant literals",
              expected_records=[
                  {"a": _nan, "b": _inf},
                  {"a": _ninf},
              ]))

    # B11: array with single element
    check("B11 single-element array (exact records)",
          _expect_ok(_write("b11.json", '[{"x":99}]', dd), "single element array",
                     expected_records=[{"x": 99}]))

    # B12: nested values compared exactly (key set, order, list contents, types)
    check("B12 nested values (exact records)",
          _expect_ok(_write("b12.json",
                            '[{"a":{"b":[1,2.5,null,true,"s"],"c":{}},"d":[]},{"e":-0.5}]', dd),
                     "nested values",
                     expected_records=[
                         {"a": {"b": [1, 2.5, None, True, "s"], "c": {}}, "d": []},
                         {"e": -0.5}]))

    # B13: the exact-equality helper itself must reject extras / type drift
    # (guards against the comparator silently going lenient again).
    _neg = [
        ("extra key", [{"id": 1, "x": 2}], [{"id": 1}]),
        ("missing key", [{"id": 1}], [{"id": 1, "x": 2}]),
        ("nested extra key", [{"a": {"b": 1, "z": 0}}], [{"a": {"b": 1}}]),
        ("nested list item", [{"a": [1, 2]}], [{"a": [1, 3]}]),
        ("bool vs int", [{"a": True}], [{"a": 1}]),
        ("int vs float", [{"a": 1.0}], [{"a": 1}]),
        ("order", [{"id": 2}, {"id": 1}], [{"id": 1}, {"id": 2}]),
        ("length", [{"id": 1}], [{"id": 1}, {"id": 2}]),
    ]
    _bad = [n for n, g, w in _neg if _exact_eq(g, w) is None]
    check("B13 comparator rejects extra keys/type drift/order",
          ("comparator accepted: %s" % ", ".join(_bad)) if _bad else None)
    check("B13b comparator treats NaN as equal",
          _exact_eq([{"a": float("nan")}], [{"a": float("nan")}]))

    # -----------------------------------------------------------------------
    # C. PUBLIC PATH: Session.load_file must not leave partial tables
    # -----------------------------------------------------------------------
    print("\n=== C. Session.load_file public path ===")

    try:
        from samql_core import Session

        def _fresh():
            s = Session()
            s.fresh_run = False
            s.fresh_load = False
            return s

        # C1: truncated array must raise and leave no table
        s1 = _fresh()
        try:
            p = _write("c1.json", '[{"id":1},{"id":2},{"id":', dd)
            try:
                s1.load_file(p, destination="sqlite", base_name="c1_table")
                failures.append("  FAIL: C1 truncated load returned success, should raise")
                print("  FAIL: C1 truncated load returned success (should raise)")
            except _PARSER_EXC as e:
                names = [t["name"] for t in s1.tables_tree()]
                if "truncated JSON array" not in str(e):
                    failures.append("  FAIL: C1 wrong provenance: %s" % e)
                    print("  FAIL: C1 wrong provenance:", e)
                elif "c1_table" in names:
                    failures.append("  FAIL: C1 partial table 'c1_table' was created after error")
                    print("  FAIL: C1 partial table 'c1_table' exists after error")
                else:
                    passes_count[0] += 1
                    print("  PASS: C1 truncated load raised (parser exc) and left no table")
            except Exception as e:
                failures.append("  FAIL: C1 wrong exception type: %s (%s)"
                                 % (type(e).__name__, e))
                print("  FAIL: C1 wrong exception:", type(e).__name__, e)
        finally:
            try:
                s1.shutdown()
            except Exception:
                pass

        # C2: garbage-after-valid must raise and leave no table
        s2 = _fresh()
        try:
            p2 = _write("c2.json", '[{"id":1},{"id":2}] GARBAGE', dd)
            try:
                s2.load_file(p2, destination="sqlite", base_name="c2_table")
                failures.append("  FAIL: C2 garbage-after load returned success")
                print("  FAIL: C2 garbage-after load returned success")
            except _PARSER_EXC as e:
                names = [t["name"] for t in s2.tables_tree()]
                if "non-whitespace garbage" not in str(e):
                    failures.append("  FAIL: C2 wrong provenance: %s" % e)
                    print("  FAIL: C2 wrong provenance:", e)
                elif "c2_table" in names:
                    failures.append("  FAIL: C2 partial table 'c2_table' was created after error")
                    print("  FAIL: C2 partial table 'c2_table' exists after error")
                else:
                    passes_count[0] += 1
                    print("  PASS: C2 garbage-after load raised (parser exc) and left no table")
            except Exception as e:
                failures.append("  FAIL: C2 wrong exception type: %s (%s)"
                                 % (type(e).__name__, e))
                print("  FAIL: C2 wrong exception:", type(e).__name__, e)
        finally:
            try:
                s2.shutdown()
            except Exception:
                pass

        # C3: valid load still works through the same public path
        s3 = _fresh()
        try:
            p3 = _write("c3.json", '[{"id":1},{"id":2},{"id":3}]', dd)
            s3.load_file(p3, destination="sqlite", base_name="c3_table")
            names = [t["name"] for t in s3.tables_tree()]
            if "c3_table" not in names:
                failures.append("  FAIL: C3 valid load: 'c3_table' not found in %r" % names)
                print("  FAIL: C3 valid load did not create table")
            else:
                r = s3.run_query("SELECT * FROM c3_table ORDER BY id", target="__local__")
                if r["columns"] != ["_id", "id"] or r["rows"] != [[1, 1], [2, 2], [3, 3]]:
                    failures.append("  FAIL: C3 valid load: columns=%r rows=%r"
                                    % (r["columns"], r["rows"]))
                    print("  FAIL: C3 valid load: wrong columns/rows", r["columns"], r["rows"])
                else:
                    passes_count[0] += 1
                    print("  PASS: C3 valid JSON load through public path (exact columns/rows)")
        finally:
            try:
                s3.shutdown()
            except Exception:
                pass

        # C4: leading comma must raise and leave no table
        s4 = _fresh()
        try:
            p4 = _write("c4.json", '[,{"id":1}]', dd)
            try:
                s4.load_file(p4, destination="sqlite", base_name="c4_table")
                failures.append("  FAIL: C4 leading-comma load returned success")
                print("  FAIL: C4 leading-comma load returned success")
            except _PARSER_EXC as e:
                names = [t["name"] for t in s4.tables_tree()]
                if "leading or double comma" not in str(e):
                    failures.append("  FAIL: C4 wrong provenance: %s" % e)
                    print("  FAIL: C4 wrong provenance:", e)
                elif "c4_table" in names:
                    failures.append("  FAIL: C4 partial table 'c4_table' created after error")
                    print("  FAIL: C4 partial table 'c4_table' exists after error")
                else:
                    passes_count[0] += 1
                    print("  PASS: C4 leading-comma load raised (parser exc) and left no table")
            except Exception as e:
                failures.append("  FAIL: C4 wrong exception type: %s (%s)"
                                 % (type(e).__name__, e))
                print("  FAIL: C4 wrong exception:", type(e).__name__, e)
        finally:
            try:
                s4.shutdown()
            except Exception:
                pass

        # C5: NUL-tail malformed input must raise, existing table preserved,
        #     no new/suffixed table created.
        ok = _session_load_file_test(
            "C5 NUL-tail: existing table preserved, no partial table",
            dd,
            prior_content='[{"id":1}]',
            bad_content='[{"id":2}]\x00',
            dest_name="c5_table",
            exc_types=_PARSER_EXC,
            msg_fragment=_ctl_frag("tail"),
            passes_list=passes_labels,
            failures_list=failures,
        )
        if ok:
            passes_count[0] += 1
            print("  PASS: C5 NUL-tail: existing table preserved, no partial table")
        else:
            print("  FAIL: C5 NUL-tail:", failures[-1])

        # C6: VT-separator malformed input must raise, existing table preserved.
        ok = _session_load_file_test(
            "C6 VT-separator: existing table preserved, no partial table",
            dd,
            prior_content='[{"id":1}]',
            bad_content='[{"id":2},\x0b{"id":3}]',
            dest_name="c6_table",
            exc_types=_PARSER_EXC,
            msg_fragment=_ctl_frag("sep"),
            passes_list=passes_labels,
            failures_list=failures,
        )
        if ok:
            passes_count[0] += 1
            print("  PASS: C6 VT-separator: existing table preserved, no partial table")
        else:
            print("  FAIL: C6 VT-separator:", failures[-1])

        # C7: FF-tail malformed input must raise, existing table preserved.
        ok = _session_load_file_test(
            "C7 FF-tail: existing table preserved, no partial table",
            dd,
            prior_content='[{"id":1}]',
            bad_content='[{"id":2}]\x0c',
            dest_name="c7_table",
            exc_types=_PARSER_EXC,
            msg_fragment=_ctl_frag("tail"),
            passes_list=passes_labels,
            failures_list=failures,
        )
        if ok:
            passes_count[0] += 1
            print("  PASS: C7 FF-tail: existing table preserved, no partial table")
        else:
            print("  FAIL: C7 FF-tail:", failures[-1])

        # C8: NUL-separator in array must raise and leave no table (new load).
        s8 = _fresh()
        try:
            p8 = _write("c8.json", '[{"id":1},\x00{"id":2}]', dd)
            try:
                s8.load_file(p8, destination="sqlite", base_name="c8_table")
                failures.append("  FAIL: C8 NUL-separator load returned success")
                print("  FAIL: C8 NUL-separator load returned success")
            except _PARSER_EXC as e:
                names = [t["name"] for t in s8.tables_tree()]
                if _ctl_frag("sep") not in str(e):
                    failures.append("  FAIL: C8 wrong provenance: %s" % e)
                    print("  FAIL: C8 wrong provenance:", e)
                elif "c8_table" in names:
                    failures.append(
                        "  FAIL: C8 partial table 'c8_table' created after NUL-sep error")
                    print("  FAIL: C8 partial table 'c8_table' exists after error")
                else:
                    passes_count[0] += 1
                    print("  PASS: C8 NUL-separator raised (parser exc) and left no table")
            except Exception as e:
                failures.append("  FAIL: C8 wrong exception type: %s (%s)"
                                 % (type(e).__name__, e))
                print("  FAIL: C8 wrong exception:", type(e).__name__, e)
        finally:
            try:
                s8.shutdown()
            except Exception:
                pass

    except Exception as e:
        failures.append("  FAIL: Session import/setup error: %s" % e)
        print("  FAIL: Session import/setup error:", e)

    # -----------------------------------------------------------------------
    # D. CONTROL CHARACTER REJECTION
    # JSON whitespace is ONLY: space (U+0020), tab (U+0009), LF (U+000A), CR (U+000D).
    # NUL (U+0000), VT (U+000B), FF (U+000C) are not legal JSON whitespace and
    # must be rejected, not silently consumed.
    #
    # These tests exercise BOTH forced-stdlib routing AND normal installed-ijson
    # routing.  On the ijson route the inline byte validator in _CountingReader
    # rejects the control byte; on the stdlib route the strict parser does.
    # -----------------------------------------------------------------------
    print("\n=== D. Control-character rejection (stdlib + ijson routes) ===")

    _CTL_CASES = [
        # (name, content, short_label)
        ("d_nul_tail",      '[1]\x00',           "NUL after value (tail)"),
        ("d_vt_tail",       '[1]\x0b',           "VT after value (tail)"),
        ("d_ff_tail",       '[1]\x0c',           "FF after value (tail)"),
        ("d_nul_sep",       '[1,\x002]',         "NUL between array elements"),
        ("d_vt_sep",        '[1,\x0b2]',         "VT between array elements"),
    ]

    import os as _os

    _orig_reader = _os.environ.get("SAMQL_JSON_READER")

    def _restore_reader():
        if _orig_reader is None:
            _os.environ.pop("SAMQL_JSON_READER", None)
        else:
            _os.environ["SAMQL_JSON_READER"] = _orig_reader

    for reader in ("stdlib", "ijson"):
        if reader == "stdlib":
            _os.environ["SAMQL_JSON_READER"] = "stdlib"
            route_label = "(forced stdlib)"
        else:
            _os.environ.pop("SAMQL_JSON_READER", None)
            route_label = "(normal/ijson)"

        for fname, content, desc in _CTL_CASES:
            label = "D %s %s %s" % (reader, desc, route_label)
            check(label,
                  _expect_error(_write(fname + "_" + reader + ".json", content, dd),
                                 label,
                                 exc_types=_PARSER_EXC))

    _restore_reader()

    # -----------------------------------------------------------------------
    # E. DEEP CONTROL CHARACTERS (>= 70 KB into the file)
    # A raw illegal control byte anywhere in the stream must be rejected, not
    # just in the first 64 KB. Exercised through BOTH routes, directly and via
    # the public Session.load_file path. A valid >70 KB Unicode / escaped-control
    # fixture proves the validator does not reject ordinary UTF-8, legal
    # whitespace (tab/LF/CR) or JSON-escaped controls.
    # -----------------------------------------------------------------------
    print("\n=== E. Deep control characters (>=70 KB) ===")

    _DEEP = 70 * 1024
    _PAD = "x" * 1024

    def _deep_array(n, bad_at, bad_text, start_id=1, tail=""):
        """Array of n ~1 KB records; ``bad_text`` is inserted raw as a separator
        before record index ``bad_at`` (so the offending byte lies > _DEEP bytes in).
        Returns (text, offset_of_bad_text)."""
        parts = []
        off = 1                                   # leading '['
        bad_off = None
        for i in range(n):
            rec = json.dumps({"id": start_id + i, "pad": _PAD})
            if i == bad_at:
                bad_off = off
                parts.append(bad_text)
                off += len(bad_text)
            parts.append(rec)
            off += len(rec)
            if i != n - 1:
                parts.append(",")
                off += 1
        return "[" + "".join(parts) + "]" + tail, bad_off

    def _deep_string(n, bad_at, ch, start_id=1):
        """Like _deep_array but ``ch`` sits raw INSIDE a quoted string value."""
        recs = []
        bad_off = None
        off = 1
        for i in range(n):
            rec = json.dumps({"id": start_id + i, "pad": _PAD})
            if i == bad_at:
                # json.dumps would escape the control, so splice it in raw.
                cut = rec.index(_PAD) + 100
                rec = rec[:cut] + ch + rec[cut:]
                bad_off = off + cut
            recs.append(rec)
            off += len(rec) + 1
        return "[" + ",".join(recs) + "]", bad_off

    _N = 100                                    # ~104 KB per fixture
    _AT = 80                                    # ~83 KB into the file
    _deep_cases = []
    for nm, ch in (("NUL", "\x00"), ("VT", "\x0b"), ("FF", "\x0c"),
                   ("SOH", "\x01"), ("US", "\x1f")):
        txt, off = _deep_array(_N, _AT, ch)
        _deep_cases.append(("deep_%s_sep" % nm.lower(), txt, off,
                            "%s between elements @%d" % (nm, off)))
    for nm, ch in (("NUL", "\x00"), ("VT", "\x0b"), ("FF", "\x0c")):
        txt, _ = _deep_array(_N, -1, "", tail=ch)
        off = len(txt) - 1
        _deep_cases.append(("deep_%s_tail" % nm.lower(), txt, off,
                            "%s tail after array @%d" % (nm, off)))
    for nm, ch in (("NUL", "\x00"), ("VT", "\x0b"), ("FF", "\x0c"),
                   ("SOH", "\x01")):
        txt, off = _deep_string(_N, _AT, ch)
        _deep_cases.append(("deep_%s_instr" % nm.lower(), txt, off,
                            "raw %s inside string @%d" % (nm, off)))
    for fname, txt, off, desc in _deep_cases:
        assert off >= _DEEP, (fname, off)       # fixture really is past 70 KB

    for reader in ("stdlib", "ijson"):
        if reader == "stdlib":
            _os.environ["SAMQL_JSON_READER"] = "stdlib"
            route_label = "(forced stdlib)"
        else:
            _os.environ.pop("SAMQL_JSON_READER", None)
            route_label = "(normal/ijson)"
        # Route-appropriate parser provenance: the ijson route's rejection must
        # come from the inline byte validator, the stdlib route's from the strict
        # stdlib parser -- never from an incidental downstream failure.
        for fname, txt, off, desc in _deep_cases:
            label = "E %s %s %s" % (reader, desc, route_label)
            frag = _ctl_frag(fname.rsplit("_", 1)[1])
            check(label,
                  _expect_error(_write("e_%s_%s.json" % (fname, reader), txt, dd),
                                 label, exc_types=_PARSER_EXC, msg_fragment=frag))

        # Public path: existing destination table + catalog must be untouched.
        for fname, txt, off, desc in (_deep_cases[0], _deep_cases[2],
                                      _deep_cases[5], _deep_cases[8]):
            label = "E %s Session.load_file %s %s" % (reader, desc, route_label)
            dest = "e_%s_%s" % (fname, reader)
            frag = _ctl_frag(fname.rsplit("_", 1)[1])
            ok = _session_load_file_test(
                label, dd,
                prior_content='[{"id":1,"pad":"keep"}]',
                bad_content=txt,
                dest_name=dest,
                exc_types=_PARSER_EXC,
                msg_fragment=frag,
                passes_list=passes_labels,
                failures_list=failures,
            )
            if ok:
                passes_count[0] += 1
                print("  PASS:", label)
            else:
                print("  FAIL:", label, "->", failures[-1])

        # Valid >70 KB Unicode + legal whitespace + escaped controls.
        uni = "caf\u00e9 \u4e2d\u6587 \U0001F600 \u0416"
        recs = [{"id": i, "u": uni * 20, "esc": "a\x00b\x0bc\x0cd\x01e\tf\ng\rh"}
                for i in range(200)]
        seps = [",", ",\t", ",\n", ",\r\n", " , "]
        body = "".join(
            json.dumps(r, ensure_ascii=(i % 2 == 0)) + (seps[i % 5] if i != 199 else "")
            for i, r in enumerate(recs))
        txt = "[\t\n" + body + "\r\n ]\n"
        pv = os.path.join(dd, "e_valid_%s.json" % reader)
        with open(pv, "w", encoding="utf-8", newline="") as f:
            f.write(txt)
        assert os.path.getsize(pv) > _DEEP
        label = "E %s valid >70KB unicode/escaped controls %s" % (reader, route_label)
        check(label, _expect_ok(pv, label, expected_records=recs))

    _restore_reader()

    # Reader-level: _CountingReader validates every chunk it returns and keeps
    # its byte count / cancel polling.
    import io
    from samql_core import flatten as _F

    good = (b'[' + b",".join(b'{"i":%d,"p":"%s"}' % (i, b"y" * 100)
                              for i in range(1500)) + b']')
    assert len(good) > _DEEP
    cr = _F._CountingReader(io.BytesIO(good), None, None, lambda: False)
    got = b""
    while True:
        c = cr.read(4096)
        if not c:
            break
        got += c
    check("E CountingReader passes valid stream unchanged, counts bytes",
          None if (got == good and cr._count == len(good))
          else "valid stream altered or miscounted (%d vs %d)" % (cr._count, len(good)))

    for ctl in (b"\x00", b"\x08", b"\x0b", b"\x0c", b"\x0e", b"\x1f"):
        for size in (4096, 65536, -1):
            at = 90000                           # straddles / lies past chunk 1
            data = good[:at] + ctl + good[at:]
            cr = _F._CountingReader(io.BytesIO(data), None, None, lambda: False)
            err = None
            try:
                while cr.read(size):
                    pass
                err = "no error for %r @%d read(%d)" % (ctl, at, size)
            except ValueError as e:
                if "illegal control" not in str(e) or str(at) not in str(e):
                    err = "bad message (want offset %d): %s" % (at, e)
            except Exception as e:
                err = "wrong exception %s: %s" % (type(e).__name__, e)
            check("E CountingReader rejects %r @%d read(%d)" % (ctl, at, size), err)

    cr = _F._CountingReader(io.BytesIO(good), None, None, lambda: True)
    try:
        cr.read(10)
        check("E CountingReader still polls cancel", "cancel not honoured")
    except InterruptedError:
        check("E CountingReader still polls cancel", None)


    # -----------------------------------------------------------------------
    # F. LEGAL-WHITESPACE PREFIX FOLLOWED ONLY BY AN ILLEGAL CONTROL
    # The first-character probe must strip EXACT JSON whitespace (space, tab,
    # LF, CR) only. Python's str.lstrip() also strips VT, FF and U+001C-U+001F
    # (and Unicode spaces), which classified such a file as EMPTY and returned
    # success before any parser or validator ran. The offending byte must be
    # surfaced as the first non-whitespace character and then rejected.
    # Genuinely empty / legal-whitespace-only files must stay successful.
    # -----------------------------------------------------------------------
    print("\n=== F. Whitespace prefix + lone illegal control (never 'empty') ===")

    _WS72 = " " * (72 * 1024)
    _WSMIX = (" \t\r\n" * (18 * 1024))[:72 * 1024]
    assert len(_WS72) > _DEEP and len(_WSMIX) > _DEEP
    _lead_cases = []
    for byte in (0x00, 0x01, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x1f):
        _lead_cases.append(("ws72_%02x" % byte, _WS72 + chr(byte),
                            "72KiB spaces + 0x%02x" % byte))
    for byte in (0x0b, 0x1f):
        _lead_cases.append(("wsmix_%02x" % byte, _WSMIX + chr(byte),
                            "72KiB mixed tab/LF/CR/space + 0x%02x" % byte))
    _lead_cases.append(("ws72_nbsp", _WS72 + "\u00a0", "72KiB spaces + U+00A0"))
    _lead_cases.append(("ws72_nel", _WS72 + "\u0085", "72KiB spaces + U+0085"))

    # Both routes classify these identically (first char is not '['), so the
    # decisive rejection is the stdlib parser's own "Expecting value" error.
    _LEAD_EXC = (json.JSONDecodeError,)
    _LEAD_FRAG = "Expecting value"

    for reader in ("stdlib", "ijson"):
        if reader == "stdlib":
            _os.environ["SAMQL_JSON_READER"] = "stdlib"
            route_label = "(forced stdlib)"
        else:
            _os.environ.pop("SAMQL_JSON_READER", None)
            route_label = "(normal/ijson)"

        for fname, txt, desc in _lead_cases:
            label = "F %s %s %s" % (reader, desc, route_label)
            check(label,
                  _expect_error(_write("f_%s_%s.json" % (fname, reader), txt, dd),
                                 label, exc_types=_LEAD_EXC,
                                 msg_fragment=_LEAD_FRAG))

        # Public path: existing destination preserved, parser-origin error,
        # exact rows/catalog, no new or suffixed table.
        for fname, txt, desc in (_lead_cases[2], _lead_cases[3], _lead_cases[5],
                                 _lead_cases[7], _lead_cases[9], _lead_cases[10]):
            label = "F %s Session.load_file %s %s" % (reader, desc, route_label)
            ok = _session_load_file_test(
                label, dd,
                prior_content='[{"id":1,"pad":"keep"}]',
                bad_content=txt,
                dest_name="f_%s_%s" % (fname, reader),
                exc_types=_LEAD_EXC,
                msg_fragment=_LEAD_FRAG,
                passes_list=passes_labels,
                failures_list=failures,
            )
            if ok:
                passes_count[0] += 1
                print("  PASS:", label)
            else:
                print("  FAIL:", label, "->", failures[-1])

        # Genuinely empty / legal-whitespace-only input stays a successful empty
        # load (stream level and public level).
        for fname, txt, desc in (("empty", "", "empty file"),
                                 ("ws72", _WS72, "72KiB spaces only"),
                                 ("wsmix", _WSMIX, "72KiB mixed legal whitespace only"),
                                 ("crlf", "\r\n\t \n", "short CR/LF/tab/space only")):
            pe = os.path.join(dd, "f_ok_%s_%s.json" % (fname, reader))
            with open(pe, "w", encoding="utf-8", newline="") as f:
                f.write(txt)
            label = "F %s %s -> successful empty %s" % (reader, desc, route_label)
            check(label, _expect_ok(pe, label, expected_records=[]))

            try:
                from samql_core import Session
                se = Session()
                se.fresh_run = False
                se.fresh_load = False
                try:
                    before = sorted(t["name"] for t in se.tables_tree())
                    se.load_file(pe, destination="sqlite",
                                 base_name="f_ok_%s_%s" % (fname, reader))
                    after = sorted(t["name"] for t in se.tables_tree())
                    check("F %s Session.load_file %s -> success, no table %s"
                          % (reader, desc, route_label),
                          None if after == before
                          else "empty load created table(s): %r" % (
                              [t for t in after if t not in before],))
                finally:
                    try:
                        se.shutdown()
                    except Exception:
                        pass
            except Exception as e:
                check("F %s Session.load_file %s -> success %s"
                      % (reader, desc, route_label),
                      "empty load raised %s: %s" % (type(e).__name__, e))

    _restore_reader()

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    total = passes_count[0] + len(failures)
    print()
    print("=" * 60)
    print("Results: %d passed, %d failed (of %d total)"
          % (passes_count[0], len(failures), total))
    if failures:
        print("Failures:")
        for f in failures:
            print(f)
        print("=" * 60)
        return 1
    print("All tests passed.")
    print("=" * 60)
    return 0


# ---------------------------------------------------------------------------
# Registration for run_tests.py SAMQL_ONLY filter
# ---------------------------------------------------------------------------
def backend_cases(root, csv, skip):
    """Register cases in the main backend suite."""

    def _json_integrity_suite():
        rc = run_tests()
        if rc != 0:
            raise AssertionError("json integrity suite had failures")

    return [
        ("json integrity: fail-closed on truncated/malformed/control-char streams",
         _json_integrity_suite),
    ]


if __name__ == "__main__":
    sys.exit(run_tests())
