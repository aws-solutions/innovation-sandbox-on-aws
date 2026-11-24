// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { z } from "zod";

import { inputHash, modelFingerprint } from "../../scripts/lib/fingerprint.mjs";
import { modelDir, modelJson, stampFile } from "../../scripts/lib/paths.mjs";

export type SmithyMember = {
  target: string;
  traits?: Record<string, unknown>;
};

type SmithyShape = {
  errors?: Array<{ target: string }>;
  input?: { target: string };
  member?: SmithyMember;
  members?: Record<string, SmithyMember>;
  mixins?: Array<{ target: string }>;
  traits?: Record<string, unknown>;
  type: string;
};

type SmithyModel = {
  shapes: Record<string, SmithyShape>;
  smithy: string;
};

export type ComparableSchema = {
  items?: ComparableSchema;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  type?: string;
};

const modelPath = modelJson;

/**
 * The model.json this suite reads is a generated projection dump that is not
 * tracked. Guard against validating a STALE model (a false green) or a missing
 * one. Content-based, not mtime: assert the codegen stamp's recorded inputs still
 * equal the current sources' hash AND the model.json on disk matches the stamped
 * fingerprint. A rebase/checkout that only touches timestamps therefore does not
 * trip it, while a real source change — or a stale / missing / corrupt model.json —
 * does. (The codegen cache also fingerprints this projection now, so a
 * `smithy:prepare` that skips leaves it current, not stale.)
 */
function assertModelIsFresh(): void {
  const runPrepare =
    "Run `npm run smithy:prepare` (root `npm test` does this automatically) before the parity suite.";
  let stamp: { inputs?: string; outputs?: { model?: { sha256?: string } } };
  try {
    stamp = JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    throw new Error(
      `Smithy codegen stamp missing at ${stampFile}. ${runPrepare}`,
    );
  }
  if (stamp.inputs !== inputHash(modelDir)) {
    throw new Error(
      `Smithy sources changed since the last codegen — the model projection is stale. ${runPrepare}`,
    );
  }
  let actual;
  try {
    actual = modelFingerprint(modelPath);
  } catch {
    throw new Error(
      `Smithy model projection missing at ${modelPath}. ${runPrepare}`,
    );
  }
  if (stamp.outputs?.model?.sha256 !== actual.sha256) {
    throw new Error(
      `Smithy model projection at ${modelPath} does not match the codegen stamp (stale or corrupt). ${runPrepare}`,
    );
  }
}

assertModelIsFresh();

const smithyModel = JSON.parse(readFileSync(modelPath, "utf8")) as SmithyModel;
const DEFAULT_NAMESPACE = "com.amazon.isb#";

function shapeId(name: string): string {
  return name.includes("#") ? name : `${DEFAULT_NAMESPACE}${name}`;
}

export function modelShape(name: string): SmithyShape {
  const shape = smithyModel.shapes[shapeId(name)];
  expect(shape, `the model should declare a ${name} shape`).toBeDefined();
  return shape!;
}

function effectiveMembers(
  name: string,
  resolving = new Set<string>(),
): Record<string, SmithyMember> {
  const id = shapeId(name);
  if (resolving.has(id)) throw new Error(`mixin cycle while resolving ${id}`);

  const shape = modelShape(id);
  const next = new Set(resolving).add(id);
  const members: Record<string, SmithyMember> = {};
  for (const { target } of shape.mixins ?? []) {
    Object.assign(members, effectiveMembers(target, next));
  }
  return Object.assign(members, shape.members ?? {});
}

export function modelMembers(name: string): string[] {
  return Object.keys(effectiveMembers(name)).sort();
}

export function modelRequired(name: string): string[] {
  return Object.entries(effectiveMembers(name))
    .filter(
      ([, member]) => member.traits?.["smithy.api#required"] !== undefined,
    )
    .map(([member]) => member)
    .sort();
}

export function modelMember(
  structure: string,
  memberName: string,
): SmithyMember {
  const member = effectiveMembers(structure)[memberName];
  expect(
    member,
    `${structure}.${memberName} should be declared in the model`,
  ).toBeDefined();
  return member!;
}

export function modelEnum(name: string): string[] {
  const shape = modelShape(name);
  expect(shape.type, `${name} should be an enum`).toBe("enum");
  return Object.values(shape.members ?? {})
    .map((member) => member.traits?.["smithy.api#enumValue"])
    .filter((value): value is string => typeof value === "string")
    .sort();
}

export function modelMemberTrait<T>(
  structure: string,
  memberName: string,
  trait: string,
): T | undefined {
  const member = modelMember(structure, memberName);
  if (member.traits?.[trait] !== undefined) {
    return member.traits[trait] as T;
  }
  return smithyModel.shapes[member.target]?.traits?.[trait] as T | undefined;
}

export function modelMemberTargetTrait<T>(
  structure: string,
  memberName: string,
  trait: string,
): T | undefined {
  const target = smithyModel.shapes[modelMember(structure, memberName).target];
  return target?.traits?.[trait] as T | undefined;
}

export function modelHttpOperation(name: string): {
  code: number;
  method: string;
  uri: string;
} {
  const operation = modelShape(name);
  expect(operation.type, `${name} should be an operation`).toBe("operation");
  const http = operation.traits?.["smithy.api#http"];
  expect(http, `${name} should declare an HTTP binding`).toBeDefined();
  return http as { code: number; method: string; uri: string };
}

export function modelOperationErrors(name: string): string[] {
  const operation = modelShape(name);
  expect(operation.type, `${name} should be an operation`).toBe("operation");
  return (operation.errors ?? [])
    .map(({ target }) => target.split("#").at(-1) ?? target)
    .sort();
}

export function modelQueryParameters(operationName: string): Array<{
  memberName: string;
  name: string;
  required: boolean;
  target: string;
}> {
  const operation = modelShape(operationName);
  const input = operation.input?.target;
  expect(
    input,
    `${operationName} should declare an input structure`,
  ).toBeDefined();

  return Object.entries(effectiveMembers(input!))
    .filter(
      ([, member]) => member.traits?.["smithy.api#httpQuery"] !== undefined,
    )
    .map(([memberName, member]) => ({
      memberName,
      name: member.traits?.["smithy.api#httpQuery"] as string,
      required: member.traits?.["smithy.api#required"] !== undefined,
      target: member.target,
    }));
}

function smithyType(target: string): string | undefined {
  const type = smithyModel.shapes[target]?.type ?? target.split("#")[1];
  if (!type) return undefined;
  return {
    Blob: "string",
    boolean: "boolean",
    byte: "integer",
    double: "number",
    float: "number",
    integer: "integer",
    long: "integer",
    short: "integer",
    string: "string",
    timestamp: "string",
    Boolean: "boolean",
    Byte: "integer",
    Double: "number",
    Float: "number",
    Integer: "integer",
    Long: "integer",
    Short: "integer",
    String: "string",
    Timestamp: "string",
    enum: "string",
    list: "array",
    structure: "object",
  }[type];
}

function constraintValue(
  member: SmithyMember,
  trait: string,
): Record<string, number> | undefined {
  const target = smithyModel.shapes[member.target]?.traits?.[trait] as
    | Record<string, number>
    | undefined;
  const local = member.traits?.[trait] as Record<string, number> | undefined;
  if (!target) return local;
  if (!local) return target;

  const minimums = [target.min, local.min].filter(
    (value): value is number => value !== undefined,
  );
  const maximums = [target.max, local.max].filter(
    (value): value is number => value !== undefined,
  );
  return {
    ...(minimums.length > 0 ? { min: Math.max(...minimums) } : {}),
    ...(maximums.length > 0 ? { max: Math.min(...maximums) } : {}),
  };
}
function comparableModelSchema(member: SmithyMember): ComparableSchema {
  const type = smithyType(member.target);
  const range = constraintValue(member, "smithy.api#range");
  const length = constraintValue(member, "smithy.api#length");
  const result: ComparableSchema = { type };

  if (range?.min !== undefined) result.minimum = range.min;
  if (range?.max !== undefined) result.maximum = range.max;
  if (length?.min !== undefined) {
    if (type === "array") result.minItems = length.min;
    else result.minLength = length.min;
  }
  if (length?.max !== undefined) {
    if (type === "array") result.maxItems = length.max;
    else result.maxLength = length.max;
  }

  const target = smithyModel.shapes[member.target];
  if (type === "array" && target?.member) {
    result.items = comparableModelSchema(target.member);
  }
  return result;
}

export function modelMemberSchema(
  structure: string,
  memberName: string,
): ComparableSchema {
  return comparableModelSchema(modelMember(structure, memberName));
}

// This canonical form intentionally carries only member/scalar type, inclusive
// numeric range, and length/size. It does NOT carry pattern, string format,
// enum values (compared separately via `modelEnum`), exclusive bounds, union
// structure, or nullability. Those dimensions are Zod-owned and are recorded as
// named accepted deviations in the domain tests, not compared here — see the
// README "unsupported comparison dimensions" note.
function comparableJsonSchema(json: Record<string, unknown>): ComparableSchema {
  const result: ComparableSchema = {};
  if (typeof json.type === "string") result.type = json.type;
  // `z.number().int()` with no explicit max emits the JS safe-integer range as a
  // pseudo-bound. Drop those sentinels so a min-only integer compares equal to an
  // unbounded Smithy `Integer`. This makes the int32-vs-safe-integer gap invisible
  // to the bound comparison ON PURPOSE — it is surfaced as an explicit named
  // deviation in configuration.test.ts, which fails if either side changes.
  if (
    typeof json.minimum === "number" &&
    json.minimum !== -Number.MAX_SAFE_INTEGER
  ) {
    result.minimum = json.minimum;
  }
  if (
    typeof json.maximum === "number" &&
    json.maximum !== Number.MAX_SAFE_INTEGER
  ) {
    result.maximum = json.maximum;
  }
  if (typeof json.minLength === "number") result.minLength = json.minLength;
  if (typeof json.maxLength === "number") result.maxLength = json.maxLength;
  if (typeof json.minItems === "number") result.minItems = json.minItems;
  if (typeof json.maxItems === "number") result.maxItems = json.maxItems;
  if (
    json.items &&
    typeof json.items === "object" &&
    !Array.isArray(json.items)
  ) {
    result.items = comparableJsonSchema(json.items as Record<string, unknown>);
  }
  return result;
}

export function zodComparableSchema(schema: z.ZodType): ComparableSchema {
  return comparableJsonSchema(
    z.toJSONSchema(schema) as Record<string, unknown>,
  );
}

export function zodMembers(shape: Record<string, z.ZodType>): string[] {
  return Object.keys(shape).sort();
}

/**
 * Assert each Zod field's canonical type (and list item type) matches the mapped
 * Smithy member. Member-set + requiredness parity alone cannot see a member whose
 * target type changed (e.g. a String silently becoming an Integer), which is a
 * breaking, invisible drift; this closes that. A union/record has no single
 * canonical type and is skipped — such members are covered by a dedicated test
 * where they occur.
 */
export function expectMemberTypeParity(
  structure: string,
  shape: Record<string, z.ZodType>,
): void {
  for (const [name, field] of Object.entries(shape)) {
    const zod = zodComparableSchema(field);
    if (zod.type === undefined) continue;
    const model = modelMemberSchema(structure, name);
    expect(model.type, `${structure}.${name} type`).toBe(zod.type);
    if (zod.type === "array") {
      expect(model.items?.type, `${structure}.${name} item type`).toBe(
        zod.items?.type,
      );
    }
  }
}

/** Members a caller must supply because `undefined` does not parse. */
export function requiredOnInput(shape: Record<string, z.ZodType>): string[] {
  return Object.entries(shape)
    .filter(([, member]) => !member.safeParse(undefined).success)
    .map(([name]) => name)
    .sort();
}

/** Members always present after parsing, including members with defaults. */
export function alwaysPresentOnOutput(
  shape: Record<string, z.ZodType>,
): string[] {
  return Object.entries(shape)
    .filter(([, member]) => {
      const parsed = member.safeParse(undefined);
      return !parsed.success || parsed.data !== undefined;
    })
    .map(([name]) => name)
    .sort();
}
