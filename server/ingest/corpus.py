"""Shared tables for poll articles.

documents is one page from a source such as Pew or Marist.
passages are the chunks of that page, in order.
passage_embeddings holds one Voyage vector per passage, and the model name
that produced it.
surveys is one poll fielding, keyed by its pollster, geography, and field
dates. geography is "US", a state's postal code such as "TX", or "INTL".
Its metadata_source says where the values were read: the main source, then
any field that came from elsewhere, as in "page; methodology for margin_of_error"
for Pew or "pdf; page for sample_size, margin_of_error" for Marist.
document_surveys links a page to every survey it reports on. A page can cite
several surveys, and one survey is usually spread over several pages.

The vector table is fixed at 1024 dimensions, which is voyage-4's default.
A later model with a different width needs its own table.
"""

import struct

from server.db import connect_vectors

EMBEDDING_MODEL = "voyage-4"
EMBEDDING_DIMENSION = 1024

# Children before parents, so a drop never trips a foreign key.
TABLES = ("document_surveys", "passage_embeddings", "passages", "surveys", "documents")
COLUMNS = {
    "documents": {
        "id",
        "source",
        "title",
        "url",
        "topic",
        "published_on",
        "doc_type",
        "fetched_at",
        "content_hash",
    },
    "passages": {"id", "document_id", "position", "text"},
    "passage_embeddings": {"passage_id", "embedding", "embedding_model"},
    "surveys": {
        "id",
        "source",
        "survey_key",
        "geography",
        "field_start",
        "field_end",
        "sample_size",
        "population",
        "margin_of_error",
        "metadata_source",
    },
    "document_surveys": {"document_id", "survey_id"},
}
# Nullable columns added after their table was first created. ensure_schema
# adds them in place, because a rebuild would have to embed every passage again.
ADDED_COLUMNS = {"surveys": {"geography": "TEXT", "metadata_source": "TEXT"}}
GEOGRAPHY_INDEX = "CREATE INDEX IF NOT EXISTS surveys_geography ON surveys (geography)"
DOCUMENT_FIELDS = (
    "source",
    "title",
    "url",
    "topic",
    "published_on",
    "doc_type",
    "fetched_at",
    "content_hash",
)
SURVEY_FIELDS = (
    "source",
    "survey_key",
    "geography",
    "field_start",
    "field_end",
    "sample_size",
    "population",
    "margin_of_error",
    "metadata_source",
)


def connect_corpus(readonly=False):
    """Open the database with the corpus tables in place.

    A read-only connection is not rebuilt. It is None when the database does
    not exist, and schema_ready() says whether its tables can be read.
    """
    conn = connect_vectors(readonly=readonly)
    if conn is not None and not readonly:
        ensure_schema(conn)
    return conn


def schema_ready(conn):
    """Whether the tables can be read, possibly after ensure_schema adds ADDED_COLUMNS."""
    for table, expected in COLUMNS.items():
        columns = _columns(conn, table)
        if not columns <= expected or not expected - columns <= set(ADDED_COLUMNS.get(table, {})):
            return False
    return True


def ensure_schema(conn):
    """Add missing ADDED_COLUMNS, or recreate the corpus tables when their columns do not match.

    Everything in them comes from the page cache and Voyage, so any other old
    layout is dropped and loaded again rather than migrated.
    """
    if schema_ready(conn):
        with conn:
            for table, added in ADDED_COLUMNS.items():
                columns = _columns(conn, table)
                for column, kind in added.items():
                    if column not in columns:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            conn.execute(GEOGRAPHY_INDEX)
        return
    with conn:
        for table in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.execute(
            """
            CREATE TABLE documents (
                id INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                topic TEXT,
                published_on TEXT,
                doc_type TEXT,
                fetched_at TEXT,
                content_hash TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX documents_source ON documents (source)")
        conn.execute(
            """
            CREATE TABLE passages (
                id INTEGER PRIMARY KEY,
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                text TEXT NOT NULL,
                UNIQUE (document_id, position)
            )
            """
        )
        conn.execute("CREATE INDEX passages_document_id ON passages (document_id)")
        conn.execute(
            f"""
            CREATE VIRTUAL TABLE passage_embeddings USING vec0(
                passage_id INTEGER PRIMARY KEY,
                embedding float[{EMBEDDING_DIMENSION}],
                embedding_model TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE surveys (
                id INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                survey_key TEXT NOT NULL UNIQUE,
                geography TEXT,
                field_start TEXT NOT NULL,
                field_end TEXT NOT NULL,
                sample_size INTEGER,
                population TEXT,
                margin_of_error REAL,
                metadata_source TEXT
            )
            """
        )
        conn.execute(GEOGRAPHY_INDEX)
        conn.execute(
            """
            CREATE TABLE document_surveys (
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
                PRIMARY KEY (document_id, survey_id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX document_surveys_survey_id ON document_surveys (survey_id)"
        )


def document_state(conn, source):
    """Map each stored url to its content hash and the models behind its vectors."""
    state = {}
    by_id = {}
    for document_id, url, content_hash in conn.execute(
        "SELECT id, url, content_hash FROM documents WHERE source = ?", (source,)
    ):
        entry = {"content_hash": content_hash, "models": set()}
        state[url] = entry
        by_id[document_id] = entry
    for document_id, model in conn.execute(
        """
        SELECT passages.document_id, passage_embeddings.embedding_model
        FROM passages
        JOIN passage_embeddings ON passage_embeddings.passage_id = passages.id
        """
    ):
        if document_id in by_id:
            by_id[document_id]["models"].add(model)
    return state


def stored_surveys(conn, source):
    """This source's surveys. A column not added yet reads as None."""
    present = _columns(conn, "surveys")
    columns = ", ".join(field if field in present else "NULL" for field in SURVEY_FIELDS)
    return [
        dict(zip(SURVEY_FIELDS, row))
        for row in conn.execute(
            f"SELECT {columns} FROM surveys WHERE source = ?", (source,)
        )
    ]


def _columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def replace_document(conn, document, passages, vectors, surveys):
    """Store a page, its passages, their vectors, and its survey links."""
    if len(passages) != len(vectors):
        raise ValueError("each passage needs one vector")
    for vector in vectors:
        if len(vector) != EMBEDDING_DIMENSION:
            raise ValueError(f"expected {EMBEDDING_DIMENSION} dimensions, got {len(vector)}")
    columns = ", ".join(DOCUMENT_FIELDS)
    marks = ", ".join("?" for _ in DOCUMENT_FIELDS)
    with conn:
        # vec0 cannot reference passages, so a replaced document has to drop
        # its vectors before the document delete cascades to passages.
        _delete_document(conn, document["url"])
        conn.execute(
            f"INSERT INTO documents ({columns}) VALUES ({marks})",
            tuple(document.get(field) for field in DOCUMENT_FIELDS),
        )
        document_id = conn.last_insert_rowid()
        for position, (text, vector) in enumerate(zip(passages, vectors)):
            conn.execute(
                "INSERT INTO passages (document_id, position, text) VALUES (?, ?, ?)",
                (document_id, position, text),
            )
            conn.execute(
                """
                INSERT INTO passage_embeddings (passage_id, embedding, embedding_model)
                VALUES (?, ?, ?)
                """,
                (conn.last_insert_rowid(), _blob(vector), EMBEDDING_MODEL),
            )
        _link_surveys(conn, document_id, surveys)
    return document_id


def update_document(conn, document, surveys):
    """Rewrite a stored page's metadata and survey links. Its passages stay."""
    assignments = ", ".join(f"{field} = ?" for field in DOCUMENT_FIELDS)
    with conn:
        row = conn.execute(
            "SELECT id FROM documents WHERE url = ?", (document["url"],)
        ).fetchone()
        if row is None:
            raise ValueError(f"no stored document for {document['url']}")
        document_id = row[0]
        conn.execute(
            f"UPDATE documents SET {assignments} WHERE id = ?",
            tuple(document.get(field) for field in DOCUMENT_FIELDS) + (document_id,),
        )
        conn.execute("DELETE FROM document_surveys WHERE document_id = ?", (document_id,))
        _link_surveys(conn, document_id, surveys)


def prune(conn, source, keep_urls):
    """Delete this source's documents outside keep_urls, then surveys no page cites."""
    with conn:
        removed = [
            row[0]
            for row in conn.execute(
                "SELECT url FROM documents WHERE source = ?", (source,)
            )
            if row[0] not in keep_urls
        ]
        for url in removed:
            _delete_document(conn, url)
        conn.execute(
            """
            DELETE FROM surveys
            WHERE source = ?
              AND id NOT IN (SELECT survey_id FROM document_surveys)
            """,
            (source,),
        )
    return removed


def _link_surveys(conn, document_id, surveys):
    columns = ", ".join(SURVEY_FIELDS)
    marks = ", ".join("?" for _ in SURVEY_FIELDS)
    updates = ", ".join(
        f"{field} = COALESCE(excluded.{field}, surveys.{field})"
        for field in SURVEY_FIELDS
        if field != "survey_key"
    )
    for survey in surveys:
        conn.execute(
            f"""
            INSERT INTO surveys ({columns}) VALUES ({marks})
            ON CONFLICT (survey_key) DO UPDATE SET {updates}
            """,
            tuple(survey.get(field) for field in SURVEY_FIELDS),
        )
        survey_id = conn.execute(
            "SELECT id FROM surveys WHERE survey_key = ?", (survey["survey_key"],)
        ).fetchone()[0]
        conn.execute(
            "INSERT OR IGNORE INTO document_surveys (document_id, survey_id) VALUES (?, ?)",
            (document_id, survey_id),
        )


def _delete_document(conn, url):
    row = conn.execute("SELECT id FROM documents WHERE url = ?", (url,)).fetchone()
    if row is None:
        return
    document_id = row[0]
    passage_ids = [
        item[0]
        for item in conn.execute(
            "SELECT id FROM passages WHERE document_id = ?", (document_id,)
        )
    ]
    for passage_id in passage_ids:
        conn.execute(
            "DELETE FROM passage_embeddings WHERE passage_id = ?", (passage_id,)
        )
    conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))


def _blob(values):
    return struct.pack(f"<{len(values)}f", *(float(value) for value in values))
