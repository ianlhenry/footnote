import argparse

from server.ingest import run

parser = argparse.ArgumentParser(description="Load FEC, Marist, and Pew data.")
parser.add_argument(
    "--dry-run",
    action="store_true",
    help="Print the rows and passages that would be written. Do not change the database.",
)
args = parser.parse_args()
run(dry_run=args.dry_run)
