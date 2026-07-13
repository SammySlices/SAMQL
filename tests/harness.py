"""Small dependency-free harness used by the split SamQL suites."""
import os
import sys
import time
import traceback
import urllib.request
from pathlib import Path


def _enable_win_vt():
    if os.name != "nt":
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, mode.value | 0x0004)
    except Exception:
        pass


def _ensure_utf8_stdio():
    """Keep Vitest/Unicode diagnostics printable on Windows cp1252 consoles."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_enable_win_vt()
_ensure_utf8_stdio()
USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code, value):
    return f"\033[{code}m{value}\033[0m" if USE_COLOR else value


def green(value): return _c("32", value)
def red(value): return _c("31;1", value)
def yellow(value): return _c("33", value)
def cyan(value): return _c("36;1", value)
def dim(value): return _c("2", value)
def bold(value): return _c("1", value)


class Skip(Exception):
    pass


def skip(message):
    raise Skip(message)


VERBOSE = bool(os.environ.get("SAMQL_TB"))
RESULTS = []


def set_verbose(value):
    global VERBOSE
    VERBOSE = bool(value)


def reset_results():
    RESULTS.clear()


def run(group, name, fn):
    started = time.time()
    try:
        fn()
        elapsed = time.time() - started
        RESULTS.append((group, name, "PASS", "", elapsed))
        print(f"  {green('PASS')}  {name} {dim(f'({elapsed * 1000:.0f} ms)')}")
    except Skip as exc:
        RESULTS.append((group, name, "SKIP", str(exc), 0.0))
        print(f"  {yellow('SKIP')}  {name}  {dim('- ' + str(exc))}")
    except SystemExit as exc:
        elapsed = time.time() - started
        detail = ("SystemExit(%r) escaped the test -- a test must "
                  "never exit the runner" % (exc.code,))
        RESULTS.append((group, name, "FAIL", detail, elapsed))
        print(f"  {red('FAIL')}  {name} {dim(f'({elapsed * 1000:.0f} ms)')}")
        print("        " + red(detail))
    except Exception as exc:
        elapsed = time.time() - started
        trace = traceback.format_exc()
        RESULTS.append((group, name, "FAIL",
                        f"{type(exc).__name__}: {exc}", elapsed))
        print(f"  {red('FAIL')}  {name} {dim(f'({elapsed * 1000:.0f} ms)')}")
        if VERBOSE:
            print("\n".join("        " + line
                            for line in trace.rstrip().split("\n")))
        else:
            print(f"        {red(f'{type(exc).__name__}: {exc}')}")


def section(title):
    print("\n" + cyan("=" * 64))
    print(cyan(f"  {title}"))
    print(cyan("=" * 64))


def need(condition, message):
    if not condition:
        raise AssertionError(message)


def eq(got, want, message=""):
    if got != want:
        raise AssertionError(
            f"{message} expected {want!r}, got {got!r}".strip())


def _authorize_api_request(httpd, request):
    url = getattr(request, "full_url", "")
    if "/api/" in url:
        supplied = {key.lower() for key, _value in request.header_items()}
        if "x-samql-token" not in supplied:
            request.add_header("X-SamQL-Token", httpd.samql_api_token)
    return request


def _api_urlopen(httpd, request_or_url, *args, **kwargs):
    if isinstance(request_or_url, str):
        request_or_url = urllib.request.Request(request_or_url)
    return urllib.request.urlopen(
        _authorize_api_request(httpd, request_or_url), *args, **kwargs)


def runner_source_files(root):
    """Return source files belonging to the custom dependency-free runner.

    Standalone pytest files are intentionally excluded because their tests are
    discovered by pytest rather than registered in backend_tests/http_tests/
    frontend_tests.
    """
    tests = Path(root) / "tests"
    fixed = [tests / "run_tests.py", tests / "harness.py",
             tests / "fixtures.py", tests / "paths.py",
             tests / "node_harnesses.py"]
    suites = sorted((tests / "suites").glob("*.py"))
    return [path for path in fixed + suites
            if path.is_file() and path.name != "__init__.py"]


def read_test_sources(root):
    chunks = []
    for path in runner_source_files(root):
        chunks.append(f"\n# ===== {path.name} =====\n")
        chunks.append(path.read_text(encoding="utf-8"))
    return "".join(chunks)
