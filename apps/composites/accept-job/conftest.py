"""
Root conftest for accept-job.
Adds the service directory to sys.path so that `from src.xxx import ...`
works when pytest is invoked from the workspace root.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure the accept-job directory is on sys.path so `src.*` imports resolve
sys.path.insert(0, str(Path(__file__).parent))
