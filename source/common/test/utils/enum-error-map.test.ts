// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

describe("enumErrorMap", () => {
  it("should not reflect user input in error messages", () => {
    const StatusSchema = z.enum(["Active", "Pending", "Terminated"], {
      errorMap: enumErrorMap,
    });

    const result = StatusSchema.safeParse("INVALID_STATUS");

    expect(result.success).toBe(false);
    if (!result.success && result.error.errors.length > 0) {
      const errorMessage = result.error.errors[0]!.message;

      // Error message should NOT contain user input
      expect(errorMessage).not.toContain("INVALID_STATUS");

      // Error message should contain valid options
      expect(errorMessage).toContain("Active");
      expect(errorMessage).toContain("Pending");
      expect(errorMessage).toContain("Terminated");

      // Error message should be generic
      expect(errorMessage).toMatch(
        /Invalid value\. Expected one of the following:/,
      );
    }
  });
});
