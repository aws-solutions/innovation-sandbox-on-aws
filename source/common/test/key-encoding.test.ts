// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
  decodePageIdentifier,
  InvalidPageIdentifierError,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { CompositeKeyEncodingVectors } from "@amzn/innovation-sandbox-shared/test/composite-key-encoding-vectors.js";

describe("lastEvaluatedKey encoding", () => {
  test("multi-part key can be encoded and decoded", () => {
    const key = {
      somePK: "partitionKey",
      someSK: "sortKey",
    };

    const encodedKey = base64EncodeCompositeKey(key);
    const decodedKey = base64DecodeCompositeKey(encodedKey!);

    expect(key).toEqual(decodedKey);
  });

  test("encoding undefined key returns null", () => {
    expect(base64EncodeCompositeKey(undefined)).toBeNull();
  });

  test("allows a caller-provided validator", () => {
    const cursor = {
      version: 1,
      key: { partitionKey: "value" },
    };

    expect(
      base64DecodeCompositeKey(
        base64EncodeCompositeKey(cursor)!,
        (decoded) => decoded as typeof cursor,
      ),
    ).toEqual(cursor);
  });

  test("propagates caller-provided validation failures", () => {
    const encodedKey = base64EncodeCompositeKey({ unexpected: "value" })!;
    expect(() =>
      base64DecodeCompositeKey(encodedKey, () => {
        throw new Error("invalid key");
      }),
    ).toThrow("invalid key");
  });

  test("normalizes malformed page identifiers", () => {
    expect(() => decodePageIdentifier("not-json")).toThrow(
      InvalidPageIdentifierError,
    );
  });

  test("normalizes page identifier validation failures", () => {
    const encodedKey = base64EncodeCompositeKey({ unexpected: "value" })!;

    expect(() =>
      decodePageIdentifier(encodedKey, () => {
        throw new Error("invalid key");
      }),
    ).toThrow(InvalidPageIdentifierError);
  });

  test("decoding an undefined page identifier returns undefined", () => {
    expect(decodePageIdentifier(undefined)).toBeUndefined();
  });

  // Cross-runtime contract test: this Node implementation and the browser
  // implementation assert the same fixed UTF-8/base64url vectors. Testing both
  // encode and decode keeps API-produced IDs compatible in both directions.
  test.each(CompositeKeyEncodingVectors)(
    "matches the frontend contract for $name",
    ({ key, encoded: expected }) => {
      expect(base64EncodeCompositeKey(key)).toBe(expected);
      expect(base64DecodeCompositeKey(expected)).toEqual(key);
    },
  );
});
