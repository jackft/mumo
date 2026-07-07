import pytest
from pathlib import Path
from mumo import MumoDoc

# Committed minimal fixture always available (used in CI).
# If a real mmeaf.mmeaf exists at the repo root, prefer it for richer local testing.
MMEAF_PATH = Path(__file__).parent / 'fixtures/test.mmeaf'


@pytest.fixture(scope='session')
def doc() -> MumoDoc:
    return MumoDoc(str(MMEAF_PATH))
