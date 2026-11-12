"""`python <path>/atelier --root ...`: start the server without changing directory."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from atelier.server import main  # noqa: E402

sys.exit(main())
