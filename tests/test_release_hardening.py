#!/usr/bin/env python3
"""Phase 10 release, deterministic packaging, and transport regression."""
from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Callable
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.aphex_transport import (  # noqa: E402
    END,
    decode_transport_file,
    decode_transport_text,
    sha256_bytes,
)
from tools.package_release import (  # noqa: E402
    package_release,
    parse_bundle_sections,
    refang_transport_text,
    verify_bundle,
)
import tools.release_preflight as release_preflight  # noqa: E402
from tools.release_preflight import load_manifest, run_preflight  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_failure(action: Callable[[], object], pattern: str) -> None:
    try:
        action()
    except (ValueError, UnicodeDecodeError) as exc:
        require(re.search(pattern, str(exc), re.IGNORECASE) is not None, str(exc))
        return
    raise AssertionError(f"expected failure matching {pattern!r}")


def _transport_extensions() -> list[str]:
    release = json.loads((ROOT / "RELEASE_MANIFEST.json").read_text(encoding="utf-8"))
    extensions = (release.get("sourceTransport") or {}).get("dangerousExtensions") or []
    require(
        isinstance(extensions, list)
        and bool(extensions)
        and all(isinstance(item, str) and item for item in extensions),
        "release dangerous-extension declaration is invalid",
    )
    return extensions


def _refang_transport_text(value: str) -> str:
    return refang_transport_text(value, _transport_extensions())


def _workflow_trigger_result(source: str) -> release_preflight.Check:
    with tempfile.TemporaryDirectory(prefix="samql-release-preflight-") as tmp:
        fixture = Path(tmp)
        (fixture / ".github/workflows").mkdir(parents=True)
        (fixture / "frontend/src/components").mkdir(parents=True)
        (fixture / "frontend/e2e").mkdir(parents=True)
        (fixture / "RELEASE_MANIFEST.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "product": "SamQL",
                    "phase": 10,
                    "sourceManifest": "SOURCE_MANIFEST.txt",
                    "generatedAt": "2026-10-11T00:00:00Z",
                    "qualityGates": {
                        "componentTestsMinimum": 0,
                        "edgeE2eTestsMinimum": 0,
                        "nodeFlowShellMaximumLines": 1,
                        "requiredBrowserChannel": "msedge",
                    },
                }
            ),
            encoding="utf-8",
        )
        (fixture / "frontend/src/components/NodeFlow.tsx").write_text(
            "// focused preflight fixture\n", encoding="utf-8"
        )
        (fixture / "frontend/package.json").write_text(
            json.dumps({"scripts": {}}), encoding="utf-8"
        )
        workflow_path = fixture / ".github/workflows/windows-browser.yml"
        workflow_path.write_text(source, encoding="utf-8")

        no_check = lambda *_args: None
        with (
            patch.object(release_preflight, "_check_identity", no_check),
            patch.object(release_preflight, "_check_manifest", lambda *_args: []),
            patch.object(release_preflight, "_check_saved_data", no_check),
            patch.object(release_preflight, "_check_complete_test_extract", no_check),
            patch.object(release_preflight, "_check_docs_and_transport", no_check),
        ):
            results = run_preflight(fixture)
        matches = [
            item for item in results if item.name == "Windows release workflow trigger"
        ]
        require(
            len(matches) == 1,
            "run_preflight did not emit exactly one Windows workflow trigger check",
        )
        return matches[0]


def _parse_branches_direct(source: str) -> tuple[set[str], str | None]:
    """Call the internal parser directly for unit-level assertion."""
    import tools.release_preflight as _rp
    return _rp._workflow_push_branches(source)


def _assert_windows_workflow_requires_unambiguous_master() -> None:
    # ── valid cases ──────────────────────────────────────────────────────────

    valid_inline = _workflow_trigger_result("on:\n  push:\n    branches: [master, beta]\n")
    require(valid_inline.ok, "preflight rejected valid inline [master, beta]")
    require(
        bool("master" in valid_inline.detail),
        f"trigger detail did not mention master for valid inline: {valid_inline.detail!r}",
    )
    # Exact branch-set assertion via direct parser call.
    _br, _err = _parse_branches_direct("on:\n  push:\n    branches: [master, beta]\n")
    require(_err is None, f"direct parser error for valid inline: {_err!r}")
    require(_br == {"master", "beta"}, f"direct parser wrong branches for valid inline: {_br!r}")

    valid_block = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - beta\n"
        "      - master\n"
    )
    require(valid_block.ok, "preflight rejected valid block list with beta and master")
    require(
        bool("master" in valid_block.detail),
        f"trigger detail did not mention master for valid block: {valid_block.detail!r}",
    )
    _br, _err = _parse_branches_direct(
        "on:\n  push:\n    branches:\n      - beta\n      - master\n"
    )
    require(_err is None, f"direct parser error for valid block: {_err!r}")
    require(_br == {"master", "beta"}, f"direct parser wrong branches for valid block: {_br!r}")

    # ── failure cases — each must produce a named check that is not ok ───────

    beta_only = _workflow_trigger_result("on:\n  push:\n    branches: [beta]\n")
    require(not beta_only.ok, "preflight accepted beta without master")
    require(
        bool(beta_only.detail),
        "trigger check detail was empty for beta-only failure",
    )

    master_in_comment = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [main]  # master is stable but we use main\n"
    )
    require(
        not master_in_comment.ok,
        "preflight accepted [main] where master only appeared in a comment",
    )
    require(
        bool(master_in_comment.detail),
        "trigger check detail was empty for master-in-comment failure",
    )

    master_under_pull_request = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "  pull_request:\n"
        "    branches: [master]\n"
    )
    require(
        not master_under_pull_request.ok,
        "preflight accepted master only under pull_request.branches",
    )
    require(
        bool(master_under_pull_request.detail),
        "trigger check detail was empty for master-under-pull_request failure",
    )

    master_in_env = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "jobs:\n"
        "  build:\n"
        "    env:\n"
        "      TARGET_BRANCH: master\n"
    )
    require(
        not master_in_env.ok,
        "preflight accepted master only in an unrelated environment value",
    )
    require(
        bool(master_in_env.detail),
        "trigger check detail was empty for master-in-env failure",
    )

    duplicate_on = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master]\n"
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
    )
    require(not duplicate_on.ok, "preflight accepted duplicate on mappings")
    require(
        bool(duplicate_on.detail),
        "trigger check detail was empty for duplicate-on failure",
    )

    duplicate_push = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master]\n"
        "  push:\n"
        "    branches: [main]\n"
    )
    require(not duplicate_push.ok, "preflight accepted duplicate push mappings")
    require(
        bool(duplicate_push.detail),
        "trigger check detail was empty for duplicate-push failure",
    )

    nested_mapping_under_block_branches = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      aliases:\n"
        "        - master\n"
    )
    require(
        not nested_mapping_under_block_branches.ok,
        "preflight accepted nested mapping under block branches (nested aliases: - master)",
    )
    require(
        bool(nested_mapping_under_block_branches.detail),
        "trigger check detail was empty for nested-mapping-under-block-branches failure",
    )

    inconsistent_indent = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - beta\n"
        "        - master\n"
    )
    require(
        not inconsistent_indent.ok,
        "preflight accepted block branches list with inconsistent/deeper list indentation",
    )
    require(
        bool(inconsistent_indent.detail),
        "trigger check detail was empty for inconsistent-indent failure",
    )

    malformed_inline = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master\n"
    )
    require(
        not malformed_inline.ok,
        "preflight accepted malformed inline list (missing closing bracket)",
    )
    require(
        bool(malformed_inline.detail),
        "trigger check detail was empty for malformed-inline failure",
    )

    # ── Finding 1 (round 1): quoted inline scalar (already fixed) ────────────

    quoted_comma_scalar = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["release, master, sentinel"]\n'
    )
    require(
        not quoted_comma_scalar.ok,
        "preflight accepted quoted comma-containing scalar as if it listed standalone master",
    )
    require(
        bool(quoted_comma_scalar.detail),
        "trigger check detail was empty for quoted-comma-scalar failure",
    )
    # Exact branch-set: the quoted token is one value, not three.
    _br, _err = _parse_branches_direct(
        'on:\n  push:\n    branches: ["release, master, sentinel"]\n'
    )
    require(
        _err is not None or "master" not in _br,
        f"direct parser manufactured standalone master from quoted comma scalar: "
        f"branches={_br!r} err={_err!r}",
    )

    valid_quoted_master = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["master"]\n'
    )
    require(
        valid_quoted_master.ok,
        f"preflight rejected valid quoted simple branch name \"master\": "
        f"{valid_quoted_master.detail!r}",
    )
    require(
        "master" in valid_quoted_master.detail,
        f"trigger detail did not mention master for valid quoted master: "
        f"{valid_quoted_master.detail!r}",
    )
    _br, _err = _parse_branches_direct('on:\n  push:\n    branches: ["master"]\n')
    require(_err is None, f"direct parser error for quoted master: {_err!r}")
    require(_br == {"master"}, f"direct parser wrong branches for quoted master: {_br!r}")

    malformed_quoted = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["master, beta]\n'
    )
    require(
        not malformed_quoted.ok,
        "preflight accepted malformed/unbalanced quoted inline form",
    )
    require(
        bool(malformed_quoted.detail),
        "trigger check detail was empty for malformed-quoted failure",
    )

    # ── Finding 2 (round 1): empty / null list entries (already fixed) ───────

    block_bare_dash = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - master\n"
        "      -\n"
    )
    require(
        not block_bare_dash.ok,
        "preflight accepted block branches list with bare empty `-` entry",
    )
    require(bool(block_bare_dash.detail), "detail empty for block bare-dash failure")

    block_empty_dq = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        '      - ""\n'
        "      - master\n"
    )
    require(
        not block_empty_dq.ok,
        'preflight accepted block branches list with `- ""` empty entry',
    )
    require(bool(block_empty_dq.detail), 'detail empty for block - "" failure')

    block_empty_sq = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - ''\n"
        "      - master\n"
    )
    require(
        not block_empty_sq.ok,
        "preflight accepted block branches list with `- ''` empty entry",
    )
    require(bool(block_empty_sq.detail), "detail empty for block - '' failure")

    inline_trailing_empty = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master, ]\n"
    )
    require(
        not inline_trailing_empty.ok,
        "preflight accepted inline branches list with trailing empty slot [master, ]",
    )
    require(bool(inline_trailing_empty.detail), "detail empty for inline trailing-empty failure")

    inline_leading_empty = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [, master]\n"
    )
    require(
        not inline_leading_empty.ok,
        "preflight accepted inline branches list with leading empty slot [, master]",
    )
    require(bool(inline_leading_empty.detail), "detail empty for inline leading-empty failure")

    inline_double_comma = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master,,beta]\n"
    )
    require(
        not inline_double_comma.ok,
        "preflight accepted inline branches list with double-comma empty slot [master,,beta]",
    )
    require(bool(inline_double_comma.detail), "detail empty for inline double-comma failure")

    for null_spell in ("null", "Null", "NULL", "~"):
        null_inline = _workflow_trigger_result(
            "on:\n"
            "  push:\n"
            f"    branches: [master, {null_spell}]\n"
        )
        require(
            not null_inline.ok,
            f"preflight accepted inline branches list with null spelling {null_spell!r}",
        )
        require(
            bool(null_inline.detail),
            f"detail empty for inline null spelling {null_spell!r} failure",
        )
        # Exact parser assertion: unquoted null must produce an error.
        _br, _err = _parse_branches_direct(
            f"on:\n  push:\n    branches: [master, {null_spell}]\n"
        )
        require(
            _err is not None,
            f"direct parser accepted unquoted null spelling {null_spell!r}: branches={_br!r}",
        )

    # ── Finding 3 (round 1): valid indentless block sequence ─────────────────

    valid_indentless = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "    - beta\n"
        "    - master\n"
    )
    require(
        valid_indentless.ok,
        f"preflight rejected valid indentless block sequence for branches: "
        f"{valid_indentless.detail!r}",
    )
    require(
        "master" in valid_indentless.detail,
        f"trigger detail did not mention master for valid indentless block: "
        f"{valid_indentless.detail!r}",
    )
    _br, _err = _parse_branches_direct(
        "on:\n  push:\n    branches:\n    - beta\n    - master\n"
    )
    require(_err is None, f"direct parser error for valid indentless: {_err!r}")
    require(_br == {"master", "beta"}, f"direct parser wrong branches for indentless: {_br!r}")

    mixed_indent_style = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "    - beta\n"
        "      - master\n"
    )
    require(
        not mixed_indent_style.ok,
        "preflight accepted mixed indented/indentless block branch style",
    )
    require(bool(mixed_indent_style.detail), "detail empty for mixed-indent-style failure")

    # ── Sibling mapping transition after indentless list ─────────────────────
    # branches at indent 4 with indentless items, then a sibling key at indent 4
    # (pull_request) must exit block mode cleanly; master must NOT be found.
    sibling_after_indentless = _parse_branches_direct(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "    - beta\n"
        "    pull_request:\n"
        "      branches: [main]\n"
    )
    _br, _err = sibling_after_indentless
    require(
        _err is None or "master" not in _br,
        f"sibling transition after indentless list leaked state: branches={_br!r} err={_err!r}",
    )
    require(
        "master" not in _br,
        f"sibling transition after indentless incorrectly included master: {_br!r}",
    )

    # Sibling mapping transition after indented list must also exit cleanly.
    _br, _err = _parse_branches_direct(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - beta\n"
        "    pull_request:\n"
        "      branches: [main]\n"
    )
    require(
        _err is None,
        f"sibling transition after indented list produced error: {_err!r}",
    )
    require(
        "master" not in _br,
        f"sibling transition after indented list incorrectly included master: {_br!r}",
    )

    # ── Round-2 findings: trailing garbage, plain grammar, block strict decode ─

    # CRITICAL-1: trailing garbage after quoted scalar must fail.
    trailing_garbage_inline = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["master" garbage]\n'
    )
    require(
        not trailing_garbage_inline.ok,
        "preflight accepted trailing garbage after quoted inline scalar",
    )
    require(
        bool(trailing_garbage_inline.detail),
        "detail empty for trailing-garbage-after-quoted failure",
    )
    _br, _err = _parse_branches_direct(
        'on:\n  push:\n    branches: ["master" garbage]\n'
    )
    require(
        _err is not None,
        f"direct parser accepted trailing garbage after quoted scalar: branches={_br!r}",
    )

    # CRITICAL-2a: mapping colon inside plain flow item must fail.
    plain_with_colon = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches: [master, beta: sentinel]\n"
    )
    require(
        not plain_with_colon.ok,
        "preflight accepted plain flow item containing mapping colon [master, beta: sentinel]",
    )
    require(bool(plain_with_colon.detail), "detail empty for plain-colon failure")
    _br, _err = _parse_branches_direct(
        "on:\n  push:\n    branches: [master, beta: sentinel]\n"
    )
    require(
        _err is not None,
        f"direct parser accepted colon in plain flow item: branches={_br!r}",
    )

    # CRITICAL-2b: structural chars { [ & * ! mid-token alongside master must fail.
    for bad_char, label in (("{", "brace"), ("[", "bracket"), ("&", "amp"), ("*", "star"), ("!", "bang")):
        src = f"on:\n  push:\n    branches: [master, {bad_char}beta]\n"
        r = _workflow_trigger_result(src)
        require(
            not r.ok,
            f"preflight accepted plain flow item starting with {bad_char!r} [{label}]: "
            f"detail={r.detail!r}",
        )
        _br, _err = _parse_branches_direct(src)
        require(
            _err is not None,
            f"direct parser accepted {bad_char!r} in plain flow item [{label}]: branches={_br!r}",
        )

    # CRITICAL-3: malformed block quote alongside master must fail.
    block_malformed_quote = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        '      - "master\n'
        "      - beta\n"
    )
    require(
        not block_malformed_quote.ok,
        "preflight accepted block item with unbalanced double quote alongside master",
    )
    require(bool(block_malformed_quote.detail), "detail empty for block-malformed-quote failure")
    _br, _err = _parse_branches_direct(
        "on:\n  push:\n    branches:\n      - \"master\n      - beta\n"
    )
    require(
        _err is not None,
        f"direct parser accepted block item with unbalanced double quote: branches={_br!r}",
    )

    # IMPORTANT-4: unsupported double-quoted escape must fail.
    unsupported_escape = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["mas\\nter"]\n'
    )
    require(
        not unsupported_escape.ok,
        "preflight accepted double-quoted branch name with unsupported \\n escape",
    )
    require(bool(unsupported_escape.detail), "detail empty for unsupported-escape failure")
    _br, _err = _parse_branches_direct('on:\n  push:\n    branches: ["mas\\nter"]\n')
    require(
        _err is not None,
        f"direct parser accepted unsupported \\n escape: branches={_br!r}",
    )

    # Supported escapes \" and \\ must still work.
    supported_escape_dq = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["mas\\"ter", master]\n'
    )
    # mas"ter is a valid (if unusual) branch name and is not "master"
    _br, _err = _parse_branches_direct('on:\n  push:\n    branches: ["mas\\"ter", master]\n')
    require(_err is None, f"direct parser error for supported \\\" escape: {_err!r}")
    require("master" in _br, f"direct parser lost master with supported escape: {_br!r}")

    supported_escape_bs = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        '    branches: ["mas\\\\ter", master]\n'
    )
    _br, _err = _parse_branches_direct('on:\n  push:\n    branches: ["mas\\\\ter", master]\n')
    require(_err is None, f"direct parser error for supported \\\\ escape: {_err!r}")
    require("master" in _br, f"direct parser lost master with \\\\ escape: {_br!r}")

    # IMPORTANT-5: quoted null-like names are valid branch names.
    for quoted_null in ('"null"', '"NULL"', '"Null"', '"~"'):
        src = f"on:\n  push:\n    branches: [{quoted_null}, master]\n"
        r = _workflow_trigger_result(src)
        require(
            r.ok,
            f"preflight rejected quoted null-like branch name {quoted_null}: "
            f"detail={r.detail!r}",
        )
        _br, _err = _parse_branches_direct(src)
        require(_err is None, f"direct parser error for quoted null {quoted_null!r}: {_err!r}")
        require("master" in _br, f"direct parser lost master with quoted null {quoted_null!r}: {_br!r}")

    # Same for single-quoted.
    for quoted_null in ("'null'", "'NULL'", "'Null'", "'~'"):
        src = f"on:\n  push:\n    branches: [{quoted_null}, master]\n"
        r = _workflow_trigger_result(src)
        require(
            r.ok,
            f"preflight rejected single-quoted null-like branch name {quoted_null}: "
            f"detail={r.detail!r}",
        )
        _br, _err = _parse_branches_direct(src)
        require(_err is None, f"direct parser error for sq quoted null {quoted_null!r}: {_err!r}")
        require("master" in _br, f"direct parser lost master with sq null {quoted_null!r}: {_br!r}")

    # Unquoted null remains rejected (regression from round 1).
    for null_spell in ("null", "Null", "NULL", "~"):
        _br, _err = _parse_branches_direct(
            f"on:\n  push:\n    branches: [{null_spell}, master]\n"
        )
        require(
            _err is not None,
            f"direct parser accepted unquoted null {null_spell!r} as branch: branches={_br!r}",
        )

    # IMPORTANT-5 block: quoted null-like names in block form must be accepted.
    block_quoted_null = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        '      - "null"\n'
        "      - master\n"
    )
    require(
        block_quoted_null.ok,
        f"preflight rejected block item with quoted null-like name \"null\": "
        f"detail={block_quoted_null.detail!r}",
    )
    _br, _err = _parse_branches_direct(
        'on:\n  push:\n    branches:\n      - "null"\n      - master\n'
    )
    require(_err is None, f"direct parser error for block quoted null: {_err!r}")
    require("master" in _br, f"direct parser lost master for block quoted null: {_br!r}")
    require("null" in _br, f"direct parser lost 'null' branch for block quoted null: {_br!r}")

    # Block unquoted null must be rejected.
    block_unquoted_null = _workflow_trigger_result(
        "on:\n"
        "  push:\n"
        "    branches:\n"
        "      - null\n"
        "      - master\n"
    )
    require(
        not block_unquoted_null.ok,
        "preflight accepted block branches list with unquoted null entry",
    )
    _br, _err = _parse_branches_direct(
        "on:\n  push:\n    branches:\n      - null\n      - master\n"
    )
    require(
        _err is not None,
        f"direct parser accepted block unquoted null: branches={_br!r}",
    )


def _assert_golden_flow_fixture_omission_detected() -> None:
    """Focused regression: dropping one golden-flow fixture from the manifest
    must cause run_preflight() to report 'complete test extract trees' failed
    and identify the missing fixture by exact path.

    Approach: build a minimal temporary root that contains the real fixture
    file on disk but lists a SOURCE_MANIFEST.txt that omits it.  Patch away
    every unrelated preflight section so the complete-test-tree check and the
    manifest load run against the real implementation.
    """
    omit = "tests/fixtures/golden_flows/expected.json"

    with tempfile.TemporaryDirectory(prefix="samql-release-preflight-") as tmp:
        fixture = Path(tmp)

        # --- minimal directory structure required by the check ---
        (fixture / "tests/fixtures/golden_flows").mkdir(parents=True)
        (fixture / "tools").mkdir()
        (fixture / "frontend/e2e").mkdir(parents=True)

        # The fixture file must exist on disk so _iter_test_tree_files picks
        # it up; the manifest omits it, which is what the regression proves.
        (fixture / omit).write_text("{}\n", encoding="utf-8")

        # A minimal SOURCE_MANIFEST.txt: real 413-entry manifest minus the
        # one omitted fixture so this regression is independent of the repo's
        # manifest changing in future.
        full_manifest = load_manifest(ROOT / "SOURCE_MANIFEST.txt")
        reduced = [e for e in full_manifest if e != omit]
        require(
            len(reduced) == len(full_manifest) - 1,
            f"{omit!r} was not present in the production manifest; "
            "this regression is only meaningful when the fixture is manifested",
        )
        (fixture / "SOURCE_MANIFEST.txt").write_text(
            "\n".join(reduced) + "\n", encoding="utf-8"
        )

        # Minimal RELEASE_MANIFEST.json — enough for run_preflight() to parse
        # and pass through to _check_complete_test_extract.
        (fixture / "RELEASE_MANIFEST.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "product": "SamQL",
                    "phase": 10,
                    "sourceManifest": "SOURCE_MANIFEST.txt",
                    "sourceFileCount": len(reduced),
                    "generatedAt": "2026-10-11T00:00:00Z",
                    "qualityGates": {
                        "componentTestsMinimum": 0,
                        "edgeE2eTestsMinimum": 0,
                        "nodeFlowShellMaximumLines": 1,
                        "requiredBrowserChannel": "msedge",
                    },
                }
            ),
            encoding="utf-8",
        )

        # _check_complete_test_extract reads several files after recording the
        # tree check.  Provide minimal stubs so it can complete without
        # crashing; their content makes those subsidiary checks fail, which is
        # fine — only the tree check result is asserted below.
        (fixture / "Test-SamQL-All[.]ps1").write_text("# focused preflight fixture\n", encoding="utf-8")
        (fixture / "Expand-SamQL[.]ps1").write_text("# focused preflight fixture\n", encoding="utf-8")
        (fixture / "frontend").mkdir(exist_ok=True)
        (fixture / "frontend/package.json").write_text(
            json.dumps({"scripts": {}}), encoding="utf-8"
        )
        (fixture / "frontend/vitest.config.ts").write_text(
            "// focused preflight fixture\n", encoding="utf-8"
        )

        # Patch away every section except _check_complete_test_extract and
        # _check_manifest (which loads the manifest entries passed downstream).
        no_check = lambda *_args: None
        with (
            patch.object(release_preflight, "_check_identity", no_check),
            patch.object(release_preflight, "_check_saved_data", no_check),
            patch.object(release_preflight, "_check_quality_and_ci", no_check),
            patch.object(release_preflight, "_check_docs_and_transport", no_check),
        ):
            results = run_preflight(fixture)

    tree_check = next(
        (item for item in results if item.name == "complete test extract trees"),
        None,
    )
    require(tree_check is not None, "run_preflight did not emit 'complete test extract trees' check")
    require(
        not tree_check.ok,
        f"preflight accepted a manifest with {omit!r} omitted; "
        f"check detail: {tree_check.detail!r}",
    )
    require(
        omit in tree_check.detail,
        f"'complete test extract trees' detail did not identify {omit!r}; "
        f"got: {tree_check.detail!r}",
    )


def main() -> int:
    _assert_windows_workflow_requires_unambiguous_master()
    _assert_golden_flow_fixture_omission_detected()
    failures = [item for item in run_preflight(ROOT) if not item.ok]
    require(
        not failures,
        "release preflight failed: "
        + "; ".join(f"{item.name}: {item.detail}" for item in failures),
    )

    with (
        tempfile.TemporaryDirectory(prefix="samql-release-a-") as first_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-b-") as second_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-expanded-") as expanded_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-expanded-out-") as expanded_out_tmp,
    ):
        first = package_release(ROOT, Path(first_tmp), preflight=False)
        second = package_release(ROOT, Path(second_tmp), preflight=False)

        first_bundle = first.bundle_path.read_bytes()
        second_bundle = second.bundle_path.read_bytes()
        first_aphex = first.aphex_path.read_bytes()
        second_aphex = second.aphex_path.read_bytes()
        first_receipt = first.receipt_path.read_bytes()
        second_receipt = second.receipt_path.read_bytes()
        require(first_bundle == second_bundle, "decoded source packaging is not deterministic")
        require(first_aphex == second_aphex, "APHEX packaging is not deterministic")
        require(first_receipt == second_receipt, "release receipt is not deterministic")

        decoded, metadata = decode_transport_file(first.aphex_path, verify=True)
        require(decoded == first_bundle, "APHEX did not round-trip the decoded bundle")
        require(metadata.original_bytes == len(first_bundle), "APHEX byte metadata is wrong")
        require(metadata.expected_sha256 == sha256_bytes(first_bundle), "APHEX SHA metadata is wrong")
        require(END in first_aphex.decode("ascii"), "current APHEX transport lacks DATA_END")

        # The build-587 transport shape had no DATA_END; read compatibility is
        # intentional even though all new output is explicitly terminated.
        legacy_text = first_aphex.decode("ascii").replace(f"{END}\n", "", 1)
        legacy_decoded, _ = decode_transport_text(legacy_text, verify=True)
        require(legacy_decoded == first_bundle, "legacy EOF-terminated APHEX no longer decodes")

        sections = parse_bundle_sections(first_bundle)
        manifest = load_manifest(ROOT / "SOURCE_MANIFEST.txt")
        logical_sections = [_refang_transport_text(path) for path in sections]
        logical_manifest = [_refang_transport_text(path) for path in manifest]
        require(
            logical_sections == logical_manifest,
            "bundle section order differs from the logical manifest",
        )
        require(len(sections) == len(manifest), "bundle section count differs from manifest")
        require(first.file_count == len(manifest), "package result count differs from manifest")
        from tools.release_preflight import TEST_EXTRACT_BOOTSTRAP, TEST_EXTRACT_TREES

        logical_manifest_set = set(logical_manifest)
        missing_bootstrap = [
            rel for rel in TEST_EXTRACT_BOOTSTRAP if rel not in logical_manifest_set
        ]
        require(
            not missing_bootstrap,
            "packaged extract is missing test bootstrap files: "
            + ", ".join(missing_bootstrap[:8]),
        )
        for tree in TEST_EXTRACT_TREES:
            require(
                any(path == tree or path.startswith(tree + "/") for path in logical_manifest),
                f"packaged extract is missing test tree {tree}/",
            )
        dangerous_extension = re.compile(
            rb"(?i)\.(?:exe|dll|msi|bat|cmd|scr|vbs|ps1|jar)(?=$|[^A-Za-z0-9])"
        )
        unsafe = dangerous_extension.search(first_bundle)
        require(
            unsafe is None,
            f"bundle contains an undefanged dangerous extension token: {unsafe.group(0)!r}"
            if unsafe
            else "bundle contains an undefanged dangerous extension token",
        )
        unsafe_aphex = dangerous_extension.search(first_aphex)
        require(
            unsafe_aphex is None,
            f"APHEX transport contains an undefanged dangerous extension token: "
            f"{unsafe_aphex.group(0)!r}"
            if unsafe_aphex
            else "APHEX transport contains an undefanged dangerous extension token",
        )

        receipt = json.loads(first_receipt)
        release = json.loads((ROOT / "RELEASE_MANIFEST.json").read_text(encoding="utf-8"))
        require(receipt["build"] == release["build"], "receipt build is wrong")
        require(receipt["version"] == release["version"], "receipt version is wrong")
        require(receipt["sourceFiles"] == len(manifest), "receipt source count is wrong")
        require(receipt["decodedBundle"]["sha256"] == first.bundle_sha256, "receipt bundle SHA is wrong")
        require(receipt["aphexTransport"]["sha256"] == first.aphex_sha256, "receipt APHEX SHA is wrong")
        require(receipt["verification"]["aphexRoundTrip"] is True, "receipt lacks APHEX proof")

        # Expand-SamQL restores only mail-defanged dangerous extensions.  A
        # standalone "[.]" source literal must survive reconstruction, while
        # script names and references are restored.  The release commands must
        # remain valid in that reconstructed tree and reproduce the same bytes.
        require(
            _refang_transport_text("literal [.] and Pack-SamQL.ps1")
            == "literal [.] and Pack-SamQL.ps1",
            "targeted transport refang changed a literal marker",
        )
        expanded_root = Path(expanded_tmp) / "samql"
        for safe_rel, payload in sections.items():
            logical_rel = _refang_transport_text(safe_rel)
            destination = expanded_root / logical_rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(
                _refang_transport_text(payload.decode("utf-8")).encode("utf-8")
            )
        expanded_failures = [
            item for item in run_preflight(expanded_root) if not item.ok
        ]
        require(
            not expanded_failures,
            "expanded-tree preflight failed: "
            + "; ".join(
                f"{item.name}: {item.detail}" for item in expanded_failures
            ),
        )
        expanded = package_release(
            expanded_root, Path(expanded_out_tmp), preflight=False
        )
        require(
            expanded.bundle_path.read_bytes() == first_bundle,
            "expanded-tree packaging changed canonical decoded bytes",
        )
        require(
            expanded.aphex_path.read_bytes() == first_aphex,
            "expanded-tree packaging changed canonical APHEX bytes",
        )

        # A changed bundle byte must fail the body hash/section parity check.
        tampered_bundle = bytearray(first_bundle)
        body_start = first_bundle.index(b"===== FILE: ")
        tampered_bundle[body_start + 20] ^= 1
        expect_failure(
            lambda: verify_bundle(ROOT, bytes(tampered_bundle), manifest),
            r"section|sha|path",
        )

        # A changed APHEX symbol must fail declared SHA/byte verification.
        tampered_text = first_aphex.decode("ascii")
        payload_at = tampered_text.index("DATA_BEGIN") + len("DATA_BEGIN")
        symbol_at = next(
            index
            for index in range(payload_at, len(tampered_text))
            if tampered_text[index] in "ABCDEFGHIJKLMNOP"
        )
        replacement = "A" if tampered_text[symbol_at] != "A" else "B"
        tampered_text = (
            tampered_text[:symbol_at] + replacement + tampered_text[symbol_at + 1 :]
        )
        expect_failure(
            lambda: decode_transport_text(tampered_text, verify=True),
            r"sha-256|byte count",
        )

        print(
            "Phase 10 release hardening PASS: "
            f"{first.file_count} files, "
            f"bundle {first.bundle_bytes} bytes ({first.bundle_sha256}), "
            f"APHEX {first.aphex_bytes} bytes ({first.aphex_sha256}), "
            f"receipt {first.receipt_bytes} bytes ({first.receipt_sha256})."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
