"""Load FEC bulk files from data/ingestion/fec into SQLite.

cn, cm, ccl, weball26, and webk26 are pipe-delimited and have no header row.
cn, cm, and ccl each ship with a one-line CSV of column names. weball26 and
webk26 do not; their columns come from the FEC file descriptions.
independent_expenditure_2026.csv is a normal CSV and includes its own header.

Every run drops and recreates these tables, then inserts the current files.
A second run replaces the rows. It does not append.

The files are not a closed set of ids. A linkage can name a candidate or
committee that is missing from the other extract, and a few summary rows name
a candidate who is not in the candidate master. The tables therefore have no
foreign keys. Indexes cover the columns we join on.

The independent-expenditure file includes original filings and amendments, so
transaction ids repeat. That table has no primary key.
"""

import csv

from server.db import REPO_ROOT, connect

FEC_DIR = REPO_ROOT / "data" / "ingestion" / "fec"

# Years and the linkage id are whole numbers. Dollar amounts and the general-
# election percentage are decimals. Everything else stays text, including
# dates (MM/DD/YYYY) and ids that look numeric but can have leading zeros.
INTEGER_COLUMNS = frozenset(
    {
        "CAND_ELECTION_YR",
        "FEC_ELECTION_YR",
        "LINKAGE_ID",
        "FILE_NUM",
        "PREV_FILE_NUM",
        "IMAGE_NUM",
    }
)

REAL_COLUMNS = frozenset(
    {
        "TTL_RECEIPTS",
        "TRANS_FROM_AUTH",
        "TTL_DISB",
        "TRANS_TO_AUTH",
        "COH_BOP",
        "COH_COP",
        "CAND_CONTRIB",
        "CAND_LOANS",
        "OTHER_LOANS",
        "CAND_LOAN_REPAY",
        "OTHER_LOAN_REPAY",
        "DEBTS_OWED_BY",
        "TTL_INDIV_CONTRIB",
        "GEN_ELECTION_PRECENT",
        "OTHER_POL_CMTE_CONTRIB",
        "POL_PTY_CONTRIB",
        "INDIV_REFUNDS",
        "CMTE_REFUNDS",
        "TRANS_FROM_AFF",
        "INDV_CONTRIB",
        "TTL_LOANS_RECEIVED",
        "TRANF_TO_AFF",
        "OTHER_POL_CMTE_REFUNDS",
        "LOAN_REPAY",
        "NONFED_TRANS_RECEIVED",
        "CONTRIB_TO_OTHER_CMTE",
        "IND_EXP",
        "PTY_COORD_EXP",
        "NONFED_SHARE_EXP",
        "EXP_AMO",
        "AGG_AMO",
    }
)

# weball26.txt has no header file on the FEC site. This is the column order
# from https://www.fec.gov/campaign-finance-data/all-candidates-file-description/
# GEN_ELECTION_PRECENT is spelled that way in the FEC description.
WEBALL_COLUMNS = (
    "CAND_ID",
    "CAND_NAME",
    "CAND_ICI",
    "PTY_CD",
    "CAND_PTY_AFFILIATION",
    "TTL_RECEIPTS",
    "TRANS_FROM_AUTH",
    "TTL_DISB",
    "TRANS_TO_AUTH",
    "COH_BOP",
    "COH_COP",
    "CAND_CONTRIB",
    "CAND_LOANS",
    "OTHER_LOANS",
    "CAND_LOAN_REPAY",
    "OTHER_LOAN_REPAY",
    "DEBTS_OWED_BY",
    "TTL_INDIV_CONTRIB",
    "CAND_OFFICE_ST",
    "CAND_OFFICE_DISTRICT",
    # Election-result fields. The FEC only fills these in the 1996–2006 files.
    "SPEC_ELECTION",
    "PRIM_ELECTION",
    "RUN_ELECTION",
    "GEN_ELECTION",
    "GEN_ELECTION_PRECENT",
    "OTHER_POL_CMTE_CONTRIB",
    "POL_PTY_CONTRIB",
    "CVG_END_DT",
    "INDIV_REFUNDS",
    "CMTE_REFUNDS",
)

# webk26.txt has no header file. Column order is from
# https://www.fec.gov/campaign-finance-data/pac-and-party-summary-file-description/
# TRANF_TO_AFF is spelled that way in the FEC description.
WEBK_COLUMNS = (
    "CMTE_ID",
    "CMTE_NM",
    "CMTE_TP",
    "CMTE_DSGN",
    "CMTE_FILING_FREQ",
    "TTL_RECEIPTS",
    "TRANS_FROM_AFF",
    "INDV_CONTRIB",
    "OTHER_POL_CMTE_CONTRIB",
    "CAND_CONTRIB",
    "CAND_LOANS",
    "TTL_LOANS_RECEIVED",
    "TTL_DISB",
    "TRANF_TO_AFF",
    "INDV_REFUNDS",
    "OTHER_POL_CMTE_REFUNDS",
    "CAND_LOAN_REPAY",
    "LOAN_REPAY",
    "COH_BOP",
    "COH_COP",
    "DEBTS_OWED_BY",
    "NONFED_TRANS_RECEIVED",
    "CONTRIB_TO_OTHER_CMTE",
    "IND_EXP",
    "PTY_COORD_EXP",
    "NONFED_SHARE_EXP",
    "CVG_END_DT",
)

# header: CSV of column names, when the FEC published one.
# columns: used when there is no header file.
# indexes: join columns that are not already the primary key.
SOURCES = (
    {
        "table": "fec_candidate",
        "data": "cn.txt",
        "header": "cn_header_file.csv",
        "primary_key": "CAND_ID",
        "indexes": ("CAND_PCC",),
    },
    {
        "table": "fec_committee",
        "data": "cm.txt",
        "header": "cm_header_file.csv",
        "primary_key": "CMTE_ID",
        "indexes": ("CAND_ID",),
    },
    {
        "table": "fec_candidate_committee",
        "data": "ccl.txt",
        "header": "ccl_header_file.csv",
        "primary_key": "LINKAGE_ID",
        "indexes": ("CAND_ID", "CMTE_ID"),
    },
    {
        "table": "fec_candidate_summary",
        "data": "weball26.txt",
        "columns": WEBALL_COLUMNS,
        "primary_key": "CAND_ID",
        "indexes": (),
    },
    {
        "table": "fec_pac_summary",
        "data": "webk26.txt",
        "columns": WEBK_COLUMNS,
        "primary_key": "CMTE_ID",
        "indexes": (),
    },
    # header_row: the first line of the file names the columns.
    # Dates in this file look like 16-MAY-26 and stay text.
    {
        "table": "fec_independent_expenditure",
        "data": "independent_expenditure_2026.csv",
        "delimiter": ",",
        "header_row": True,
        "indexes": ("CAND_ID", "SPE_ID"),
    },
)


def ingest_fec(no_write=False):
    # Read every file before dropping anything. A short row or a missing
    # column then leaves the previous load in place.
    loaded = [_read(source) for source in SOURCES]
    summary = ", ".join(f"{len(source['rows'])} {source['table']}" for source in loaded)
    if no_write:
        print(f"FEC would replace: {summary}.")
        return
    with connect() as conn:
        # sqlite3 only opens a transaction before DML, so without this each
        # DROP and CREATE commits on its own and a failed insert leaves the
        # tables empty.
        conn.execute("BEGIN")
        for source in loaded:
            _create(conn, source)
        for source in loaded:
            _insert(conn, source)
    print(f"Loaded FEC rows: {summary}.")


def _read(source):
    path = FEC_DIR / source["data"]
    delimiter = source.get("delimiter", "|")
    if source.get("header_row"):
        columns = _file_header(path, delimiter)
    elif "header" in source:
        columns = _header(FEC_DIR / source["header"])
    else:
        columns = _check_names(list(source["columns"]))
    label = source.get("header", source["data"])
    primary_key = source.get("primary_key")
    if primary_key is not None and primary_key not in columns:
        raise ValueError(f"{label} is missing {primary_key}")
    for column in source["indexes"]:
        if column not in columns:
            raise ValueError(f"{label} is missing {column}")
    rows = _rows(path, columns, delimiter=delimiter, skip_header=bool(source.get("header_row")))
    return {**source, "columns": columns, "rows": rows}


def _file_header(path, delimiter):
    """Read column names from the first row of a CSV that includes a header."""
    with path.open(newline="", encoding="utf-8") as handle:
        header = next(_reader(handle, delimiter), None)
    if not header:
        raise ValueError(f"{path} is missing a header row")
    return _check_names([name.strip().upper() for name in header])


def _header(path):
    """Read the one-line CSV of column names that accompanies some FEC files."""
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if len(rows) != 1 or not rows[0]:
        raise ValueError(f"{path} should contain one header row")
    return _check_names(rows[0])


def _check_names(columns):
    # Names are interpolated into SQL, so reject anything that is not a plain identifier.
    for column in columns:
        if not column.replace("_", "").isalnum() or not column.isidentifier():
            raise ValueError(f"unexpected column name: {column}")
    return columns


def _rows(path, columns, delimiter="|", skip_header=False):
    """Read one FEC file. Blank fields become NULL."""
    width = len(columns)
    integer_at = {index for index, column in enumerate(columns) if column in INTEGER_COLUMNS}
    real_at = {index for index, column in enumerate(columns) if column in REAL_COLUMNS}
    rows = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = _reader(handle, delimiter)
        if skip_header:
            next(reader, None)
        start = 2 if skip_header else 1
        for line_number, raw in enumerate(reader, start=start):
            if len(raw) != width:
                raise ValueError(
                    f"{path}:{line_number} has {len(raw)} fields, expected {width}"
                )
            row = []
            for index, value in enumerate(raw):
                try:
                    if value == "":
                        row.append(None)
                    elif index in integer_at:
                        row.append(int(value))
                    elif index in real_at:
                        row.append(float(value))
                    else:
                        row.append(value)
                except ValueError:
                    raise ValueError(
                        f"{path}:{line_number} {columns[index]} is not a number: {value!r}"
                    ) from None
            rows.append(tuple(row))
    return rows


def _reader(handle, delimiter):
    # The pipe-delimited files are not quoted. A name such as "BUD" SMITH would
    # otherwise lose its quotes, and an unmatched quote would swallow fields.
    if delimiter == "|":
        return csv.reader(handle, delimiter=delimiter, quoting=csv.QUOTE_NONE)
    return csv.reader(handle, delimiter=delimiter)


def _create(conn, source):
    definitions = []
    for column in source["columns"]:
        key = " PRIMARY KEY" if column == source.get("primary_key") else ""
        definitions.append(f'"{column}" {_column_type(column)}{key}')
    table = source["table"]
    conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute(f"CREATE TABLE {table} ({', '.join(definitions)})")
    for column in source["indexes"]:
        conn.execute(f'CREATE INDEX {table}_{column.lower()} ON {table} ("{column}")')


def _column_type(column):
    if column in INTEGER_COLUMNS:
        return "INTEGER"
    if column in REAL_COLUMNS:
        return "REAL"
    return "TEXT"


def _insert(conn, source):
    quoted = ", ".join(f'"{column}"' for column in source["columns"])
    placeholders = ", ".join("?" for _ in source["columns"])
    conn.executemany(
        f"INSERT INTO {source['table']} ({quoted}) VALUES ({placeholders})",
        source["rows"],
    )
