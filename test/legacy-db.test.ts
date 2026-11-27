import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateLegacyDb } from "../src/legacy-db.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kh-legacy-"));

test("renames jobhunt.db and its wal/shm files", () => {
  const d = tmp();
  for (const s of ["", "-wal", "-shm"]) writeFileSync(path.join(d, `jobhunt.db${s}`), `old${s}`);
  assert.equal(migrateLegacyDb(d), true);
  for (const s of ["", "-wal", "-shm"]) {
    assert.equal(readFileSync(path.join(d, `kindahired.db${s}`), "utf8"), `old${s}`);
    assert.equal(existsSync(path.join(d, `jobhunt.db${s}`)), false);
  }
});

test("leaves an existing kindahired.db alone", () => {
  const d = tmp();
  writeFileSync(path.join(d, "jobhunt.db"), "old");
  writeFileSync(path.join(d, "kindahired.db"), "new");
  assert.equal(migrateLegacyDb(d), false);
  assert.equal(readFileSync(path.join(d, "kindahired.db"), "utf8"), "new");
  assert.equal(existsSync(path.join(d, "jobhunt.db")), true);
});

test("does nothing on a fresh install", () => {
  const d = tmp();
  assert.equal(migrateLegacyDb(d), false);
  assert.equal(existsSync(path.join(d, "kindahired.db")), false);
});
