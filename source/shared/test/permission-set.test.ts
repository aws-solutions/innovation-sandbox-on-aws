// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  permissionSetCatalogConsoleUrl,
  permissionSetDetailsConsoleUrl,
} from "@amzn/innovation-sandbox-shared/utils/permission-set.js";

const PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-fedcba9876543210/ps-0123456789abcdef";

describe("permission set console URLs", () => {
  it("builds the regional console catalog URL for managing permission sets", () => {
    expect(permissionSetCatalogConsoleUrl("us-west-2")).toBe(
      "https://us-west-2.console.aws.amazon.com/singlesignon/home?region=us-west-2#/permission-sets",
    );
  });

  it("builds an IDC console deep link for a permission set", () => {
    expect(
      permissionSetDetailsConsoleUrl({
        region: "us-west-2",
        permissionSetArn: PERMISSION_SET_ARN,
      }),
    ).toBe(
      "https://us-west-2.console.aws.amazon.com/singlesignon/home?region=us-west-2#/instances/fedcba9876543210/permission-sets/details/ps-0123456789abcdef",
    );
  });

  it("percent-encodes the permission set ID path segment", () => {
    expect(
      permissionSetDetailsConsoleUrl({
        region: "us-west-2",
        permissionSetArn:
          "arn:aws:sso:::permissionSet/ins-AbCd01.-23456789/ps-ABCdef01.-/23456",
      }),
    ).toBe(
      "https://us-west-2.console.aws.amazon.com/singlesignon/home?region=us-west-2#/instances/AbCd01.-23456789/permission-sets/details/ps-ABCdef01.-%2F23456",
    );
  });

  it("falls back to the catalog for a malformed ARN", () => {
    expect(
      permissionSetDetailsConsoleUrl({
        region: "us-west-2",
        permissionSetArn: "malformed",
      }),
    ).toBe(permissionSetCatalogConsoleUrl("us-west-2"));
  });
});
