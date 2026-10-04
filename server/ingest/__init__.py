import traceback

from .articles import HTTPFailure, rebuild_articles
from .corpus import IngestError, needs_rebuild
from .fec import ingest_fec
from .marist import ingest_marist, read_release
from .pew import ingest_pew, read_page

SOURCES = ("fec", "marist", "pew")
# Sources stored in the shared corpus tables, with their labels and readers.
CORPUS_SOURCES = {
    "marist": ("Marist", read_release),
    "pew": ("Pew", read_page),
}


def run(sources=SOURCES, no_write=False, refetch=False, rebuild=False):
    """Load each source in turn. One source failing does not stop the others,
    except a Voyage key that is refused, which would fail every later source too.

    With rebuild, and corpus tables that do not match, every corpus source must
    be in sources. They are loaded together by rebuild_articles.

    Returns the sources that failed.
    """
    loaders = {
        "fec": lambda: ingest_fec(no_write=no_write),
        "marist": lambda: ingest_marist(no_write=no_write, refetch=refetch),
        "pew": lambda: ingest_pew(no_write=no_write, refetch=refetch),
    }
    corpus = [source for source in sources if source in CORPUS_SOURCES]
    if rebuild and corpus and needs_rebuild():
        missing = set(CORPUS_SOURCES) - set(corpus)
        if missing:
            raise IngestError(
                "--rebuild-corpus replaces every corpus source's documents. "
                f"Include {', '.join(sorted(missing))} in --source."
            )
        specs = [(source, *CORPUS_SOURCES[source]) for source in corpus]
        loaders["corpus"] = lambda: rebuild_articles(specs, no_write=no_write, refetch=refetch)
        sources = [source for source in sources if source not in CORPUS_SOURCES] + ["corpus"]

    failed = []
    for index, source in enumerate(sources):
        try:
            loaders[source]()
        except HTTPFailure as error:
            if error.code not in (401, 403):
                _report(source, error)
                failed.append(source)
                continue
            print(f"{source} failed: {error}. Voyage refused the key, so stopping.")
            failed.extend(sources[index:])
            break
        except Exception as error:
            _report(source, error)
            failed.append(source)
    return [name for source in failed for name in (corpus if source == "corpus" else [source])]


def _report(source, error):
    if not isinstance(error, IngestError):
        traceback.print_exc()
    print(f"{source} failed: {error}")
