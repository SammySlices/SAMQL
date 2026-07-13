"""Behavioral regressions for refactor sequence phase 2 utilities."""

import json
import os
import tempfile
from pathlib import Path


def backend_cases(root, _csv, _skip):
    def atomic_json_write_is_durable_and_cleans_failures():
        from samql_core import stores

        with tempfile.TemporaryDirectory(prefix="samql-atomic-json-") as td:
            path = Path(td) / "nested" / "state.json"
            value = {"name": "SamQL", "items": [1, 2, {"ok": True}]}
            assert stores.atomic_write_json(path, value) is True
            assert json.loads(path.read_text(encoding="utf-8")) == value
            assert not list(path.parent.glob(".%s.*.tmp" % path.name))

            original_bytes = path.read_bytes()
            real_replace = stores._replace_retry
            try:
                def fail_replace(_tmp, _dst, *args, **kwargs):
                    raise PermissionError("simulated sharing violation")

                stores._replace_retry = fail_replace
                assert stores.atomic_write_json(path, {"changed": True}) is False
            finally:
                stores._replace_retry = real_replace

            assert path.read_bytes() == original_bytes
            assert not list(path.parent.glob(".%s.*.tmp" % path.name))

    def persistence_stores_share_one_atomic_writer():
        source = (Path(root) / "backend" / "samql_core" / "stores.py").read_text(
            encoding="utf-8"
        )
        assert source.count("return atomic_write_json(self.path, self.entries)") == 3
        assert "return atomic_write_json(self.path, self.data)" in source
        # No store may recreate the old fixed-name temp-file implementation.
        assert 'with_suffix(".tmp")' not in source
        assert source.count("json.dump(") == 1

    return [
        (
            "refactor phase 2: atomic JSON writer is durable and cleans failures",
            atomic_json_write_is_durable_and_cleans_failures,
        ),
        (
            "refactor phase 2: persistence stores share one atomic writer",
            persistence_stores_share_one_atomic_writer,
        ),
    ]
