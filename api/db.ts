import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolves the sqlite file the app reads and writes.
 *
 * @returns Its absolute path. DATABASE_PATH overrides the default data/footnote.sqlite, and a
 * relative path is taken from the repo root.
 */
export function databasePath(): string {
  const configured = process.env.DATABASE_PATH || "data/footnote.sqlite";
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

let shared: DatabaseSync | undefined;

/**
 * One read-only connection for answering questions, opened on first use.
 *
 * @returns That shared connection.
 */
export function readOnlyDatabase(): DatabaseSync {
  shared ??= connect({ readOnly: true });
  return shared;
}

/**
 * Opens the footnote sqlite file and loads the vector extension.
 *
 * @param readOnly - When true, skip creating the parent directory and refuse writes.
 * @returns The open connection with foreign keys enabled.
 */
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
