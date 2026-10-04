from .fec import ingest_fec
from .marist import ingest_marist
from .pew import ingest_pew


def run(dry_run=False):
    ingest_fec(dry_run=dry_run)
    ingest_marist(dry_run=dry_run)
    ingest_pew(dry_run=dry_run)
