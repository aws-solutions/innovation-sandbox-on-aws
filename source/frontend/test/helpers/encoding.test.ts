// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-frontend/helpers/encoding";
import { CompositeKeyEncodingVectors } from "@amzn/innovation-sandbox-shared/test/composite-key-encoding-vectors.js";

// The backend validates the composite key path parameter against this pattern
// (see leases-handler.ts) and decodes it as base64url. The frontend encoder must
// therefore emit base64url (no '+', '/', or '=' padding) or the API rejects the
// value with a 400 before it ever reaches the handler.
const BASE64URL_PATH_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("base64EncodeCompositeKey (frontend)", () => {
  // Cross-runtime contract test: the browser uses TextEncoder/btoa while the
  // backend uses Node Buffer. Both suites assert the same fixed vectors so a
  // format change on either side fails without importing backend code here.
  test.each(CompositeKeyEncodingVectors)(
    "matches the backend contract for $name",
    ({ key, encoded: expected }) => {
      const encoded = base64EncodeCompositeKey(key);
      expect(encoded).toBe(expected);
      expect(encoded).toMatch(BASE64URL_PATH_PATTERN);
    },
  );

  test.each(CompositeKeyEncodingVectors)(
    "decodes the shared $name contract vector in the browser",
    ({ key, encoded }) => {
      expect(base64DecodeCompositeKey(encoded)).toEqual(key);
    },
  );

  test("returns undefined for an invalid browser route key", () => {
    expect(base64DecodeCompositeKey("not-a-composite-key")).toBeUndefined();
  });
});
