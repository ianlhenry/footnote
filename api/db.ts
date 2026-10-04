import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function databasePath(): string {
  const configured = process.env.DATABASE_PATH || "data/papertrail.sqlite";
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

export function connect({ readOnly = false } = {}): DatabaseSync {
  const file = databasePath();
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { allowExtension: true, readOnly });
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  return db;
}
