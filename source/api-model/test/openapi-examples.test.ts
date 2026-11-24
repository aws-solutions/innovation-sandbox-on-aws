// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the parts of the published OpenAPI's examples that Smithy does NOT check
 * itself (Tasks 3.7c/3.7d):
 *
 *  1. `jsonAdd`-injected property examples — Smithy validates `@examples`-trait
 *     inputs/outputs at build time, but never the property examples injected via
 *     the openapi plugin's `jsonAdd`. AJV validates those against their schemas.
 *  2. `@examples` completeness — an entry with an `input` but no `output`/`error`
 *     passes Smithy's validator, yet the converter then emits a `{}` success
 *     response example that violates the response schema. Assert every entry
 *     declares `output` or `error`.
 *
 * (The general "does every emitted request/response example match its schema"
 * check is intentionally omitted — that is Smithy's own `@examples` validation.
 * The description-jargon policy check lives in `openapi-documentation.test.ts`.)
 */
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { modelJson, openapiJson } from "../scripts/lib/paths.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const oa: any = JSON.parse(readFileSync(openapiJson, "utf8"));
const model: any = JSON.parse(readFileSync(modelJson, "utf8"));
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;

// OpenAPI 3.0 schema objects use keywords JSON Schema draft-07 doesn't (`nullable`,
// `example`, `discriminator`, `x-*`); `strict: false` ignores them. Register the
// whole document so `$ref: oa#/components/...` resolves.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(oa, "oa");

/** JSON Pointer for a segment path, escaping `~` and `/` per RFC 6901. */
function pointer(segments: string[]): string {
  return (
    "/" +
    segments.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")
  );
}

const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();
function validate(
  segments: string[],
  value: unknown,
  ctx: string,
  bad: string[],
) {
  const ptr = pointer(segments);
  if (!validatorCache.has(ptr)) {
    validatorCache.set(ptr, ajv.compile({ $ref: `oa#${ptr}` }));
  }
  const check = validatorCache.get(ptr)!;
  if (!check(value)) bad.push(`${ctx}: ${ajv.errorsText(check.errors)}`);
}

describe("jsonAdd property examples validate against their schemas", () => {
  it("every schema/property example is valid", () => {
    const bad: string[] = [];
    for (const [name, schema] of Object.entries<any>(oa.components.schemas)) {
      if ("example" in schema) {
        validate(
          ["components", "schemas", name],
          schema.example,
          `schema ${name}`,
          bad,
        );
      }
      for (const [prop, pschema] of Object.entries<any>(
        schema.properties ?? {},
      )) {
        if ("example" in pschema) {
          validate(
            ["components", "schemas", name, "properties", prop],
            pschema.example,
            `${name}.${prop}`,
            bad,
          );
        }
      }
    }
    expect(bad, `\n${bad.join("\n")}`).toHaveLength(0);
  });
});

describe("@examples entries are complete", () => {
  it("every @examples entry declares output or error", () => {
    // Input-only entries emit an invalid `{}` success-response example (Smithy's
    // own validator lets them through), so require a modeled response.
    const bad: string[] = [];
    for (const [id, shape] of Object.entries<any>(model.shapes)) {
      const examples = shape.traits?.["smithy.api#examples"];
      if (!examples) continue;
      for (const entry of examples) {
        if (entry.output === undefined && entry.error === undefined) {
          bad.push(`${id} :: "${entry.title}"`);
        }
      }
    }
    expect(
      bad,
      `input-only @examples (would emit an invalid {} response): ${bad.join(", ")}`,
    ).toHaveLength(0);
  });
});

describe("Permission Sets OpenAPI contract", () => {
  it("publishes the permissionSets tag and paginated list operation", () => {
    expect(oa.tags).toContainEqual({
      name: "permissionSets",
      description:
        "IAM Identity Center permission sets available for sandbox lease permission profiles",
    });

    const operation = oa.paths["/permissionSets"]?.get;
    expect(operation?.operationId).toBe("ListPermissionSets");
    expect(operation?.tags).toEqual(["permissionSets"]);
    expect(operation?.description).toContain(
      "Accessible only to Admin and Manager roles.",
    );
    expect(
      operation?.parameters.map((parameter: any) => parameter.name).sort(),
    ).toEqual(["maxResults", "pageIdentifier", "q"]);
  });
});
