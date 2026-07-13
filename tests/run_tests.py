#!/usr/bin/env python3
"""SamQL test runner.

A single command that orchestrates the split backend, HTTP, and frontend suites:

    python tests/run_tests.py
    python tests/run_tests.py --backend-only
    python tests/run_tests.py --frontend-only
    python tests/run_tests.py --no-http
    python tests/run_tests.py --build
    python tests/run_tests.py --online
    python tests/run_tests.py -v
"""
import argparse
import os
import shutil
import sys
import tempfile

from fixtures import make_csv, make_json
import harness
from harness import bold, dim, green, red, section, yellow
from paths import BACKEND, ROOT
from suites.backend import backend_tests
from suites.frontend import frontend_tests
from suites.http_api import http_tests

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

_TEMP_REGISTRY = set()


def _install_temp_canary():
    """Track every temporary path so teardown reclaims failed-test debris."""
    import tempfile as temp_module
    if getattr(temp_module, "_samql_canary", False):
        return
    temp_module._samql_canary = True
    original_mkdtemp = temp_module.mkdtemp
    original_mkstemp = temp_module.mkstemp
    original_named = temp_module.NamedTemporaryFile

    def mkdtemp(*args, **kwargs):
        path = original_mkdtemp(*args, **kwargs)
        _TEMP_REGISTRY.add(path)
        return path

    def mkstemp(*args, **kwargs):
        fd, path = original_mkstemp(*args, **kwargs)
        _TEMP_REGISTRY.add(path)
        return fd, path

    def named(*args, **kwargs):
        handle = original_named(*args, **kwargs)
        try:
            _TEMP_REGISTRY.add(handle.name)
        except Exception:
            pass
        return handle

    temp_module.mkdtemp = mkdtemp
    temp_module.mkstemp = mkstemp
    temp_module.NamedTemporaryFile = named


def _sweep_registered(paths):
    count = freed = 0
    for path in sorted(paths, key=len, reverse=True):
        try:
            if os.path.isdir(path):
                size = 0
                for base, _dirs, names in os.walk(path):
                    for name in names:
                        try:
                            size += os.path.getsize(os.path.join(base, name))
                        except OSError:
                            pass
                shutil.rmtree(path, ignore_errors=True)
                if not os.path.exists(path):
                    count += 1
                    freed += size
            elif os.path.exists(path):
                size = os.path.getsize(path)
                os.unlink(path)
                count += 1
                freed += size
        except Exception:
            continue
    return count, freed


def _print_summary():
    groups = {}
    for group, _name, status, _detail, _seconds in harness.RESULTS:
        totals = groups.setdefault(group, {"PASS": 0, "FAIL": 0, "SKIP": 0})
        totals[status] += 1
    section("Summary")
    total = {"PASS": 0, "FAIL": 0, "SKIP": 0}
    for group in ("backend", "http", "frontend"):
        if group not in groups:
            continue
        values = groups[group]
        for key in total:
            total[key] += values[key]
        print(f"  {group:<9} "
              f"{green(str(values['PASS']) + ' passed')}, "
              f"{red(str(values['FAIL']) + ' failed') if values['FAIL'] else dim('0 failed')}, "
              f"{yellow(str(values['SKIP']) + ' skipped')}")
    failures = [(group, name, detail)
                for group, name, status, detail, _seconds in harness.RESULTS
                if status == "FAIL"]
    if failures:
        print("\n" + red("  Failures:"))
        for group, name, detail in failures:
            lines = (detail or "").splitlines() or [""]
            print(f"    - [{group}] {name}: {lines[0]}")
            for extra in lines[1:40]:
                print("        " + extra)
            if len(lines) > 40:
                print("        ... (%d more lines)" % (len(lines) - 40))
    print()
    print(f"  {bold('TOTAL')}: {green(str(total['PASS']) + ' passed')}, "
          f"{(red if total['FAIL'] else dim)(str(total['FAIL']) + ' failed')}, "
          f"{yellow(str(total['SKIP']) + ' skipped')}")
    print()
    return 1 if total["FAIL"] else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="SamQL test runner")
    parser.add_argument("--backend-only", action="store_true",
                        help="Run the backend + HTTP suites only.")
    parser.add_argument("--frontend-only", action="store_true",
                        help="Run the frontend suite only.")
    parser.add_argument("--no-http", action="store_true",
                        help="Skip the live-server HTTP suite.")
    parser.add_argument("--build", action="store_true",
                        help="Also run the production frontend build.")
    parser.add_argument("--online", action="store_true",
                        help="Also run tests that need network access.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    harness.set_verbose(args.verbose)
    harness.reset_results()
    do_backend = not args.frontend_only
    do_frontend = not args.backend_only
    do_http = do_backend and not args.no_http

    _install_temp_canary()
    print(bold("\nSamQL test runner"))
    print(dim(f"  python {sys.version.split()[0]}  |  root: {ROOT}"))

    datadir = tempfile.mkdtemp(prefix="samql_tests_")
    csv_path = os.path.join(datadir, "data.csv")
    json_path = os.path.join(datadir, "data.json")
    make_csv(csv_path)
    make_json(json_path)

    try:
        if do_backend:
            section("Backend  (in-process Session)")
            backend_tests(datadir, csv_path, json_path)
        if do_http:
            section("HTTP API  (live server, replays UI flows)")
            http_tests(datadir, csv_path, json_path,
                       args.host, args.port, args.online)
        if do_frontend:
            section("Frontend  (UI contract, encoding, structure, build)")
            frontend_tests(args.build)
    finally:
        shutil.rmtree(datadir, ignore_errors=True)
        count, freed = _sweep_registered(_TEMP_REGISTRY)
        stale = 0
        instance_left = None
        try:
            from samql_core import tmputil
            tmputil.cleanup_instance()
            instance = os.path.join(tmputil._ROOT, str(os.getpid()))
            if os.path.isdir(instance):
                instance_left = (instance, tmputil.dir_size(instance))
            stale = tmputil.sweep_stale()
        except Exception:
            pass
        message = ("  temp cleanup: %d leftover path%s reclaimed (%.1f MB)"
                   % (count, "" if count == 1 else "s", freed / 1e6))
        if stale:
            message += ", %d stale run dir%s swept" % (
                stale, "" if stale == 1 else "s")
        print(dim(message))
        if instance_left:
            print(dim("  note: %s survived cleanup (%.1f MB) -- a locked "
                      "file is holding it; the next run will sweep it."
                      % instance_left))

    return _print_summary()


if __name__ == "__main__":
    sys.exit(main())
