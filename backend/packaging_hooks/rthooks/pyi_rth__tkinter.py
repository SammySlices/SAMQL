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

    if os.path.isdir(tcldir):
        os.environ["TCL_LIBRARY"] = tcldir
    if os.path.isdir(tkdir):
        os.environ["TK_LIBRARY"] = tkdir


_pyi_rthook()
del _pyi_rthook
