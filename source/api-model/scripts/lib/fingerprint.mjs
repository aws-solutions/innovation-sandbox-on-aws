// Directory walking and the input/output fingerprints the generation cache
// relies on.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { usesBrazilGradle } from "./gradle.mjs";
import {
  clientDir,
  modelDir,
  modelJson,
  openapiJson,
  projections,
  stampFile,
} from "./paths.mjs";

// Inputs whose change must force regeneration. The wrapper properties, launcher
// and jar are included because a Gradle version or launcher change can change
// generator behaviour, and all three are committed and therefore mutable. The
// build scripts are hashed separately by walking `scripts/`, so a change to any
// script module busts the cache.
const inputFiles = [
  "build.gradle.kts",
  "gradle.properties",
  "settings.gradle.kts",
  "smithy-build.json",
  "gradle/wrapper/gradle-wrapper.jar.sha256",
  "gradle/wrapper/gradle-wrapper.properties",
  "gradle/wrapper/gradle-wrapper.jar",
  "gradle-version",
  "gradlew",
];

/**
 * Lists files under dir, sorted, without following symlinks.
 *
 * `prune` is called with each directory's path relative to the walk root; when it
 * returns true that subtree is never read. Pruning during the walk rather than
 * filtering afterwards matters for `outputFingerprint`, whose root is an npm
 * workspace: `node_modules` there holds tens of thousands of paths that would
 * otherwise be built and discarded on every `smithy:prepare`.
 *
 * @param {string} dir
 * @param {(path: string) => boolean} [prune]
 * @param {string} [root]
 * @returns {string[]}
 */
export function walk(dir, prune = () => false, root = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) return [];
      const full = join(dir, entry.name);
      if (!entry.isDirectory()) return [full];
      return prune(relative(root, full)) ? [] : walk(full, prune, root);
    });
}

/** Hash of every input whose change should force regeneration. */
export function inputHash(root = modelDir, env = process.env) {
  const hash = createHash("sha256");
  // run-gradlew rewrites the wrapper properties with a workspace-local URL, so
  // hashing them under Brazil would differ per workspace and never cache-hit.
  const names = inputFiles.filter((file) =>
    usesBrazilGradle(env)
      ? !file.endsWith("gradle-wrapper.properties")
      : file !== "gradle-version",
  );
  const files = [
    ...names.map((f) => join(root, f)),
    ...walk(join(root, "src/main/smithy")),
    // `compatibility-exceptions.json` lives under scripts/ but is config for
    // verify:compatibility, not a codegen input — exclude it so editing an
    // exception does not force a regenerate. Match the exact path, not a suffix,
    // so a future similarly-named file is not excluded by accident.
    ...walk(join(root, "scripts")).filter(
      (f) => f !== join(root, "scripts", "compatibility-exceptions.json"),
    ),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

/** Fingerprint of published output, so a partial copy cannot be trusted. */
export function outputFingerprint(dir = clientDir) {
  // Prune on any path *segment*: the merged server package nests build output as
  // `<domain>/dist-cjs`, so matching only the root-relative path would let compiled
  // output be hashed as generated source (the flat client dir is `dist-cjs`).
  const files = walk(dir, (path) =>
    path
      .split(/[/\\]/)
      .some(
        (segment) => segment === "node_modules" || segment.startsWith("dist-"),
      ),
  ).filter((file) => !relative(dir, file).endsWith(".tsbuildinfo"));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update(readFileSync(file));
  }
  return { count: files.length, sha256: hash.digest("hex") };
}

/**
 * Removes the previous Smithy projections before regeneration. Gradle's Smithy
 * task overwrites generated files but does not remove files for operations that
 * disappeared from the model, so publishing an uncleared projection can retain
 * stale commands even though the destination is replaced atomically.
 */
export function clearProjection(dir = projections) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * True when the stamp matches both current inputs and the output actually on
 * disk. A stamp alone is not sufficient: a run interrupted between copy and
 * stamp, or a partially deleted client, must force regeneration.
 */
export function isUpToDate(
  hash,
  stampPath = stampFile,
  dir = clientDir,
  outputName = undefined,
  requireSrc = true,
) {
  if (!existsSync(stampPath)) return false;
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return false;
  }
  if (stamp.inputs !== hash) return false;
  // The client dir must have `src`: `publish`'s invariant is that an interrupted
  // run cannot leave it truncated, so a missing `src` must force regeneration. The
  // merged server dir has no top-level `src` (each domain nests its own), so
  // `package.json` presence is the equivalent guard there.
  const hasOutput = requireSrc
    ? existsSync(join(dir, "src"))
    : existsSync(join(dir, "package.json"));
  if (!hasOutput) return false;
  const actual = outputFingerprint(dir);
  const expected = outputName ? stamp.outputs?.[outputName] : stamp.output;
  return expected?.count === actual.count && expected?.sha256 === actual.sha256;
}

/**
 * Content fingerprint of the aggregate `model.json` projection. This artifact is
 * consumed by the parity suite but lives outside the client/server output dirs
 * `outputFingerprint` covers, so it is fingerprinted separately (by content, not
 * mtime — a rebase or checkout can touch timestamps without changing content).
 */
export function modelFingerprint(modelJsonPath = modelJson) {
  const hash = createHash("sha256");
  hash.update(readFileSync(modelJsonPath));
  return { sha256: hash.digest("hex") };
}

/**
 * True when the stamp's inputs match `hash` AND the aggregate `model.json` on disk
 * matches the stamped model fingerprint. Lets the cache skip only when the model
 * projection the parity suite reads is provably current — a client/server hit is
 * not enough, because a skip that leaves `model.json` stale/missing would false-green
 * the parity suite. A missing stamp, missing model.json, or fingerprint mismatch all
 * force regeneration.
 */
export function isModelUpToDate(
  hash,
  stampPath = stampFile,
  modelJsonPath = modelJson,
) {
  if (!existsSync(stampPath)) return false;
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return false;
  }
  if (stamp.inputs !== hash) return false;
  if (!existsSync(modelJsonPath)) return false;
  return (
    stamp.outputs?.model?.sha256 === modelFingerprint(modelJsonPath).sha256
  );
}

/**
 * True when the stamp's inputs match `hash` AND the aggregate OpenAPI on disk
 * matches the stamped OpenAPI fingerprint. The OpenAPI is a separate artifact the
 * doc/tag parity suite reads directly; unlike inputs (covered by `inputHash`), a
 * post-generation modification/corruption of the emitted document leaves inputs
 * unchanged, so a client/server/model hit is not enough — this guard catches a
 * stale-but-parseable OpenAPI and forces regeneration. Mirrors `isModelUpToDate`.
 */
export function isOpenapiUpToDate(
  hash,
  stampPath = stampFile,
  openapiJsonPath = openapiJson,
) {
  if (!existsSync(stampPath)) return false;
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return false;
  }
  if (stamp.inputs !== hash) return false;
  if (!existsSync(openapiJsonPath)) return false;
  return (
    stamp.outputs?.openapi?.sha256 === modelFingerprint(openapiJsonPath).sha256
  );
}
