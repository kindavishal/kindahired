import { existsSync, renameSync } from "node:fs";
import path from "node:path";

// The database used to be called jobhunt.db. Rename it (and its WAL/SHM files) to kindahired.db
// before it is opened, only when the new name is not already there.
export function migrateLegacyDb(dir: string): boolean {
  const next = path.join(dir, "kindahired.db");
  const old = path.join(dir, "jobhunt.db");
  if (existsSync(next) || !existsSync(old)) return false;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(old + suffix)) renameSync(old + suffix, next + suffix);
  }
  return true;
}
