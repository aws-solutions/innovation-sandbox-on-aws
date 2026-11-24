// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildM2mSyntheticEmail,
  isAdminOrManager,
  isSyntheticM2mEmail,
  parseRolesClaim,
  resolveEmailFromClaims,
} from "../utils/auth-utils.js";

describe("resolveEmailFromClaims", () => {
  it("returns email claim when present", () => {
    expect(
      resolveEmailFromClaims({
        email: "user@example.com",
        "cognito:username": "IAMIdentityCenter_other@example.com",
      }),
    ).toBe("user@example.com");
  });

  it("falls back to cognito:username when email is undefined", () => {
    expect(
      resolveEmailFromClaims({
        "cognito:username": "IAMIdentityCenter_user@example.com",
      }),
    ).toBe("user@example.com");
  });

  it("falls back to cognito:username when email is empty string", () => {
    expect(
      resolveEmailFromClaims({
        email: "",
        "cognito:username": "IAMIdentityCenter_user@example.com",
      }),
    ).toBe("user@example.com");
  });

  it("returns undefined when both are missing", () => {
    expect(resolveEmailFromClaims({})).toBeUndefined();
  });

  it("returns undefined when email is empty and username has no email", () => {
    expect(
      resolveEmailFromClaims({
        email: "",
        "cognito:username": "IAMIdentityCenter_not-an-email",
      }),
    ).toBeUndefined();
  });

  it("extracts email from IAMIdentityCenter_user@example.com format", () => {
    expect(
      resolveEmailFromClaims({
        "cognito:username": "IAMIdentityCenter_user@example.com",
      }),
    ).toBe("user@example.com");
  });

  it("extracts email when username has multiple underscores", () => {
    expect(
      resolveEmailFromClaims({
        "cognito:username": "IAMIdentityCenter_some_user@example.com",
      }),
    ).toBe("some_user@example.com");
  });

  it("returns undefined when username has no underscore", () => {
    expect(
      resolveEmailFromClaims({ "cognito:username": "nounderscore" }),
    ).toBeUndefined();
  });

  it("returns undefined when extracted part has no @ sign", () => {
    expect(
      resolveEmailFromClaims({
        "cognito:username": "IAMIdentityCenter_not-an-email",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when username is empty string", () => {
    expect(resolveEmailFromClaims({ "cognito:username": "" })).toBeUndefined();
  });

  it("returns undefined when only underscore with no content after", () => {
    expect(
      resolveEmailFromClaims({ "cognito:username": "Provider_" }),
    ).toBeUndefined();
  });
});

describe("parseRolesClaim", () => {
  it("parses valid roles array", () => {
    expect(parseRolesClaim('["Admin","User"]')).toEqual(["Admin", "User"]);
  });

  it("filters out invalid roles", () => {
    expect(parseRolesClaim('["Admin","InvalidRole","User"]')).toEqual([
      "Admin",
      "User",
    ]);
  });

  it("returns empty array for undefined", () => {
    expect(parseRolesClaim(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseRolesClaim("")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseRolesClaim("not-json")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseRolesClaim('{"role":"Admin"}')).toEqual([]);
  });

  it("returns empty array for array with no valid roles", () => {
    expect(parseRolesClaim('["Foo","Bar"]')).toEqual([]);
  });
});

describe("isSyntheticM2mEmail", () => {
  it("is true for an M2M synthetic email", () => {
    expect(isSyntheticM2mEmail(buildM2mSyntheticEmail("client", "Admin"))).toBe(
      true,
    );
    expect(isSyntheticM2mEmail("anything@automation.local")).toBe(true);
  });

  it("is false for a real user email", () => {
    expect(isSyntheticM2mEmail("user@example.com")).toBe(false);
  });

  it("is false when the domain only appears mid-string", () => {
    expect(isSyntheticM2mEmail("user@automation.local.example.com")).toBe(
      false,
    );
  });

  it("is case-insensitive on the domain", () => {
    expect(isSyntheticM2mEmail("m2m-client-Admin@AUTOMATION.LOCAL")).toBe(true);
  });
});

describe("isAdminOrManager", () => {
  it.each([
    [["Admin"], true],
    [["Manager"], true],
    [["User", "Manager"], true],
    [["User"], false],
    [[], false],
  ] as const)("roles %j -> %s", (roles, expected) => {
    expect(
      isAdminOrManager({
        type: "user",
        email: "alice@example.com",
        userId: "u-1",
        roles: [...roles],
      }),
    ).toBe(expected);
  });
});
