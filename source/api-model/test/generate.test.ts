// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the codegen publishing script. These cover the cache and
 * publish logic against real temporary directories rather than mocked fs, so a
 * regression in the ordering or atomicity guarantees fails here.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../scripts/generate.mjs";
import { serverDomains } from "../scripts/lib/domains.mjs";
import {
  clearProjection,
  inputHash,
  isModelUpToDate,
  isOpenapiUpToDate,
  isUpToDate,
  outputFingerprint,
  walk,
} from "../scripts/lib/fingerprint.mjs";
import {
  assertGradleVersionsAgree,
  assertGradleWrapperIntegrity,
  brazilGradleVersion,
  gradleCommand,
  hasExecutable,
  publicGradleVersion,
  saveBrazilMutatedFiles,
  underBrazil,
  usesBrazilGradle,
} from "../scripts/lib/gradle.mjs";
import { acquireLock, onExit } from "../scripts/lib/lifecycle.mjs";
import {
  assertManifestMatchesBootstrap,
  publish,
  publishServer,
  rewriteManifest,
  validateServerManifest,
} from "../scripts/lib/publish.mjs";

/** This package's own directory, for checks against the committed files. */
const modelRoot = join(import.meta.dirname, "..");
const repoRoot = join(modelRoot, "..", "..");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "isb-api-model-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A PATH directory under tmp containing an executable run-gradlew, so the
 * capability predicate (usesBrazilGradle) sees the Brazil launcher as available.
 * `variant` lets a single test provision distinct dirs. On win32 the launcher
 * needs a PATHEXT extension to be resolvable.
 */
function runGradlewBin(variant = "", platform = "linux") {
  const bin = join(tmp, `brazil-bin${variant}`);
  mkdirSync(bin, { recursive: true });
  const name = platform === "win32" ? "run-gradlew.CMD" : "run-gradlew";
  const launcher = join(bin, name);
  writeFileSync(launcher, "");
  if (platform !== "win32") chmodSync(launcher, 0o755);
  return bin;
}

/** Brazil env whose PATH actually contains run-gradlew (capability present). */
function brazilEnv() {
  return { BRAZIL_PACKAGE_NAME: "pkg", PATH: runGradlewBin() };
}

/** Builds a directory shaped like the codegen projection output. */
function fakeProjection(
  dir: string,
  files: Record<string, string>,
  name = "@amzn/innovation-sandbox-api-client",
) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.1",
      scripts: {
        build: "concurrently 'yarn:build:cjs' 'yarn:build:es'",
        prepack: "yarn run clean && yarn run build",
      },
      devDependencies: {
        "@tsconfig/node20": "20.1.8",
        "@types/node": "^20.14.8",
        concurrently: "7.0.0",
        "downlevel-dts": "0.10.1",
        premove: "4.0.0",
        rimraf: "^3.0.0",
        typescript: "~5.8.3",
      },
      main: "./dist-cjs/index.js",
      module: "./dist-es/index.js",
      types: "./dist-types/index.d.ts",
      typesVersions: {
        "<4.5": {
          "dist-types/*": ["dist-types/ts3.4/*"],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"extends":"@tsconfig/node20/tsconfig.json"}',
  );
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, "src", name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
}

function fakeServerProjection(dir: string, files: Record<string, string>) {
  fakeProjection(dir, files, "@amzn/innovation-sandbox-api-server");
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = {
    "@aws-smithy/server-common": "1.0.0-alpha.10",
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

describe("serverDomains", () => {
  it("derives a sorted domain list from server projections only", () => {
    writeFileSync(
      join(tmp, "smithy-build.json"),
      JSON.stringify({
        projections: {
          "server-leases": {},
          aggregate: {},
          "server-accounts": {},
        },
      }),
    );

    expect(serverDomains(tmp)).toEqual(["accounts", "leases"]);
  });

  it("rejects a server projection with a path-unsafe domain", () => {
    writeFileSync(
      join(tmp, "smithy-build.json"),
      JSON.stringify({ projections: { "server-../leases": {} } }),
    );

    expect(() => serverDomains(tmp)).toThrow(
      'invalid server projection name "server-../leases"',
    );
  });
});

describe("walk", () => {
  it("lists files recursively in a stable order", () => {
    mkdirSync(join(tmp, "b"), { recursive: true });
    writeFileSync(join(tmp, "z.ts"), "z");
    writeFileSync(join(tmp, "a.ts"), "a");
    writeFileSync(join(tmp, "b", "c.ts"), "c");

    const first = walk(tmp);
    const second = walk(tmp);

    expect(first).toEqual(second);
    expect(first.map((f: string) => f.replace(`${tmp}/`, ""))).toEqual([
      "a.ts",
      "b/c.ts",
      "z.ts",
    ]);
  });

  it("returns an empty list for a missing directory", () => {
    expect(walk(join(tmp, "absent"))).toEqual([]);
  });

  it("does not read a pruned subtree", () => {
    mkdirSync(join(tmp, "node_modules/deep"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/deep/x.ts"), "x");
    writeFileSync(join(tmp, "a.ts"), "a");
    const prune = vi.fn((path: string) => path === "node_modules");

    expect(
      walk(tmp, prune).map((f: string) => f.replace(`${tmp}/`, "")),
    ).toEqual(["a.ts"]);
    // Never descended, so `deep` was never even listed.
    expect(prune.mock.calls.map(([path]) => path)).toEqual(["node_modules"]);
  });
});

describe("outputFingerprint", () => {
  it("covers the published sources and nothing that npm or tsc produces", () => {
    // `node_modules` and `dist-*` are installed and compiled from the sources,
    // so including them would make the stamp depend on an install rather than on
    // codegen. `.tsbuildinfo` is a compiler cache with an absolute-path payload.
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "node_modules/dep"), { recursive: true });
    mkdirSync(join(tmp, "dist-es"), { recursive: true });
    writeFileSync(join(tmp, "src/index.ts"), "export {}");
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "node_modules/dep/index.js"), "module.exports={}");
    writeFileSync(join(tmp, "dist-es/index.js"), "export {}");
    writeFileSync(join(tmp, "tsconfig.tsbuildinfo"), "{}");

    expect(outputFingerprint(tmp).count).toBe(2);
  });
});

describe("inputHash", () => {
  it("changes when a model source changes", () => {
    mkdirSync(join(tmp, "src/main/smithy"), { recursive: true });
    writeFileSync(join(tmp, "src/main/smithy/main.smithy"), '$version: "2"');
    const before = inputHash(tmp);

    writeFileSync(
      join(tmp, "src/main/smithy/main.smithy"),
      '$version: "2"\n// edited',
    );

    expect(inputHash(tmp)).not.toBe(before);
  });

  it("changes when the Gradle wrapper properties change", () => {
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=gradle-8.10-bin.zip",
    );
    const before = inputHash(tmp, {});

    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=gradle-8.11-bin.zip",
    );

    // A Gradle version change can change generator output, so it must not be
    // served from cache.
    expect(inputHash(tmp, {})).not.toBe(before);
  });

  it("changes when a centralized dependency version changes", () => {
    writeFileSync(join(tmp, "gradle.properties"), "smithyVersion=1.72.0\n");
    const before = inputHash(tmp);

    writeFileSync(join(tmp, "gradle.properties"), "smithyVersion=1.73.0\n");

    expect(inputHash(tmp)).not.toBe(before);
  });

  it("changes when the committed wrapper jar changes", () => {
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(tmp, "gradle/wrapper/gradle-wrapper.jar"), "jar-v1");
    const before = inputHash(tmp);

    writeFileSync(join(tmp, "gradle/wrapper/gradle-wrapper.jar"), "jar-v2");

    expect(inputHash(tmp)).not.toBe(before);
  });

  it("is stable across repeated calls with unchanged inputs", () => {
    mkdirSync(join(tmp, "src/main/smithy"), { recursive: true });
    writeFileSync(join(tmp, "src/main/smithy/main.smithy"), "model");

    expect(inputHash(tmp)).toBe(inputHash(tmp));
  });

  it("excludes scripts/compatibility-exceptions.json but hashes other scripts", () => {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts/generate.mjs"), "// codegen");
    writeFileSync(
      join(tmp, "scripts/compatibility-exceptions.json"),
      '{"exceptions": []}',
    );
    const before = inputHash(tmp);

    // The exceptions allowlist is verify:compatibility config, not a codegen
    // input, so editing it must not bust the generation cache.
    writeFileSync(
      join(tmp, "scripts/compatibility-exceptions.json"),
      '{"exceptions": [{"id":"x","shape":"a#B","reason":"reasoned","expires":"2099-01-01"}]}',
    );
    expect(inputHash(tmp)).toBe(before);

    // A real script change still busts the cache.
    writeFileSync(join(tmp, "scripts/generate.mjs"), "// codegen edited");
    expect(inputHash(tmp)).not.toBe(before);
  });

  it("excludes only the exact path, not a similarly named script file", () => {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts/my-compatibility-exceptions.json"), "v1");
    const before = inputHash(tmp);

    // A suffix match would have wrongly excluded this; the exact-path filter
    // keeps hashing it.
    writeFileSync(join(tmp, "scripts/my-compatibility-exceptions.json"), "v2");
    expect(inputHash(tmp)).not.toBe(before);
  });
});

describe("publish", () => {
  it("replaces the target wholesale so a removed file cannot survive", () => {
    const from = join(tmp, "projection");
    const to = join(tmp, "client");
    fakeProjection(from, { "keep.ts": "keep" });
    mkdirSync(join(to, "src"), { recursive: true });
    writeFileSync(join(to, "src", "stale.ts"), "stale");

    publish(from, to);

    expect(existsSync(join(to, "src", "keep.ts"))).toBe(true);
    expect(existsSync(join(to, "src", "stale.ts"))).toBe(false);
  });

  it("carries node_modules across the replace", () => {
    const from = join(tmp, "projection");
    const to = join(tmp, "client");
    fakeProjection(from, { "index.ts": "x" });
    mkdirSync(join(to, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(to, "node_modules", "dep", "index.js"), "dep");

    publish(from, to);

    // Losing node_modules would leave the workspace member uninstallable
    // without a full npm install.
    expect(existsSync(join(to, "node_modules", "dep", "index.js"))).toBe(true);
    expect(existsSync(join(to, "src", "index.ts"))).toBe(true);
  });

  it("leaves no staging directory behind", () => {
    const from = join(tmp, "projection");
    const to = join(tmp, "client");
    fakeProjection(from, { "index.ts": "x" });

    publish(from, to);

    const leftovers = walk(tmp).filter((f: string) => f.includes(".staging-"));
    expect(leftovers).toEqual([]);
  });
});

describe("publishServer diagnostics", () => {
  const root = () => join(tmp, "projections");
  const target = () => join(tmp, "server");

  function writeCommittedManifest(contents = "{}") {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "package.json"), contents);
  }

  it("rejects an empty server-domain list", () => {
    expect(() => publishServer([], root(), target())).toThrow(
      /no server domains/,
    );
  });

  it("reports an unreadable committed server manifest", () => {
    writeCommittedManifest("{ truncated");

    expect(() => publishServer(["leases"], root(), target())).toThrow(
      /could not read the committed server manifest/,
    );
  });

  it("reports a server projection with no generated sources", () => {
    writeCommittedManifest();

    expect(() => publishServer(["leases"], root(), target())).toThrow(
      /expected generated server sources for leases/,
    );
  });

  it("reports an unreadable generated server manifest", () => {
    writeCommittedManifest();
    const generated = join(root(), "server-leases/typescript-ssdk-codegen");
    mkdirSync(join(generated, "src"), { recursive: true });
    writeFileSync(join(generated, "package.json"), "{ truncated");

    expect(() => publishServer(["leases"], root(), target())).toThrow(
      /could not read generated server manifest for leases/,
    );
  });
});

describe("clearProjection", () => {
  it("removes stale generated operations before Gradle regenerates", () => {
    const projection = join(tmp, "build/smithyprojections/model/source");
    mkdirSync(join(projection, "typescript-client-codegen/src/commands"), {
      recursive: true,
    });
    writeFileSync(
      join(
        projection,
        "typescript-client-codegen/src/commands/RemovedOperationCommand.ts",
      ),
      "stale",
    );

    clearProjection(projection);

    expect(existsSync(projection)).toBe(false);
  });
});

describe("rewriteManifest", () => {
  it("replaces yarn-based scripts and marks the package private", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, {});

    rewriteManifest(dir);

    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    // yarn is not available in this repo, so a yarn-prefixed script would fail
    // the workspace build.
    expect(JSON.stringify(manifest.scripts)).not.toContain("yarn");
    expect(manifest.scripts.build).toBe(
      "tsc -p tsconfig.cjs.json && tsc -p tsconfig.es.json && " +
        "tsc -p tsconfig.types.json",
    );
    expect(manifest.devDependencies).toEqual({
      "@tsconfig/node20": "20.1.8",
      "@types/node": "^20.14.8",
      typescript: "~5.8.3",
    });
    expect(manifest.typesVersions).toBeUndefined();
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.private).toBe(true);
  });

  it("builds every module format advertised by the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "source/api-client/package.json"), "utf8"),
    );
    expect(manifest.main).toBe("./dist-cjs/index.js");
    expect(manifest.scripts.build).toContain("tsconfig.cjs.json");
    expect(manifest.module).toBe("./dist-es/index.js");
    expect(manifest.scripts.build).toContain("tsconfig.es.json");
    expect(manifest.types).toBe("./dist-types/index.d.ts");
    expect(manifest.scripts.build).toContain("tsconfig.types.json");
  });

  it("throws a diagnostic when the generated manifest is unreadable", () => {
    const dir = join(tmp, "client");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");

    expect(() => rewriteManifest(dir)).toThrow(/could not read/);
  });
});

describe("validateServerManifest", () => {
  const committed = {
    exports: {
      "./lease-templates": {
        types: "./dist-types/lease-templates/index.d.ts",
        default: "./dist-cjs/lease-templates/index.js",
      },
    },
    dependencies: {
      tslib: "^2.6.2",
      "@aws-smithy/server-common": "npm:@smithy/server-common@0.1.6",
      "@smithy/types": "^4.16.1",
    },
  };
  const generated = (
    domain: string,
    dependencies: Record<string, string> = {
      tslib: "^2.6.2",
      "@aws-smithy/server-common": "1.0.0-alpha.10",
      "@smithy/types": "^4.16.1",
    },
  ) => ({ domain, manifest: { dependencies } });

  it("accepts a committed manifest that matches codegen's requirements", () => {
    expect(() =>
      validateServerManifest(
        committed,
        [generated("lease-templates")],
        ["lease-templates"],
      ),
    ).not.toThrow();
  });

  it("requires an exports entry per registered domain and no extras", () => {
    expect(() =>
      validateServerManifest(
        committed,
        [generated("lease-templates"), generated("leases")],
        ["lease-templates", "leases"],
      ),
    ).toThrow(/exports .* do not match the registered domains/);
  });

  it("pins each export to the conventional CJS + types paths", () => {
    const drifted = {
      ...committed,
      exports: {
        "./lease-templates": {
          types: "./dist-types/lease-templates/index.d.ts",
          // ESM condition or wrong path must be rejected, not silently kept.
          default: "./dist-es/lease-templates/index.js",
        },
      },
    };
    expect(() =>
      validateServerManifest(
        drifted,
        [generated("lease-templates")],
        ["lease-templates"],
      ),
    ).toThrow(/export \.\/lease-templates must be/);
  });

  it("fails when codegen requires a dependency the manifest lacks", () => {
    expect(() =>
      validateServerManifest(
        committed,
        [
          generated("lease-templates", {
            tslib: "^2.6.2",
            "@aws-smithy/server-common": "1.0.0-alpha.10",
            "@smithy/types": "^4.16.1",
            "@smithy/util-stream": "^4.0.0",
          }),
        ],
        ["lease-templates"],
      ),
    ).toThrow(/@smithy\/util-stream.*does not declare/);
  });

  it("fails on a version mismatch and on a stale declared dependency", () => {
    expect(() =>
      validateServerManifest(
        committed,
        [
          generated("lease-templates", {
            tslib: "^2.7.0",
            "@aws-smithy/server-common": "1.0.0-alpha.10",
            "@smithy/types": "^4.16.1",
          }),
        ],
        ["lease-templates"],
      ),
    ).toThrow(/tslib@\^2\.7\.0 but the server manifest declares \^2\.6\.2/);

    expect(() =>
      validateServerManifest(
        committed,
        [
          generated("lease-templates", {
            "@aws-smithy/server-common": "1.0.0-alpha.10",
            "@smithy/types": "^4.16.1",
          }),
        ],
        ["lease-templates"],
      ),
    ).toThrow(/tslib that no domain's codegen requires/);
  });

  it("rejects unreviewed generated server runtime drift", () => {
    expect(() =>
      validateServerManifest(
        committed,
        [
          generated("lease-templates", {
            "@aws-smithy/server-common": "2.0.0",
          }),
        ],
        ["lease-templates"],
      ),
    ).toThrow(/unexpected generated server runtime 2\.0\.0/);
  });

  it("fails when two domains pin conflicting versions", () => {
    // Both exports entries present so the check reaches dependency reconciliation.
    const twoDomains = {
      ...committed,
      exports: {
        ...committed.exports,
        "./leases": {
          types: "./dist-types/leases/index.d.ts",
          default: "./dist-cjs/leases/index.js",
        },
      },
    };
    expect(() =>
      validateServerManifest(
        twoDomains,
        [
          generated("lease-templates", { tslib: "^2.6.2" }),
          generated("leases", { tslib: "^2.7.0" }),
        ],
        ["lease-templates", "leases"],
      ),
    ).toThrow(/leases pins tslib@\^2\.7\.0, conflicting with \^2\.6\.2/);
  });
});

describe("generated bootstrap manifests", () => {
  it("matches the generated manifest after rewriting", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, {});
    rewriteManifest(dir);
    const bootstrap = readFileSync(join(dir, "package.json"), "utf8");

    expect(() => assertManifestMatchesBootstrap(bootstrap, dir)).not.toThrow();

    const changed = JSON.parse(bootstrap);
    changed.dependencies = { "@smithy/types": "999.0.0" };
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    expect(() => assertManifestMatchesBootstrap(bootstrap, dir)).toThrow(
      /differs from the checked-in bootstrap/,
    );
  });

  it("is synchronized with the root lockfile and its Smithy runtime", () => {
    const lockfile = JSON.parse(
      readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
    );
    for (const packagePath of ["source/api-client", "source/api-server"]) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, packagePath, "package.json"), "utf8"),
      );
      const lock = lockfile.packages[packagePath];

      for (const field of [
        "name",
        "version",
        "license",
        "dependencies",
        "devDependencies",
        "engines",
      ]) {
        expect(lock[field]).toEqual(manifest[field]);
      }

      const smithyDependencies = Object.keys(manifest.dependencies).filter(
        (name) => name.startsWith("@smithy/"),
      );
      for (const name of smithyDependencies) {
        expect(lockfile.packages[`node_modules/${name}`]).toBeDefined();
      }
      expect(
        Object.keys(lockfile.packages).filter((path) =>
          path.startsWith(`${packagePath}/node_modules/@smithy/`),
        ),
      ).toEqual([]);
    }

    // Codegen still emits the former package name. The npm alias provides the
    // current runtime API without rewriting generated imports.
    expect(
      lockfile.packages["node_modules/@aws-smithy/server-common"].name,
    ).toBe("@smithy/server-common");
    expect(
      lockfile.packages["node_modules/@aws-smithy/server-common"].version,
    ).toBe("0.1.6");
    expect(lockfile.packages["node_modules/@smithy/types"].version).toMatch(
      /^4\./,
    );
  });
});

describe("underBrazil", () => {
  it("is true when BRAZIL_PACKAGE_NAME is set", () => {
    expect(
      underBrazil({ BRAZIL_PACKAGE_NAME: "Innovation-sandbox-on-aws" }),
    ).toBe(true);
  });

  it("is false when BRAZIL_PACKAGE_NAME is absent or empty", () => {
    expect(underBrazil({})).toBe(false);
    expect(underBrazil({ BRAZIL_PACKAGE_NAME: "" })).toBe(false);
  });
});

describe("usesBrazilGradle", () => {
  it("is true when BRAZIL_PACKAGE_NAME is set and run-gradlew is on PATH", () => {
    expect(
      usesBrazilGradle({ BRAZIL_PACKAGE_NAME: "pkg", PATH: runGradlewBin() }),
    ).toBe(true);
  });

  it("is false when BRAZIL_PACKAGE_NAME is set but run-gradlew is absent", () => {
    // The AWS Solutions publishing farm injects BRAZIL_PACKAGE_NAME without any
    // Brazil tooling, so run-gradlew is not on PATH.
    expect(
      usesBrazilGradle({
        BRAZIL_PACKAGE_NAME: "pkg",
        PATH: join(tmp, "empty"),
      }),
    ).toBe(false);
  });

  it("is false off Brazil even when run-gradlew happens to be on PATH", () => {
    expect(usesBrazilGradle({ PATH: runGradlewBin("-2") })).toBe(false);
  });
});

describe("hasExecutable", () => {
  it("resolves a name against PATH entries", () => {
    const bin = runGradlewBin("-hx");
    expect(hasExecutable("run-gradlew", { PATH: bin }, "linux")).toBe(true);
    expect(
      hasExecutable("run-gradlew", { PATH: join(tmp, "empty") }, "linux"),
    ).toBe(false);
  });

  it("rejects a non-executable file on a POSIX PATH", () => {
    const bin = join(tmp, "non-executable-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "run-gradlew"), "");

    expect(hasExecutable("run-gradlew", { PATH: bin }, "linux")).toBe(false);
  });
});

describe("gradleCommand", () => {
  it("uses run-gradlew under Brazil when it is on PATH, regardless of platform", () => {
    // The committed wrapper fetches from services.gradle.org, which the Brazil
    // fleet cannot reach, so the workspace-local run-gradlew is preferred there.
    expect(
      gradleCommand(
        { BRAZIL_PACKAGE_NAME: "pkg", PATH: runGradlewBin("-lin") },
        "linux",
      ),
    ).toBe("run-gradlew");
    expect(
      gradleCommand(
        { BRAZIL_PACKAGE_NAME: "pkg", PATH: runGradlewBin("-win", "win32") },
        "win32",
      ),
    ).toBe("run-gradlew");
  });

  it("falls back to the committed wrapper when BRAZIL_PACKAGE_NAME is set but run-gradlew is absent", () => {
    // Solutions publishing farm: BRAZIL_PACKAGE_NAME present, no run-gradlew.
    // Must not pick a launcher that fails with spawnSync ENOENT.
    const env = { BRAZIL_PACKAGE_NAME: "pkg", PATH: join(tmp, "empty") };
    expect(gradleCommand(env, "linux")).toBe("./gradlew");
    expect(gradleCommand(env, "win32")).toBe("gradlew.bat");
  });

  it("uses the committed wrapper off Brazil", () => {
    expect(gradleCommand({}, "linux")).toBe("./gradlew");
    expect(gradleCommand({}, "win32")).toBe("gradlew.bat");
  });
});

describe("assertGradleVersionsAgree", () => {
  const writePins = (dir: string, url: string, brazil?: string) => {
    mkdirSync(join(dir, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(dir, "gradle/wrapper/gradle-wrapper.properties"), url);
    if (brazil !== undefined) {
      writeFileSync(join(dir, "gradle-version"), brazil);
    }
  };
  const publicUrl = (v: string, kind = "bin") =>
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${v}-${kind}.zip\n`;

  it("reads each path's pin", () => {
    writePins(tmp, publicUrl("8.10"), "8.10\n");

    expect(publicGradleVersion(tmp)).toBe("8.10");
    expect(brazilGradleVersion(tmp)).toBe("8.10");
  });

  it("accepts a Brazil prefix that resolves to a patch release", () => {
    // Brazil maps the 8.10 prefix onto gradle-8.10.2-all.zip.
    writePins(tmp, publicUrl("8.10.2"), "8.10\n");

    expect(() => assertGradleVersionsAgree(tmp)).not.toThrow();
  });

  it("throws when one path is bumped without the other", () => {
    writePins(tmp, publicUrl("8.11"), "8.10\n");

    // Silent drift would let the two paths generate with different toolchains.
    expect(() => assertGradleVersionsAgree(tmp)).toThrow(/pin drift/);
  });

  it("throws when the Brazil pin is bumped without the wrapper", () => {
    writePins(tmp, publicUrl("8.10"), "8.11\n");

    expect(() => assertGradleVersionsAgree(tmp)).toThrow(/pin drift/);
  });

  it("does not treat 8.1 as a prefix of 8.10", () => {
    writePins(tmp, publicUrl("8.10"), "8.1\n");

    expect(() => assertGradleVersionsAgree(tmp)).toThrow(/pin drift/);
  });

  it("is inert when either pin is absent", () => {
    // The public path has no gradle-version file; that is not drift.
    writePins(tmp, publicUrl("8.10"));
    expect(() => assertGradleVersionsAgree(tmp)).not.toThrow();
    expect(brazilGradleVersion(tmp)).toBe(null);
  });

  it("parses an -all distribution as well as -bin", () => {
    writePins(tmp, publicUrl("8.10.2", "all"), "8.10\n");

    expect(publicGradleVersion(tmp)).toBe("8.10.2");
    expect(() => assertGradleVersionsAgree(tmp)).not.toThrow();
  });

  it("agrees for the versions actually committed in this package", () => {
    // Guards the real files, so a bump to one pin fails here.
    expect(() => assertGradleVersionsAgree(modelRoot)).not.toThrow();
  });
});

describe("assertGradleWrapperIntegrity", () => {
  const sha256 = (contents: string) =>
    createHash("sha256").update(contents).digest("hex");
  const writeWrapper = (dir: string, contents: string, checksum: string) => {
    mkdirSync(join(dir, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(dir, "gradle/wrapper/gradle-wrapper.jar"), contents);
    writeFileSync(
      join(dir, "gradle/wrapper/gradle-wrapper.jar.sha256"),
      `${checksum}\n`,
    );
  };

  it("accepts a wrapper that matches its published checksum", () => {
    writeWrapper(tmp, "wrapper", sha256("wrapper"));

    expect(() => assertGradleWrapperIntegrity(tmp)).not.toThrow();
  });

  it("rejects a wrapper jar changed without its checksum", () => {
    writeWrapper(tmp, "wrapper", sha256("wrapper"));
    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.jar"),
      "different-wrapper",
    );

    expect(() => assertGradleWrapperIntegrity(tmp)).toThrow(
      /checksum mismatch/,
    );
  });

  it("rejects a missing or malformed published checksum", () => {
    expect(() => assertGradleWrapperIntegrity(tmp)).toThrow(
      /integrity files are missing/,
    );

    writeWrapper(tmp, "wrapper", "not-a-sha256");
    expect(() => assertGradleWrapperIntegrity(tmp)).toThrow(/malformed/);
  });

  it("matches the published Gradle digest committed in this package", () => {
    expect(() => assertGradleWrapperIntegrity(modelRoot)).not.toThrow();
    expect(
      readFileSync(
        join(modelRoot, "gradle/wrapper/gradle-wrapper.jar.sha256"),
        "utf8",
      ).trim(),
    ).toBe("2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046");
  });
});

describe("Gradle repository routing", () => {
  const settings = readFileSync(join(modelRoot, "settings.gradle.kts"), "utf8");
  const build = readFileSync(join(modelRoot, "build.gradle.kts"), "utf8");

  it("uses Maven Central only when PeruGradle has not supplied WIRE", () => {
    expect(settings).toContain('extra.has("wireReadRepositoryUrl")');
    expect(settings).toMatch(
      /if \(!wireReadRepositoryAvailable\)\s*\{\s*mavenCentral\(\)/,
    );
  });

  it("rejects project repositories that would override WIRE", () => {
    expect(settings).toContain("RepositoriesMode.FAIL_ON_PROJECT_REPOS");
    expect(build).not.toMatch(/\brepositories\s*\{/);
  });
});

describe("public build runtime contract", () => {
  const buildspec = readFileSync(join(repoRoot, "buildspec.yml"), "utf8");
  const preCommit = readFileSync(
    join(repoRoot, ".pre-commit-config.yaml"),
    "utf8",
  );
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const notice = readFileSync(join(repoRoot, "NOTICE"), "utf8");
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const clientPackage = JSON.parse(
    readFileSync(join(repoRoot, "source/api-client/package.json"), "utf8"),
  );
  const serverPackage = JSON.parse(
    readFileSync(join(repoRoot, "source/api-server/package.json"), "utf8"),
  );
  const openSourceBuild = readFileSync(
    join(repoRoot, "deployment/build-open-source-dist.sh"),
    "utf8",
  );

  it("keeps Node 24 and Java 21 aligned across public build declarations", () => {
    expect(readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim()).toBe("24");
    expect(rootPackage.engines.node).toBe(">=24.0.0 <25.0.0");
    expect(buildspec).toMatch(
      /runtime-versions:\s+nodejs: 24\s+java: corretto21/,
    );
    expect(readme).toContain("- Node 24");
    expect(readme).toContain("- Java 21 (Amazon Corretto 21 recommended)");
    expect(publicGradleVersion(modelRoot)).toBe("8.10");
    for (const generatedPackage of [clientPackage, serverPackage]) {
      expect(generatedPackage.devDependencies.typescript).toMatch(/^~5\./);
      expect(
        generatedPackage.devDependencies["@tsconfig/node20"],
      ).toBeDefined();
      expect(generatedPackage.devDependencies["@types/node"]).toMatch(
        /^\^20\./,
      );
      expect(generatedPackage.engines.node).toBe(">=20.0.0");
    }
    // Node 20 is the generated library's compatibility floor; the repository
    // still builds and tests it with the Node 24 runtime asserted above.
    expect(notice).not.toContain("@tsconfig/node16");
    for (const dependency of ["@smithy/server-common", "re2-wasm"]) {
      expect(notice).toContain(`${dependency} under the Apache-2.0 license.`);
    }
  });

  it("prepares both ignored generated packages before root tests", () => {
    expect(rootPackage.scripts.pretest).toBe("npm run smithy:prepare");
    expect(rootPackage.scripts["smithy:prepare"]).toBe(
      "npm run smithy:generate && npm run build --workspace @amzn/innovation-sandbox-api-client --workspace @amzn/innovation-sandbox-api-server",
    );
  });

  it("keeps Brazil-only build inputs out of the public archive", () => {
    for (const excluded of [
      "brazil.ion",
      "build-tools",
      "internal",
      "source/api-model/gradle-version",
    ]) {
      expect(openSourceBuild).toContain(`"${excluded}"`);
    }
  });

  it("runs the internal C2J drift gate without exposing npm targets", () => {
    expect(rootPackage.scripts["generate:c2j"]).toBeUndefined();
    expect(rootPackage.scripts["verify:c2j-drift"]).toBeUndefined();
    expect(preCommit).toContain("entry: scripts/m2m/verify-c2j-drift.sh");
    expect(openSourceBuild).not.toContain('delete pkg.scripts["generate:c2j"]');
  });

  it("keeps generated bootstrap manifests in the public source archive", () => {
    expect(openSourceBuild).toContain(
      "generated package manifests are deliberately included",
    );
    for (const packagePath of ["api-client", "api-server"]) {
      expect(openSourceBuild).not.toMatch(
        new RegExp(`^\\s*"source/${packagePath}/package\\.json"\\s*\\\\`, "m"),
      );
    }
    expect(readme).toContain(
      "source distribution intentionally includes the bootstrap manifests",
    );
  });
});

describe("C2J pre-commit wrapper", () => {
  const wrapperSource = readFileSync(
    join(repoRoot, "scripts/m2m/verify-c2j-drift.sh"),
    "utf8",
  );

  function installWrapper() {
    const wrapper = join(tmp, "scripts/m2m/verify-c2j-drift.sh");
    mkdirSync(join(tmp, "scripts/m2m/internal"), { recursive: true });
    writeFileSync(wrapper, wrapperSource);
    return wrapper;
  }

  function runWrapper(wrapper: string, path: string) {
    return spawnSync("/bin/bash", [wrapper], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
  }

  it("skips when the internal generator is absent", () => {
    const result = runWrapper(installWrapper(), "/usr/bin:/bin");

    expect(result.status).toBe(0);
  });

  it("fails clearly when an internal checkout lacks Brazil", () => {
    const wrapper = installWrapper();
    const generator = join(tmp, "scripts/m2m/internal/generate-c2j.sh");
    writeFileSync(generator, "#!/bin/sh\nexit 0\n");
    chmodSync(generator, 0o755);

    const result = runWrapper(wrapper, "/usr/bin:/bin");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Brazil is required");
  });

  it("delegates to the generator's drift check", () => {
    const wrapper = installWrapper();
    const bin = join(tmp, "bin");
    const generator = join(tmp, "scripts/m2m/internal/generate-c2j.sh");
    mkdirSync(bin);
    writeFileSync(join(bin, "brazil"), "#!/bin/sh\nexit 0\n");
    writeFileSync(generator, '#!/bin/sh\nprintf "%s\\n" "$*"\n');
    chmodSync(join(bin, "brazil"), 0o755);
    chmodSync(generator, 0o755);

    const result = runWrapper(wrapper, `${bin}:/usr/bin:/bin`);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("--check");
  });
});

describe("saveBrazilMutatedFiles", () => {
  /** Writes the two files run-gradlew is known to mutate. */
  function brazilFixture(dir: string) {
    mkdirSync(join(dir, "gradle/wrapper"), { recursive: true });
    writeFileSync(
      join(dir, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/gradle-8.10-bin.zip\ndistributionSha256Sum=abc123\n",
    );
    writeFileSync(join(dir, ".gitignore"), "build/\n");
  }

  const props = (dir: string) =>
    readFileSync(join(dir, "gradle/wrapper/gradle-wrapper.properties"), "utf8");

  it("restores the pinned checksum run-gradlew strips from the wrapper properties", () => {
    brazilFixture(tmp);
    const before = props(tmp);
    const restore = saveBrazilMutatedFiles(tmp);

    // What run-gradlew does: workspace-local URL, no distributionSha256Sum.
    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=file\\:/workspace/distros/gradle-8.10.2-all.zip\n",
    );
    restore();

    // Losing the checksum would silently unpin the distribution on the public
    // build path.
    expect(props(tmp)).toBe(before);
    expect(props(tmp)).toContain("distributionSha256Sum");
  });

  it("restores appended .gitignore entries", () => {
    brazilFixture(tmp);
    const restore = saveBrazilMutatedFiles(tmp);

    writeFileSync(join(tmp, ".gitignore"), "build/\n.gradle-home/\n");
    restore();

    expect(readFileSync(join(tmp, ".gitignore"), "utf8")).toBe("build/\n");
  });

  it("recreates a mutated file that was deleted outright", () => {
    brazilFixture(tmp);
    const restore = saveBrazilMutatedFiles(tmp);

    rmSync(join(tmp, ".gitignore"));
    restore();

    expect(readFileSync(join(tmp, ".gitignore"), "utf8")).toBe("build/\n");
  });

  it("leaves untouched files alone and ignores absent ones", () => {
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(tmp, "gradle/wrapper/gradle-wrapper.properties"), "x");

    // No .gitignore present: capturing must not throw, and restore must not
    // create one.
    const restore = saveBrazilMutatedFiles(tmp);
    expect(() => restore()).not.toThrow();
    expect(existsSync(join(tmp, ".gitignore"))).toBe(false);
    expect(props(tmp)).toBe("x");
  });
});

describe("onExit", () => {
  /** Minimal stand-in for process, so no real signal handlers are installed. */
  function fakeProcess() {
    const handlers = new Map<string, (() => void)[]>();
    const killed: string[] = [];
    return {
      pid: 4242,
      killed,
      once(event: string, fn: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
      removeListener(event: string, fn: () => void) {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((f) => f !== fn),
        );
      },
      kill(_pid: number, signal: string) {
        killed.push(signal);
      },
      emit(event: string) {
        for (const fn of [...(handlers.get(event) ?? [])]) fn();
      },
      count: (event: string) => (handlers.get(event) ?? []).length,
    };
  }

  it("runs cleanup once on the normal path", () => {
    const proc = fakeProcess();
    let calls = 0;
    const cleanup = onExit(() => calls++, proc);

    cleanup();
    cleanup();

    expect(calls).toBe(1);
  });

  it("runs cleanup when the process is signalled", () => {
    const proc = fakeProcess();
    let calls = 0;
    onExit(() => calls++, proc);

    // try/finally does not unwind on a signal, so without a handler an
    // interrupted build would leave the wrapper properties unpinned.
    proc.emit("SIGINT");

    expect(calls).toBe(1);
    // Re-raised so the caller observes a signal exit, not a plain status.
    expect(proc.killed).toEqual(["SIGINT"]);
  });

  it("handles SIGTERM and SIGHUP as well as SIGINT", () => {
    for (const signal of ["SIGTERM", "SIGHUP"]) {
      const proc = fakeProcess();
      let calls = 0;
      onExit(() => calls++, proc);

      proc.emit(signal);

      expect(calls).toBe(1);
      expect(proc.killed).toEqual([signal]);
    }
  });

  it("does not run cleanup twice when a signal follows the normal path", () => {
    const proc = fakeProcess();
    let calls = 0;
    const cleanup = onExit(() => calls++, proc);

    cleanup();
    proc.emit("SIGTERM");

    // Restoring a second time after the build already finished could clobber a
    // file the build legitimately rewrote.
    expect(calls).toBe(1);
  });

  it("runs cleanup on exit when neither path ran", () => {
    const proc = fakeProcess();
    let calls = 0;
    onExit(() => calls++, proc);

    proc.emit("exit");

    expect(calls).toBe(1);
  });

  it("detaches the exit listener once cleanup has run", () => {
    const proc = fakeProcess();
    const cleanup = onExit(() => {}, proc);

    expect(proc.count("exit")).toBe(1);
    cleanup();

    // A retained listener would leak across repeated main() calls in-process.
    expect(proc.count("exit")).toBe(0);
    expect(proc.count("SIGINT")).toBe(0);
    expect(proc.count("SIGTERM")).toBe(0);
    expect(proc.count("SIGHUP")).toBe(0);
  });

  it("still detaches and re-raises when cleanup throws on a signal", () => {
    const proc = fakeProcess();
    onExit(() => {
      throw new Error("restore failed");
    }, proc);

    // A throwing cleanup must not strand the signal: detach and the re-raise run
    // in a finally. In production `kill` then terminates with the default
    // disposition; the fake only records it, so the cleanup error still surfaces.
    expect(() => proc.emit("SIGINT")).toThrow(/restore failed/);

    expect(proc.killed).toEqual(["SIGINT"]);
    expect(proc.count("exit")).toBe(0);
    expect(proc.count("SIGINT")).toBe(0);
  });

  it("propagates a normal-path cleanup error after detaching listeners", () => {
    const proc = fakeProcess();
    const cleanup = onExit(() => {
      throw new Error("restore failed");
    }, proc);

    // The build should see the failure, but the listeners must be gone so a
    // later exit/signal cannot double-run.
    expect(() => cleanup()).toThrow(/restore failed/);
    expect(proc.count("exit")).toBe(0);
    expect(proc.count("SIGTERM")).toBe(0);
  });
});

describe("inputHash under Brazil", () => {
  it("ignores the wrapper properties run-gradlew rewrites per workspace", () => {
    const brazil = brazilEnv();
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=file\\:/workspace-a/gradle-8.10.2-all.zip",
    );
    const before = inputHash(tmp, brazil);

    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=file\\:/workspace-b/gradle-8.10.2-all.zip",
    );

    // The rewritten URL is workspace-specific, so hashing it would never
    // cache-hit across workspaces.
    expect(inputHash(tmp, brazil)).toBe(before);
    // Off Brazil the same change must still bust the cache.
    expect(inputHash(tmp, {})).not.toBe(before);
  });

  it("still hashes model sources and the wrapper jar under Brazil", () => {
    const brazil = brazilEnv();
    mkdirSync(join(tmp, "src/main/smithy"), { recursive: true });
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(tmp, "src/main/smithy/main.smithy"), "model");
    writeFileSync(join(tmp, "gradle/wrapper/gradle-wrapper.jar"), "jar-v1");
    const before = inputHash(tmp, brazil);

    writeFileSync(join(tmp, "src/main/smithy/main.smithy"), "model-edited");
    const afterModel = inputHash(tmp, brazil);
    expect(afterModel).not.toBe(before);

    writeFileSync(join(tmp, "gradle/wrapper/gradle-wrapper.jar"), "jar-v2");
    expect(inputHash(tmp, brazil)).not.toBe(afterModel);
  });

  it("hashes only the build path's own Gradle selector", () => {
    const brazil = brazilEnv();
    writeFileSync(join(tmp, "gradle-version"), "8.10\n");
    const brazilBefore = inputHash(tmp, brazil);
    const publicBefore = inputHash(tmp, {});

    writeFileSync(join(tmp, "gradle-version"), "8.10.2\n");

    expect(inputHash(tmp, brazil)).not.toBe(brazilBefore);
    // The public path selects Gradle through wrapper properties, not this
    // Brazil-only file, which is excluded from the public archive.
    expect(inputHash(tmp, {})).toBe(publicBefore);
  });

  it("follows the public path when BRAZIL_PACKAGE_NAME is set but run-gradlew is absent", () => {
    // Solutions farm: BRAZIL_PACKAGE_NAME present, no run-gradlew. The fingerprint
    // must track the launcher gradleCommand actually picks (the public wrapper),
    // so the wrapper properties ARE a codegen input here — unlike a real Brazil
    // build, where run-gradlew rewrites them per workspace and they are excluded.
    const farm = { BRAZIL_PACKAGE_NAME: "pkg", PATH: join(tmp, "empty") };
    mkdirSync(join(tmp, "gradle/wrapper"), { recursive: true });
    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=gradle-8.10-bin.zip",
    );
    const before = inputHash(tmp, farm);

    writeFileSync(
      join(tmp, "gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=gradle-8.11-bin.zip",
    );

    expect(inputHash(tmp, farm)).not.toBe(before);
  });
});

describe("isUpToDate", () => {
  const stampFor = (dir: string, inputs: string) =>
    JSON.stringify({ inputs, output: outputFingerprint(dir) });

  it("is up to date when inputs and output both match", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, stampFor(dir, "hash-1"));

    expect(isUpToDate("hash-1", stamp, dir)).toBe(true);
  });

  it("is stale when the inputs hash differs", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, stampFor(dir, "hash-1"));

    expect(isUpToDate("hash-2", stamp, dir)).toBe(false);
  });

  it("is stale when output files were removed after stamping", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a", "b.ts": "b" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, stampFor(dir, "hash-1"));

    rmSync(join(dir, "src", "b.ts"));

    // A partial client must be regenerated, not served from cache.
    expect(isUpToDate("hash-1", stamp, dir)).toBe(false);
  });

  it("is stale when output file contents changed after stamping", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, stampFor(dir, "hash-1"));

    writeFileSync(join(dir, "src", "a.ts"), "tampered");

    expect(isUpToDate("hash-1", stamp, dir)).toBe(false);
  });

  it("is stale when the client directory is gone", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, stampFor(dir, "hash-1"));

    rmSync(dir, { recursive: true, force: true });

    expect(isUpToDate("hash-1", stamp, dir)).toBe(false);
  });

  it("is stale when no stamp exists", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });

    expect(isUpToDate("hash-1", join(tmp, "absent.json"), dir)).toBe(false);
  });

  it("is stale when the stamp is corrupt", () => {
    const dir = join(tmp, "client");
    fakeProjection(dir, { "a.ts": "a" });
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, "{ truncated");

    expect(isUpToDate("hash-1", stamp, dir)).toBe(false);
  });

  it("is stale after an interrupted publish leaves output without a stamp", () => {
    const from = join(tmp, "projection");
    const dir = join(tmp, "client");
    fakeProjection(from, { "a.ts": "a" });
    cpSync(from, dir, { recursive: true });

    // publish() stamps only after the copy completes, so a run interrupted in
    // between leaves the cache cold.
    expect(isUpToDate("hash-1", join(tmp, "stamp.json"), dir)).toBe(false);
  });
});

describe("generated artifact cache stamps", () => {
  it("treats a malformed model stamp as stale", () => {
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, "{ truncated");

    expect(isModelUpToDate("hash-1", stamp, join(tmp, "model.json"))).toBe(
      false,
    );
  });

  it("treats a malformed OpenAPI stamp as stale", () => {
    const stamp = join(tmp, "stamp.json");
    writeFileSync(stamp, "{ truncated");

    expect(isOpenapiUpToDate("hash-1", stamp, join(tmp, "openapi.json"))).toBe(
      false,
    );
  });
});

describe("main", () => {
  it("generates, publishes, stamps, and then serves the output from cache", () => {
    const root = join(tmp, "model");
    const client = join(tmp, "api-client");
    const server = join(tmp, "api-server");
    const build = join(root, "build");
    const generated = join(
      build,
      "smithyprojections/isb-api-model/aggregate/typescript-client-codegen",
    );
    const generatedServer = join(
      build,
      "smithyprojections/isb-api-model/server-lease-templates/typescript-ssdk-codegen",
    );
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "gradle/wrapper"), { recursive: true });
    writeFileSync(join(root, "gradle/wrapper/gradle-wrapper.jar"), "wrapper");
    writeFileSync(
      join(root, "gradle/wrapper/gradle-wrapper.jar.sha256"),
      `${createHash("sha256").update("wrapper").digest("hex")}\n`,
    );
    fakeProjection(client, {});
    rewriteManifest(client);

    // The server manifest is committed, not generated: provide the shell that
    // `validateServerManifest` holds codegen to (an exports entry per domain and
    // exactly the generated deps, with the runtime alias).
    mkdirSync(server, { recursive: true });
    writeFileSync(
      join(server, "package.json"),
      `${JSON.stringify(
        {
          name: "@amzn/innovation-sandbox-api-server",
          exports: {
            "./lease-templates": {
              types: "./dist-types/lease-templates/index.d.ts",
              default: "./dist-cjs/lease-templates/index.js",
            },
          },
          dependencies: {
            "@aws-smithy/server-common": "npm:@smithy/server-common@0.1.6",
          },
        },
        null,
        2,
      )}\n`,
    );
    const modelJson = join(
      build,
      "smithyprojections/isb-api-model/aggregate/model/model.json",
    );
    const openapiJsonPath = join(
      build,
      "smithyprojections/isb-api-model/aggregate/openapi/IsbApi.openapi.json",
    );
    // Codegen writes both the aggregate model.json and the aggregate OpenAPI; the
    // cache now fingerprints both, so the fake gradle run must produce both.
    const writeAggregate = () => {
      mkdirSync(join(modelJson, ".."), { recursive: true });
      writeFileSync(modelJson, '{"smithy":"2.0","shapes":{}}');
      mkdirSync(join(openapiJsonPath, ".."), { recursive: true });
      writeFileSync(openapiJsonPath, '{"openapi":"3.0.2","paths":{}}');
    };
    const spawn = vi.fn(() => {
      fakeProjection(generated, { "index.ts": "generated" });
      fakeServerProjection(generatedServer, { "index.ts": "generated-server" });
      // The aggregate model projection the cache now fingerprints (and the parity
      // suite reads); codegen writes it, so the fake gradle run must too.
      writeAggregate();
      return { status: 0 };
    });
    // Publish target under tmp so the test never writes the real docs/ contract.
    const publishedOpenapiJson = join(build, "published", "openapi.json");
    const options = {
      modelDir: root,
      clientDir: client,
      buildDir: build,
      env: {},
      serverDir: server,
      domains: ["lease-templates"],
      platform: "linux",
      spawnSync: spawn,
      onExit: (cleanup: () => void) => cleanup,
      publishedOpenapiJson,
    };

    expect(main(options)).toBe(0);
    expect(spawn).toHaveBeenCalledWith("./gradlew", ["build"], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    expect(readFileSync(join(client, "src/index.ts"), "utf8")).toBe(
      "generated",
    );
    // Non-mutating by default: without --write-docs, the tracked contract is not
    // written, so a normal build/CI never dirties `docs/`.
    expect(existsSync(publishedOpenapiJson)).toBe(false);
    expect(existsSync(join(build, ".generate-inputs.json"))).toBe(true);
    expect(existsSync(join(build, ".generate.lock"))).toBe(false);
    // Only the generated sources land, under domains/<domain>/; the committed
    // shell (package.json) is untouched.
    expect(
      readFileSync(join(server, "domains/lease-templates/index.ts"), "utf8"),
    ).toBe("generated-server");
    expect(
      JSON.parse(readFileSync(join(server, "package.json"), "utf8")).name,
    ).toBe("@amzn/innovation-sandbox-api-server");

    expect(main({ ...options, spawnSync: vi.fn() })).toBe(0);

    // A stale/drifted aggregate model.json forces regeneration even though the
    // client and server outputs still match — the gap this fingerprint closes
    // (a skip must not leave the parity suite reading a stale model).
    writeFileSync(modelJson, '{"smithy":"2.0","shapes":{"drift":{}}}');
    const respawn = vi.fn(() => {
      fakeProjection(generated, { "index.ts": "generated" });
      fakeServerProjection(generatedServer, { "index.ts": "generated-server" });
      writeAggregate();
      return { status: 0 };
    });
    expect(main({ ...options, spawnSync: respawn })).toBe(0);
    expect(respawn).toHaveBeenCalled();

    // Deletion (not only drift) forces regeneration: `isModelUpToDate` must fail
    // on a missing model.json, exercising its `existsSync` branch — a skip here
    // would leave the parity suite with no projection to read.
    rmSync(modelJson);
    const respawnAfterDelete = vi.fn(() => {
      fakeProjection(generated, { "index.ts": "generated" });
      fakeServerProjection(generatedServer, { "index.ts": "generated-server" });
      writeAggregate();
      return { status: 0 };
    });
    expect(main({ ...options, spawnSync: respawnAfterDelete })).toBe(0);
    expect(respawnAfterDelete).toHaveBeenCalled();

    // A stale/drifted aggregate OpenAPI likewise forces regeneration even though
    // client/server/model still match — the gap `isOpenapiUpToDate` closes so a
    // skip cannot leave the doc/tag parity suite reading a stale OpenAPI.
    writeFileSync(openapiJsonPath, '{"openapi":"3.0.2","paths":{"drift":{}}}');
    const respawnAfterOpenapiDrift = vi.fn(() => {
      fakeProjection(generated, { "index.ts": "generated" });
      fakeServerProjection(generatedServer, { "index.ts": "generated-server" });
      writeAggregate();
      return { status: 0 };
    });
    expect(main({ ...options, spawnSync: respawnAfterOpenapiDrift })).toBe(0);
    expect(respawnAfterOpenapiDrift).toHaveBeenCalled();

    // `--write-docs` publishes the tracked contract, and never takes the fast
    // cache-hit path: even though inputs are unchanged here, it regenerates under
    // the lock and copies from the fresh projection (no lock-free cache-hit copy).
    const respawnWriteDocs = vi.fn(() => {
      fakeProjection(generated, { "index.ts": "generated" });
      fakeServerProjection(generatedServer, { "index.ts": "generated-server" });
      writeAggregate();
      return { status: 0 };
    });
    expect(
      main({ ...options, writeDocs: true, spawnSync: respawnWriteDocs }),
    ).toBe(0);
    expect(respawnWriteDocs).toHaveBeenCalled();
    expect(readFileSync(publishedOpenapiJson, "utf8")).toBe(
      readFileSync(openapiJsonPath, "utf8"),
    );
  });
});

describe("acquireLock", () => {
  it("rejects a concurrent holder and can be released idempotently", () => {
    const build = join(tmp, "build");
    const lock = join(build, "generate.lock");
    const release = acquireLock(build, lock);

    expect(() => acquireLock(build, lock)).toThrow(
      /another generation is in progress/,
    );
    release();
    release();

    expect(() => acquireLock(build, lock)()).not.toThrow();
  });
});
