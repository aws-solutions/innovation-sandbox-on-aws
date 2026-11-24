// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  SesIdentityEnvironmentShape,
  validateSesIdentityRegion,
} from "@amzn/innovation-sandbox-commons/lambda/environments/ses-identity-environment.js";
import { describe, expect, it } from "vitest";

const schema = z
  .object(SesIdentityEnvironmentShape)
  .superRefine(validateSesIdentityRegion);

describe("SES identity environment", () => {
  it("accepts an empty identity ARN", () => {
    expect(
      schema.safeParse({ SES_IDENTITY_ARN: "", AWS_REGION: "us-east-1" })
        .success,
    ).toBe(true);
  });

  it("accepts an identity ARN from the SES Region", () => {
    expect(
      schema.safeParse({
        SES_IDENTITY_ARN:
          "arn:aws:ses:us-east-1:123456789012:identity/example.com",
        AWS_REGION: "us-east-1",
      }).success,
    ).toBe(true);
  });

  it("rejects an identity ARN from another Region", () => {
    const result = schema.safeParse({
      SES_IDENTITY_ARN:
        "arn:aws:ses:us-west-2:123456789012:identity/example.com",
      AWS_REGION: "us-east-1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["SES_IDENTITY_ARN"],
          message: "SES_IDENTITY_ARN Region must match AWS_REGION",
        }),
      ]);
    }
  });
});
