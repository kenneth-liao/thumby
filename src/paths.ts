/**
 * Path containment — the one home for the escape check that project-scoped
 * reads and writes obey. Two forms, because callers face two situations:
 *
 * - `outsideDir` is lexical: it decides where a path *would* land, so it is
 *   the form for output paths that do not exist yet (`render --out`,
 *   `guidelines --out`, the compare artifacts). It can be fooled by a symlink
 *   alias — callers writing files pair it with identity comparison after the
 *   fact (`fsIdentity` in src/manifest.ts).
 * - `escapesDirReal` is for a file that exists: realpaths both root and file
 *   (the src/assets.ts project-asset precedent), so an in-project symlink
 *   targeting an out-of-tree file fails the gate — a relocatable bundle can
 *   never reach past its own directory, even through an alias.
 */
import path from "node:path";
import { realpath } from "node:fs/promises";

/** True when `target` escapes `dir` lexically — the rule output paths obey. */
export const outsideDir = (dir: string, target: string): boolean => {
  const relative = path.relative(dir, target);
  return relative.startsWith("..") || path.isAbsolute(relative);
};

/**
 * True when the existing file `target` escapes `dir` once symlinks are
 * resolved. Callers must have established existence already (a failed
 * `readFile`); `realpath` errors here are real I/O failures, not absence,
 * and propagate.
 */
export async function escapesDirReal(dir: string, target: string): Promise<boolean> {
  const [realDir, realFile] = await Promise.all([realpath(dir), realpath(target)]);
  const rel = path.relative(realDir, realFile);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
}
