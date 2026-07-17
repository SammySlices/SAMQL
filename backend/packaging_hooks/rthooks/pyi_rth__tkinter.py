#-----------------------------------------------------------------------------
# SamQL packaging override of PyInstaller's stock pyi_rth__tkinter.
#
# Stock behavior raises FileNotFoundError when _tcl_data / _tk_data are
# missing under sys._MEIPASS, which surfaces as:
#   "failed to execute script 'pyi_rth__tkinter'"
# before any application code runs. AppWindow only needs tkinter for the
# optional splash (make_splash() already falls back to _NoSplash), so a
# missing Tcl/Tk tree must not kill launch. When the dirs are present we
# still set TCL_LIBRARY / TK_LIBRARY exactly like the stock hook.
#-----------------------------------------------------------------------------


def _pyi_rthook():
    import os
    import sys

    # Names must match TCL_ROOTNAME / TK_ROOTNAME in
    # PyInstaller.utils.hooks.tcl_tk.
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return

    tcldir = os.path.join(meipass, "_tcl_data")
    tkdir = os.path.join(meipass, "_tk_data")

    # Prefer bundled trees. Also require init.tcl / tk.tcl so a partial
    # Explorer extract (empty _tcl_data dir present, files still copying)
    # does not point TCL_LIBRARY at an incomplete tree.
    tcl_ok = os.path.isfile(os.path.join(tcldir, "init.tcl"))
    tk_ok = os.path.isfile(os.path.join(tkdir, "tk.tcl"))

    if tcl_ok:
        os.environ["TCL_LIBRARY"] = tcldir
    else:
        # Drop stale host/venv TCL_LIBRARY that can break splash on a
        # lean unzip where the frozen tree is still incomplete.
        os.environ.pop("TCL_LIBRARY", None)
    if tk_ok:
        os.environ["TK_LIBRARY"] = tkdir
    else:
        os.environ.pop("TK_LIBRARY", None)


_pyi_rthook()
del _pyi_rthook
