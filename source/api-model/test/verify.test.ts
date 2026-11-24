// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  evaluateCompatibility,
  loadExceptions,
  normalizeReference,
  parseCsv,
  parseDiffEvents,
  verifyCompatibility,
} from "../scripts/lib/compatibility.mjs";
import { gradleCommand } from "../scripts/lib/gradle.mjs";
import { parseArguments as parseCompatibilityArgs } from "../scripts/verify-compatibility.mjs";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "isb-api-verify-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

const header =
  "severity,id,shape,file,line,column,message,hint,suppressionReason";
const localGradle = gradleCommand({});

describe("reference", () => {
  it("normalizes supported git branch forms", () => {
    expect(normalizeReference("refs/heads/dev/v1.3.1")).toEqual({
      kind: "branch",
      name: "dev/v1.3.1",
      remoteRef: "refs/heads/dev/v1.3.1",
      localRef: "refs/remotes/origin/dev/v1.3.1",
    });
    expect(normalizeReference("origin/mainline")).toEqual({
      kind: "branch",
      name: "mainline",
      remoteRef: "refs/heads/mainline",
      localRef: "refs/remotes/origin/mainline",
    });
  });

  it("accepts tags only as explicit refs/tags references", () => {
    expect(normalizeReference("refs/tags/v1.3.0")).toEqual({
      kind: "tag",
      name: "v1.3.0",
      remoteRef: "refs/tags/v1.3.0",
      localRef: "refs/tags/v1.3.0",
    });
    expect(normalizeReference("v1.3.0")).toMatchObject({
      kind: "branch",
      name: "v1.3.0",
    });
  });

  it("rejects unsupported or unsafe ref syntax", () => {
    for (const reference of [
      "../main",
      "main..old",
      "main^{tree}",
      "-main",
      "refs/tags/",
      "refs/pull/123",
    ]) {
      expect(() => normalizeReference(reference)).toThrow(/invalid/);
    }
    expect(() => normalizeReference()).toThrow(/--reference/);
  });
});

describe("Smithy diff policy", () => {
  it("parses final CSV rows and rejects unterminated quoted fields", () => {
    expect(parseCsv("one,two")).toEqual([["one", "two"]]);
    expect(() => parseCsv('"unterminated')).toThrow(/unterminated/);
  });

  it("parses quoted Smithy CSV fields without human-output assumptions", () => {
    const events = parseDiffEvents(
      `${header}\n` +
        '"DANGER","RemovedShape","com.example#Old","old.smithy",4,2,' +
        '"Removed, and ""gone""\nacross two lines","",""\n' +
        "FAILURE: Validated 20 shapes, including dependencies (DANGER: 1)\n",
    );

    expect(events).toEqual([
      expect.objectContaining({
        severity: "DANGER",
        id: "RemovedShape",
        shape: "com.example#Old",
        message: 'Removed, and "gone"\nacross two lines',
      }),
    ]);
  });

  it("rejects malformed event rows but ignores non-CSV Gradle output", () => {
    expect(() => parseDiffEvents("BUILD FAILED\n")).toThrow(/CSV header/);
    expect(
      parseDiffEvents(
        `${header}\nGradle warning, with commas\nBUILD SUCCESSFUL\n`,
      ),
    ).toEqual([]);
    expect(() =>
      parseDiffEvents(
        `${header}\n` +
          '"DANGER","RemovedShape","com.example#Old","old.smithy",4,2,' +
          '"missing fields"\n',
      ),
    ).toThrow(/7 fields/);
  });

  it("allows only an exact event id and shape exception", () => {
    const event = {
      severity: "DANGER",
      id: "RemovedShape",
      shape: "com.example#Old",
    };
    const exact = {
      id: "RemovedShape",
      shape: "com.example#Old",
      reason: "Approved compatibility bridge",
      expires: "2099-01-01",
    };

    expect(evaluateCompatibility([event], [exact])).toMatchObject({
      blocked: [],
      unused: [],
    });
    expect(
      evaluateCompatibility([event], [{ ...exact, shape: "com.example#*" }]),
    ).toMatchObject({
      blocked: [event],
      unused: [{ ...exact, shape: "com.example#*" }],
    });
  });

  it("rejects expired and broad exceptions", () => {
    const file = join(tmp, "exceptions.json");
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: "RemovedShape",
            shape: "com.example#Old",
            reason: "Temporary migration approval",
            expires: "2026-08-04",
          },
        ],
      }),
    );
    expect(() =>
      loadExceptions(file, new Date("2026-08-05T00:00:00Z")),
    ).toThrow(/expired/);

    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: "*",
            shape: "com.example#Old",
            reason: "Too broad to identify one event",
            expires: "2099-01-01",
          },
        ],
      }),
    );
    expect(() => loadExceptions(file)).toThrow(/invalid or too broad/);
  });

  it("rejects unreadable, malformed, and duplicate exception policies", () => {
    const file = join(tmp, "exceptions.json");
    expect(() => loadExceptions(file)).toThrow(/could not read/);

    writeFileSync(file, '{"exceptions":[],"unexpected":true}');
    expect(() => loadExceptions(file)).toThrow(/only an exceptions array/);

    const exception = {
      id: "RemovedShape",
      shape: "com.example#Old",
      reason: "Temporary migration approval",
      expires: "2099-01-01",
    };
    writeFileSync(
      file,
      JSON.stringify({ exceptions: [{ ...exception, ticket: "ABC-123" }] }),
    );
    expect(() => loadExceptions(file)).toThrow(/requires exactly/);

    writeFileSync(file, JSON.stringify({ exceptions: [exception, exception] }));
    expect(() => loadExceptions(file)).toThrow(/duplicate/);
  });

  it("loads the committed exceptions from the default scripts/ path", () => {
    // Guards the file's location: with no argument, loadExceptions resolves the
    // committed scripts/compatibility-exceptions.json. A move or rename that
    // missed the path constant would throw "could not read" here.
    expect(() => loadExceptions()).not.toThrow();
  });
});

describe("reference-tip compatibility", () => {
  it("reports subprocess launch and nonzero-exit failures", () => {
    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: join(tmp, "source/api-model"),
        reference: "mainline",
        env: {},
        runner: vi.fn(() => ({ error: new Error("spawn denied") })),
      }),
    ).toThrow(/could not run git: spawn denied/);

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: join(tmp, "source/api-model"),
        reference: "mainline",
        env: {},
        runner: vi.fn(() => ({
          status: 2,
          stdout: "",
          stderr: Buffer.from("remote unavailable"),
        })),
      }),
    ).toThrow(/fetching reference.*remote unavailable/);
  });

  it("stops on a stale reference before reading or diffing any model", () => {
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") return result(1);
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: join(tmp, "source/api-model"),
        reference: "mainline",
        env: {},
        runner,
      }),
    ).toThrow(/not an ancestor/);
    expect(runner.mock.calls.some(([, args]) => args[0] === "ls-tree")).toBe(
      false,
    );
    expect(runner.mock.calls.some(([command]) => command === localGradle)).toBe(
      false,
    );
  });

  it("records no prior baseline only after fetch and ancestry succeed", () => {
    const log = vi.fn();
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") return result();
      if (command === "git" && args[0] === "ls-tree") return result();
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: join(tmp, "source/api-model"),
        reference: "mainline",
        env: {},
        runner,
        log,
      }),
    ).toMatchObject({
      skipped: true,
      reference: { kind: "branch", name: "mainline" },
      ref: "refs/remotes/origin/mainline",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("exact reference"),
    );
    expect(runner).toHaveBeenCalledWith(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/mainline:refs/remotes/origin/mainline",
      ],
      { cwd: tmp, encoding: "utf8" },
    );
  });

  it("fetches and compares an explicit tag reference", () => {
    const log = vi.fn();
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") {
        expect(args[2]).toBe("refs/tags/v1.3.0");
        return result();
      }
      if (command === "git" && args[0] === "ls-tree") return result();
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: join(tmp, "source/api-model"),
        reference: "refs/tags/v1.3.0",
        env: {},
        runner,
        log,
      }),
    ).toMatchObject({
      skipped: true,
      reference: { kind: "tag", name: "v1.3.0" },
      ref: "refs/tags/v1.3.0",
    });
    expect(runner).toHaveBeenCalledWith(
      "git",
      ["fetch", "--no-tags", "origin", "+refs/tags/v1.3.0:refs/tags/v1.3.0"],
      { cwd: tmp, encoding: "utf8" },
    );
  });

  it("passes a compatible fixture materialized from the exact remote ref", () => {
    const root = join(tmp, "source/api-model");
    const exceptions = join(root, "compatibility-exceptions.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(exceptions, '{"exceptions":[]}');

    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") return result();
      if (command === "git" && args[0] === "ls-tree") {
        return result(0, "source/api-model/src/main/smithy/main.smithy\n");
      }
      if (command === "git" && args[0] === "show") {
        expect(args[1]).toBe(
          "refs/remotes/origin/mainline:source/api-model/src/main/smithy/main.smithy",
        );
        return result(0, '$version: "2"\n');
      }
      if (command === localGradle) return result(0, `${header}\n`);
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: root,
        reference: "mainline",
        env: {},
        runner,
        exceptionsPath: exceptions,
        log: vi.fn(),
      }),
    ).toMatchObject({ skipped: false, blocked: [] });
  });

  it("surfaces CLI diagnostics when Smithy diff produces no CSV", () => {
    const root = join(tmp, "source/api-model");
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") return result();
      if (command === "git" && args[0] === "ls-tree") {
        return result(0, "source/api-model/src/main/smithy/main.smithy\n");
      }
      if (command === "git" && args[0] === "show") {
        return result(0, '$version: "2"\n');
      }
      if (command === localGradle) {
        return result(0, "", "Model load failed: unresolved trait dependency");
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: root,
        reference: "mainline",
        env: {},
        runner,
        log: vi.fn(),
      }),
    ).toThrow(/Model load failed: unresolved trait dependency/);
  });

  it("fails an incompatible fixture without an exact exception", () => {
    const root = join(tmp, "source/api-model");
    const exceptions = join(root, "compatibility-exceptions.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(exceptions, '{"exceptions":[]}');
    const danger =
      `${header}\n` +
      '"DANGER","RemovedShape","com.example#Old","old.smithy",1,1,' +
      '"Shape was removed","",""\n';
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "ls-tree") {
        return result(0, "source/api-model/src/main/smithy/main.smithy\n");
      }
      if (command === "git" && args[0] === "show") {
        return result(0, '$version: "2"\n');
      }
      if (command === localGradle) return result(0, danger);
      return result();
    });

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: root,
        reference: "mainline",
        env: {},
        runner,
        exceptionsPath: exceptions,
        log: vi.fn(),
      }),
    ).toThrow(/RemovedShape com\.example#Old/);
  });

  it("fails a compatibility exception once its event disappears", () => {
    const root = join(tmp, "source/api-model");
    const exceptions = join(root, "compatibility-exceptions.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      exceptions,
      JSON.stringify({
        exceptions: [
          {
            id: "RemovedShape",
            shape: "com.example#Old",
            reason: "Temporary migration approval",
            expires: "2099-01-01",
          },
        ],
      }),
    );
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "ls-tree") {
        return result(0, "source/api-model/src/main/smithy/main.smithy\n");
      }
      if (command === "git" && args[0] === "show") {
        return result(0, '$version: "2"\n');
      }
      if (command === localGradle) return result(0, `${header}\n`);
      return result();
    });

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: root,
        reference: "mainline",
        env: {},
        runner,
        exceptionsPath: exceptions,
        log: vi.fn(),
      }),
    ).toThrow(/unused compatibility exceptions/);
  });

  it("restores files mutated by a failing Brazil compatibility diff", () => {
    const root = join(tmp, "source/api-model");
    const properties = join(root, "gradle/wrapper/gradle-wrapper.properties");
    const gitignore = join(root, ".gitignore");
    mkdirSync(join(root, "gradle/wrapper"), { recursive: true });
    writeFileSync(properties, "distributionSha256Sum=published\n");
    writeFileSync(gitignore, "build/\n");
    const bin = join(tmp, "brazil-bin");
    const launcher = join(bin, "run-gradlew");
    mkdirSync(bin, { recursive: true });
    writeFileSync(launcher, "");
    chmodSync(launcher, 0o755);

    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "fetch") return result();
      if (command === "git" && args[0] === "merge-base") return result();
      if (command === "git" && args[0] === "ls-tree") {
        return result(0, "source/api-model/src/main/smithy/main.smithy\n");
      }
      if (command === "git" && args[0] === "show") {
        return result(0, '$version: "2"\n');
      }
      if (command === "run-gradlew") {
        writeFileSync(
          properties,
          "distributionUrl=file:/workspace/gradle.zip\n",
        );
        writeFileSync(gitignore, "build/\n.gradle-home/\n");
        return result(1, "", "compatibility diff failed");
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    expect(() =>
      verifyCompatibility({
        repoRoot: tmp,
        modelDir: root,
        reference: "mainline",
        env: {
          BRAZIL_PACKAGE_NAME: "Innovation-sandbox-on-aws",
          PATH: bin,
        },
        runner,
        log: vi.fn(),
        onExit: (cleanup: () => void) => cleanup,
      }),
    ).toThrow(/compatibility diff failed/);

    expect(readFileSync(properties, "utf8")).toBe(
      "distributionSha256Sum=published\n",
    );
    expect(readFileSync(gitignore, "utf8")).toBe("build/\n");
  });
});

describe("compatibility command line", () => {
  it("requires an explicit reference", () => {
    expect(() => parseCompatibilityArgs([])).toThrow(/--reference/);
  });

  it("returns the reference when given --reference", () => {
    expect(parseCompatibilityArgs(["--reference", "mainline"])).toEqual({
      reference: "mainline",
    });
  });

  it("rejects unknown arguments before running verification", () => {
    expect(() => parseCompatibilityArgs(["unsupported"])).toThrow(
      /unknown argument/,
    );
  });
});
