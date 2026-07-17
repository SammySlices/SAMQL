"""Select output schema omits kept fields whose upstream source is gone."""
from __future__ import annotations

from samql_core import nodeflow


def test_select_output_omits_missing_upstream_fields():
    # Upstream relation has region_2 + amount (region was renamed away).
    up_cols = ["region_2", "amount"]

    def cols_of(sql):
        # Any probe of the upstream subquery/table returns live names.
        return list(up_cols)

    graph = {
        "nodes": [
            {
                "id": "in",
                "type": "input",
                "config": {"table": "t", "label": "t"},
            },
            {
                "id": "sel",
                "type": "select",
                "config": {
                    "fields": [
                        {"name": "region", "keep": True},  # missing tombstone
                        {"name": "amount", "keep": True},
                        {"name": "region_2", "keep": True},
                    ]
                },
            },
        ],
        "edges": [
            {
                "from": {"node": "in", "port": "out"},
                "to": {"node": "sel", "port": "in"},
            }
        ],
    }

    # Compile Select without a real engine: stub input as a fake table name
    # by compiling through node_output_sql with a custom get_input.
    node = graph["nodes"][1]

    def get_input(port):
        assert port == "in"
        return '"t"'

    # input node path uses table; for select we only need get_input + cols_of
    sql = nodeflow.node_output_sql(node, "out", get_input, cols_of)
    assert "region_2" in sql or "amount" in sql
    # Missing source "region" must not be projected (would break columns probe).
    assert '"region"' not in sql.replace('"region_2"', "")
    out_cols = cols_of(sql)
    # When cols_of is our stub it returns up_cols; verify SQL text instead:
    assert "AS" in sql
    assert "region_2" in sql
    assert "amount" in sql
