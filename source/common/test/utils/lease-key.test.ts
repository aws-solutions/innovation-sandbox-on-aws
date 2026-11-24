// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { parseLeaseKey } from "@amzn/innovation-sandbox-commons/utils/lease-key.js";

describe("parseLeaseKey", () => {
  const key = {
    userEmail: "owner@example.com",
    uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  };

  it("decodes a base64url lease key", () => {
    expect(parseLeaseKey(base64EncodeCompositeKey(key)!)).toEqual(key);
  });

  it.each([
    ["an empty string", ""],
    ["non-JSON input", "not-a-lease-key!!"],
    [
      "base64 of non-JSON text",
      Buffer.from("plain text").toString("base64url"),
    ],
    ["a JSON string", Buffer.from('"text"').toString("base64url")],
    ["JSON null", Buffer.from("null").toString("base64url")],
    [
      "a key missing the uuid",
      base64EncodeCompositeKey({ userEmail: key.userEmail })!,
    ],
    [
      "a key with an invalid email",
      base64EncodeCompositeKey({ ...key, userEmail: "not-an-email" })!,
    ],
    [
      "a key with an invalid uuid",
      base64EncodeCompositeKey({ ...key, uuid: "lease-abc" })!,
    ],
  ])("returns undefined for %s", (_description, encoded) => {
    expect(parseLeaseKey(encoded)).toBeUndefined();
  });
});
