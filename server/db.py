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


def database_path():
    configured = os.environ.get("DATABASE_PATH", "data/papertrail.sqlite")
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
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn
