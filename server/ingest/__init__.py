from .fec import ingest_fec
from .marist import ingest_marist
from .pew import ingest_pew


def run():
    ingest_fec()
    ingest_marist()
    ingest_pew()
