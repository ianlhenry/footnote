import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resolve the sqlite file the app reads and writes.
// Returns its absolute path. DATABASE_PATH overrides the default
// data/papertrail.sqlite, and a relative path is taken from the repo root.
export function databasePath(): string {
  const configured = process.env.DATABASE_PATH || "data/papertrail.sqlite";
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

let shared: DatabaseSync | undefined;

// One read-only connection for answering questions, opened on first use.
// Returns that shared connection.
export function readOnlyDatabase(): DatabaseSync {
  shared ??= connect({ readOnly: true });
  return shared;
}

// Open the papertrail sqlite file and load the vector extension.
// readOnly: when true, skip creating the parent directory and refuse writes.
// Returns the open connection with foreign keys enabled.
export function connect({ readOnly = false } = {}): DatabaseSync {
  const file = databasePath();
  if (!readOnly) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file, { allowExtension: true, readOnly });
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  return db;
}
