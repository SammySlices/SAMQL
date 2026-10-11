"""
tests/test_json_integrity.py
Focused RED->GREEN suite for the JSON parse-completeness / fail-closed fix.

Issues fixed:
- _iter_stream_records silently succeeds on truncated / malformed input.
- _skip_ws() used b[p] <= " " which silently consumed illegal control
  characters (NUL U+0000, VT U+000B, FF U+000C) as if they were legal JSON
  whitespace. Legal JSON whitespace is ONLY: space, tab, LF, CR.

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


def _expect_ok(path, label, expected_count=None, expected_records=None):
    """stream_json_records must succeed; optionally assert count and/or exact ordered values."""
    try:
        recs = list(stream_json_records(path))
    except Exception as e:
        return "UNEXPECTED ERROR for %s: %s" % (label, e)
    if expected_count is not None and len(recs) != expected_count:
        return "WRONG COUNT for %s: got %d, want %d" % (label, len(recs), expected_count)
    if expected_records is not None:
        if len(recs) != len(expected_records):
            return ("WRONG COUNT for %s: got %d records, want %d"
                    % (label, len(recs), len(expected_records)))
        for i, (got, want) in enumerate(zip(recs, expected_records)):
            if isinstance(want, dict) and isinstance(got, dict):
                for k, wv in want.items():
                    gv = got.get(k, _MISSING)
                    if gv is _MISSING:
                        return "MISSING KEY %r in record %d for %s" % (k, i, label)
                    if isinstance(wv, float) and math.isnan(wv):
                        if not (isinstance(gv, float) and math.isnan(gv)):
                            return ("WRONG VALUE record[%d][%r] for %s: got %r want NaN"
                                    % (i, k, label, gv))
                    elif isinstance(wv, float) and math.isinf(wv):
                        if gv != wv:
                            return ("WRONG VALUE record[%d][%r] for %s: got %r want %r"
                                    % (i, k, label, gv, wv))
                    elif gv != wv:
                        return ("WRONG VALUE record[%d][%r] for %s: got %r want %r"
                                % (i, k, label, gv, wv))
            elif isinstance(want, float) and math.isnan(want):
                if not (isinstance(got, float) and math.isnan(got)):
                    return "WRONG VALUE record[%d] for %s: got %r want NaN" % (i, label, got)
            elif got != want:
                return "WRONG VALUE record[%d] for %s: got %r want %r" % (i, label, got, want)
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
    check("B2 empty array",
          _expect_ok(_write("b2.json", '[]', dd), "empty array",
                     expected_count=0))

    # B3: empty file
    check("B3 empty file",
          _expect_ok(_write("b3.json", '', dd), "empty file",
                     expected_count=0))

    # B4: valid NDJSON -- assert exact ordered records
    check("B4 NDJSON (exact records)",
          _expect_ok(_write("b4.jsonl", '{"id":1}\n{"id":2}\n', dd), "ndjson",
                     expected_records=[{"id": 1}, {"id": 2}]))

    # B5: concatenated complete objects
    check("B5 concat objects (exact records)",
          _expect_ok(_write("b5.json", '{"id":1}{"id":2}{"id":3}', dd), "concat objects",
                     expected_records=[{"id": 1}, {"id": 2}, {"id": 3}]))

    # B6: concatenated arrays
    check("B6 concat arrays",
          _expect_ok(_write("b6.json", '[{"id":1}][{"id":2}]', dd), "concat arrays",
                     expected_count=2))

    # B7: mixed -- object then array, exact records
    check("B7 mixed obj+array (exact records)",
          _expect_ok(_write("b7.json", '{"id":0}[{"id":1},{"id":2}]', dd), "mixed",
                     expected_records=[{"id": 0}, {"id": 1}, {"id": 2}]))

    # B8: single bare object
    check("B8 bare object (exact records)",
          _expect_ok(_write("b8.json", '{"only":true}', dd), "bare object",
                     expected_records=[{"only": True}]))

    # B9: bare scalar (integer)
    check("B9 bare scalar int",
          _expect_ok(_write("b9.json", '42', dd), "bare scalar",
                     expected_count=1))

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
    check("B11 single-element array",
          _expect_ok(_write("b11.json", '[{"x":99}]', dd), "single element array",
                     expected_count=1))

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
            except _PARSER_EXC:
                names = [t["name"] for t in s1.tables_tree()]
                if "c1_table" in names:
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
            except _PARSER_EXC:
                names = [t["name"] for t in s2.tables_tree()]
                if "c2_table" in names:
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
                r = s3.run_query("SELECT COUNT(*) AS n FROM c3_table", target="__local__")
                n = r["rows"][0][0]
                if n != 3:
                    failures.append("  FAIL: C3 valid load: got %d rows, want 3" % n)
                    print("  FAIL: C3 valid load: wrong row count %d" % n)
                else:
                    passes_count[0] += 1
                    print("  PASS: C3 valid JSON load through public path")
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
            except _PARSER_EXC:
                names = [t["name"] for t in s4.tables_tree()]
                if "c4_table" in names:
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
            msg_fragment=None,
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
            msg_fragment=None,
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
            msg_fragment=None,
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
            except _PARSER_EXC:
                names = [t["name"] for t in s8.tables_tree()]
                if "c8_table" in names:
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
    # routing.  The ijson path falls back to stdlib on any exception, so the
    # stdlib parser's control-char rejection is the decisive gate for both routes.
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

    # Restore environment
    _os.environ.pop("SAMQL_JSON_READER", None)

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
