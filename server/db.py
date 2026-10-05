import os
import sys
from pathlib import Path

try:
    import sqlite3
except ModuleNotFoundError:
    # Some pyenv builds ship without the stdlib sqlite3 module.
    import pysqlite3 as sqlite3
    sys.modules["sqlite3"] = sqlite3

import sqlite_vec

REPO_ROOT = Path(__file__).resolve().parents[1]

_env_loaded = False


def load_env():
    """Fill in variables from the repo `.env` that the shell did not set."""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    path = REPO_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def database_path():
    load_env()
    configured = os.environ.get("DATABASE_PATH", "data/footnote.sqlite")
    path = Path(configured)
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()


def connect():
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Apple's Python builds SQLite without extension loading. sqlite-vec is
    # still loaded by the Node API. Plain tables can be written either way.
    if hasattr(conn, "enable_load_extension"):
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
    return conn


def connect_vectors(readonly=False):
    """Open the database with sqlite-vec loaded.

    Apple's Python builds SQLite without extension loading, so the stdlib
    connection cannot create or query a vec0 table. APSW bundles its own
    SQLite, which can. Passage vectors are written through this connection.

    A read-only connection returns None when the database does not exist.
    """
    import apsw

    path = database_path()
    if readonly:
        if not path.exists():
            return None
        conn = apsw.Connection(str(path), flags=apsw.SQLITE_OPEN_READONLY)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = apsw.Connection(str(path))
    conn.execute("PRAGMA foreign_keys = ON")
    conn.enableloadextension(True)
    conn.loadextension(sqlite_vec.loadable_path())
    conn.enableloadextension(False)
    return conn
