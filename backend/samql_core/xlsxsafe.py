"""Spreadsheet-injection guard shared by every xlsx writer.

openpyxl turns any string that starts with "=" into a LIVE formula cell.
Exported data and headers (and the lineage workbook) must stay text, so
every row goes through ``text_row`` before ``ws.append``.
"""


def text_row(ws, values):
    """Cells for ``values`` on ``ws``, with no string promoted to a formula.

    Works for write-only and regular worksheets (``ws.append`` accepts the
    cells either way). Numbers and None pass through untouched.
    """
    from openpyxl.cell.cell import WriteOnlyCell
    out = []
    for v in values:
        c = WriteOnlyCell(ws, value=v)
        if getattr(c, "data_type", None) == "f":
            c.data_type = "s"
        out.append(c)
    return out
