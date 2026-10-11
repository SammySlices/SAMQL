"""
tests/test_json_integrity.py
Focused RED→GREEN suite for the JSON parse-completeness / fail-closed fix.
Issue: _iter_stream_records silently succeeds on truncated / malformed input.

Run focused:
  SAMQL_ONLY="json integrity" SAMQL_GROUP=backend \
      PYTHONDONTWRITEBYTECODE=1 /root/workspace/SAMQL/.samql-test-venv/bin/python \
      tests/run_tests.py --backend-only

Or standalone:
  PYTHONDONTWRITEBYTECODE=1 /root/workspace/SAMQL/.samql-test-venv/bin/python \
      tests/test_json_integrity.py
"""
import json
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


def _expect_error(path, label):
    """stream_json_records must raise on `path`; return 'OK' or failure msg."""
    try:
        list(stream_json_records(path))
        return "SILENT SUCCESS (expected error) for: %s" % label
    except (ValueError, json.JSONDecodeError, Exception) as e:
        # Any exception (not just JSONDecodeError) is acceptable — the contract
        # is fail-closed, not a specific exception type.
        return None  # good


def _expect_ok(path, label, expected_count=None):
    """stream_json_records must succeed; optionally assert row count."""
    try:
        recs = list(stream_json_records(path))
    except Exception as e:
        return "UNEXPECTED ERROR for %s: %s" % (label, e)
    if expected_count is not None and len(recs) != expected_count:
        return "WRONG COUNT for %s: got %d, want %d" % (label, len(recs), expected_count)
    return None


def run_tests():
    dd = tempfile.mkdtemp(prefix="samql_ji_")
    failures = []
    passes = 0

    def check(label, error_msg):
        nonlocal passes
        if error_msg:
            failures.append("  FAIL: " + error_msg)
            print("  FAIL:", label, "->", error_msg)
        else:
            passes += 1
            print("  PASS:", label)

    # -----------------------------------------------------------------------
    # A. MUST FAIL (fail-closed) — malformed / truncated input
    # -----------------------------------------------------------------------
    print("\n=== A. Malformed / truncated (must raise) ===")

    # A1: truncated array after two complete records
    check("A1 truncated array after 2 records",
          _expect_error(_write("a1.json", '[{"id":1},{"id":2},{"id":', dd),
                        "truncated array after 2 records"))

    # A2: incomplete final element (only opening brace)
    check("A2 incomplete final element",
          _expect_error(_write("a2.json", '[{"id":1},{"id":2},{', dd),
                        "incomplete final element"))

    # A3: valid records followed by undecodable garbage
    check("A3 valid records then garbage",
          _expect_error(_write("a3.json", '[{"id":1},{"id":2}] GARBAGE!!!', dd),
                        "valid records then garbage"))

    # A4: unterminated top-level array — just '[' then EOF
    check("A4 bare '[' EOF",
          _expect_error(_write("a4.json", '[', dd),
                        "bare [ EOF"))

    # A5: '[{' then EOF
    check("A5 '[{' EOF",
          _expect_error(_write("a5.json", '[{', dd),
                        "[{ EOF"))

    # A6: leading comma in array
    check("A6 leading comma",
          _expect_error(_write("a6.json", '[,{"id":1}]', dd),
                        "leading comma"))

    # A7: double comma in array
    check("A7 double comma",
          _expect_error(_write("a7.json", '[{"id":1},,{"id":2}]', dd),
                        "double comma"))

    # A8: trailing comma in array
    check("A8 trailing comma",
          _expect_error(_write("a8.json", '[{"id":1},{"id":2},]', dd),
                        "trailing comma"))

    # A9: adjacent elements with no comma
    check("A9 adjacent elements no comma",
          _expect_error(_write("a9.json", '[{"id":1}{"id":2}]', dd),
                        "adjacent elements no comma"))

    # A10: unterminated array after 0 complete records
    check("A10 unterminated after 0 records",
          _expect_error(_write("a10.json", '[{"id":', dd),
                        "unterminated after 0 records"))

    # A11: garbage after a bare concatenated object (NDJSON style)
    check("A11 garbage after NDJSON record",
          _expect_error(_write("a11.jsonl", '{"id":1}\n{"id":2}\nNOT_JSON!!!', dd),
                        "garbage after ndjson records"))

    # -----------------------------------------------------------------------
    # B. MUST SUCCEED — valid inputs pass through unchanged
    # -----------------------------------------------------------------------
    print("\n=== B. Valid inputs (must succeed) ===")

    # B1: normal array of objects
    check("B1 normal array",
          _expect_ok(_write("b1.json", '[{"id":1},{"id":2},{"id":3}]', dd),
                     "normal array", 3))

    # B2: empty array
    check("B2 empty array",
          _expect_ok(_write("b2.json", '[]', dd), "empty array", 0))

    # B3: empty file
    check("B3 empty file",
          _expect_ok(_write("b3.json", '', dd), "empty file", 0))

    # B4: valid NDJSON
    check("B4 NDJSON",
          _expect_ok(_write("b4.jsonl", '{"id":1}\n{"id":2}\n', dd), "ndjson", 2))

    # B5: concatenated complete objects (no separating comma needed between values)
    check("B5 concat objects",
          _expect_ok(_write("b5.json", '{"id":1}{"id":2}{"id":3}', dd), "concat objects", 3))

    # B6: concatenated arrays
    check("B6 concat arrays",
          _expect_ok(_write("b6.json", '[{"id":1}][{"id":2}]', dd), "concat arrays", 2))

    # B7: mixed — object then array
    check("B7 mixed obj+array",
          _expect_ok(_write("b7.json", '{"id":0}[{"id":1},{"id":2}]', dd), "mixed", 3))

    # B8: single bare object
    check("B8 bare object",
          _expect_ok(_write("b8.json", '{"only":true}', dd), "bare object", 1))

    # B9: bare scalar (integer)
    check("B9 bare scalar int",
          _expect_ok(_write("b9.json", '42', dd), "bare scalar", 1))

    # B10: NaN / Infinity tolerant literals (existing intentional behavior)
    import math
    try:
        recs = list(stream_json_records(
            _write("b10.json", '[{"a":NaN,"b":Infinity},{"a":-Infinity}]', dd)))
        if len(recs) != 2:
            failures.append("  FAIL: B10 NaN/Infinity count: got %d want 2" % len(recs))
            print("  FAIL: B10 NaN/Infinity count: got %d want 2" % len(recs))
        elif not (math.isnan(recs[0]["a"]) and math.isinf(recs[0]["b"])):
            failures.append("  FAIL: B10 NaN/Infinity values wrong: %r" % recs[0])
            print("  FAIL: B10 NaN/Infinity values wrong")
        else:
            passes += 1
            print("  PASS: B10 NaN/Infinity tolerant literals")
    except Exception as e:
        failures.append("  FAIL: B10 NaN/Infinity raised: %s" % e)
        print("  FAIL: B10 NaN/Infinity raised:", e)

    # B11: array with single element
    check("B11 single-element array",
          _expect_ok(_write("b11.json", '[{"x":99}]', dd), "single element array", 1))

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
            except Exception:
                # Good — raised. Now verify no table was created.
                names = [t["name"] for t in s1.tables_tree()]
                if "c1_table" in names:
                    failures.append("  FAIL: C1 partial table 'c1_table' was created after error")
                    print("  FAIL: C1 partial table 'c1_table' exists after error")
                else:
                    passes += 1
                    print("  PASS: C1 truncated load raised and left no table")
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
            except Exception:
                names = [t["name"] for t in s2.tables_tree()]
                if "c2_table" in names:
                    failures.append("  FAIL: C2 partial table 'c2_table' was created after error")
                    print("  FAIL: C2 partial table 'c2_table' exists after error")
                else:
                    passes += 1
                    print("  PASS: C2 garbage-after load raised and left no table")
        finally:
            try:
                s2.shutdown()
            except Exception:
                pass

        # C3: valid load still works through the same public path
        s3 = _fresh()
        try:
            p3 = _write("c3.json", '[{"id":1},{"id":2},{"id":3}]', dd)
            result = s3.load_file(p3, destination="sqlite", base_name="c3_table")
            names = [t["name"] for t in s3.tables_tree()]
            if "c3_table" not in names:
                failures.append("  FAIL: C3 valid load: 'c3_table' not found in %r" % names)
                print("  FAIL: C3 valid load did not create table")
            else:
                # Verify row count
                r = s3.run_query("SELECT COUNT(*) AS n FROM c3_table", target="__local__")
                n = r["rows"][0][0]
                if n != 3:
                    failures.append("  FAIL: C3 valid load: got %d rows, want 3" % n)
                    print("  FAIL: C3 valid load: wrong row count %d" % n)
                else:
                    passes += 1
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
            except Exception:
                names = [t["name"] for t in s4.tables_tree()]
                if "c4_table" in names:
                    failures.append("  FAIL: C4 partial table 'c4_table' created after error")
                    print("  FAIL: C4 partial table 'c4_table' exists after error")
                else:
                    passes += 1
                    print("  PASS: C4 leading-comma load raised and left no table")
        finally:
            try:
                s4.shutdown()
            except Exception:
                pass

    except Exception as e:
        failures.append("  FAIL: Session import/setup error: %s" % e)
        print("  FAIL: Session import/setup error:", e)

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    total = passes + len(failures)
    print()
    print("=" * 60)
    print("Results: %d passed, %d failed (of %d total)" % (passes, len(failures), total))
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
    import os as _os
    import tempfile as _tf

    # We re-expose each top-level check as a named tuple for the harness.
    # The quickest integration: one wrapper that runs the full standalone suite
    # and fails if it returns non-zero.
    def _json_integrity_suite():
        rc = run_tests()
        if rc != 0:
            raise AssertionError("json integrity suite had failures")

    return [
        ("json integrity: fail-closed on truncated/malformed streams",
         _json_integrity_suite),
    ]


if __name__ == "__main__":
    sys.exit(run_tests())
