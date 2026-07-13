"""Repository paths shared by the SamQL test suites."""
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = str(TESTS.parent)
BACKEND = str(TESTS.parent / "backend")
FRONTEND = str(TESTS.parent / "frontend")
