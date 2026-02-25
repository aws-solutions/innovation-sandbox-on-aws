// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AssignLeaseValidationSchema,
  RequestLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";

describe("Lease Validation Schemas", () => {
  describe("RequestLeaseValidationSchema", () => {
    it("validates valid request data", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        comments: "Test comment",
      };

      const result = RequestLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates valid request without optional comments", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
      };

      const result = RequestLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("requires leaseTemplateUuid", () => {
      const invalidData = {
        acceptTerms: true,
        comments: "Test comment",
      };

      const result = RequestLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const uuidError = result.error.issues.find(
          (issue) => issue.path[0] === "leaseTemplateUuid",
        );
        expect(uuidError?.message).toBe("Required");
      }
    });

    it("validates leaseTemplateUuid is a valid UUID", () => {
      const invalidData = {
        leaseTemplateUuid: "not-a-uuid",
        acceptTerms: true,
      };

      const result = RequestLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const uuidError = result.error.issues.find(
          (issue) => issue.path[0] === "leaseTemplateUuid",
        );
        expect(uuidError?.message).toContain("valid lease template");
      }
    });

    it("requires acceptTerms to be true", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: false,
      };

      const result = RequestLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const termsError = result.error.issues.find(
          (issue) => issue.path[0] === "acceptTerms",
        );
        expect(termsError?.message).toContain("You must accept the terms");
      }
    });

    it("allows empty string for comments", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        comments: "",
      };

      const result = RequestLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe("AssignLeaseValidationSchema", () => {
    it("validates valid assignment data", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        acceptTerms: true,
        comments: "Test comment",
      };

      const result = AssignLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates valid assignment without optional comments", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("requires leaseTemplateUuid", () => {
      const invalidData = {
        userEmail: "user@example.com",
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const uuidError = result.error.issues.find(
          (issue) => issue.path[0] === "leaseTemplateUuid",
        );
        expect(uuidError?.message).toBe("Required");
      }
    });

    it("requires userEmail", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const emailError = result.error.issues.find(
          (issue) => issue.path[0] === "userEmail",
        );
        expect(emailError?.message).toBe("Required");
      }
    });

    it("validates userEmail is a valid email address", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "not-an-email",
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const emailError = result.error.issues.find(
          (issue) => issue.path[0] === "userEmail",
        );
        expect(emailError?.message).toContain("valid email");
      }
    });

    it("requires acceptTerms to be true", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        acceptTerms: false,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const termsError = result.error.issues.find(
          (issue) => issue.path[0] === "acceptTerms",
        );
        expect(termsError?.message).toContain("You must accept the terms");
      }
    });

    it("allows various valid email formats", () => {
      const validEmails = [
        "user@example.com",
        "user.name@example.com",
        "user+tag@example.co.uk",
        "user_name@example-domain.com",
      ];

      validEmails.forEach((email) => {
        const validData = {
          leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: email,
          acceptTerms: true,
        };

        const result = AssignLeaseValidationSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });
    });

    it("rejects invalid email formats", () => {
      const invalidEmails = [
        "not-an-email",
        "@example.com",
        "user@",
        "user @example.com",
        "user@example",
      ];

      invalidEmails.forEach((email) => {
        const invalidData = {
          leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: email,
          acceptTerms: true,
        };

        const result = AssignLeaseValidationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
      });
    });
  });
});
