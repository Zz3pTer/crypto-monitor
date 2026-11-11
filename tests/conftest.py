import sys
from pathlib import Path

# Let tests import the modules in python/ directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
