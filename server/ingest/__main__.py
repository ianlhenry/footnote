import argparse
import sys

from server.ingest import CORPUS_SOURCES, SOURCES, IngestError, run

parser = argparse.ArgumentParser(description="Load FEC, Marist, and Pew data.")
parser.add_argument(
    "--source",
    action="append",
    choices=SOURCES,
    help="Load only this source. Repeat for several. Default: all of them.",
)
parser.add_argument(
    "--no-write",
    action="store_true",
    help=(
        "Print the rows and passages that would be written. Do not change the database "
        "or call Voyage. Uncached pages are still fetched and cached."
    ),
)
parser.add_argument(
    "--refetch",
    action="store_true",
    help="Download Marist and Pew pages again instead of reading the cache.",
)
parser.add_argument(
    "--rebuild-corpus",
    action="store_true",
    help=(
        "When the corpus tables do not match the code, recreate them with Marist and "
        "Pew embedded again. Both must be loaded in the same run."
    ),
)
args = parser.parse_args()
# Keep the order given, without repeats.
sources = list(dict.fromkeys(args.source or SOURCES))
if not set(sources) & set(CORPUS_SOURCES):
    for flag, value in (("--refetch", args.refetch), ("--rebuild-corpus", args.rebuild_corpus)):
        if value:
            parser.error(f"{flag} only applies to {' and '.join(CORPUS_SOURCES)}")
try:
    failed = run(
        sources=sources,
        no_write=args.no_write,
        refetch=args.refetch,
        rebuild=args.rebuild_corpus,
    )
except IngestError as error:
    parser.error(str(error))
if failed:
    print(f"Failed: {', '.join(failed)}.")
    sys.exit(1)
