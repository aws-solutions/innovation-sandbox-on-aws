// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AssignLeaseValidationSchema,
  RequestLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";

const developerPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef";
const auditorPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef";
const selectedUser = {
  principalId: "11111111-1111-4111-8111-111111111111",
  email: "user@example.com",
  displayName: "Test User",
};
const principalId = (index: number) =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

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

    it("rejects multiple permission sets for one principal", () => {
      const result = RequestLeaseValidationSchema.safeParse({
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        assignments: [
          {
            principalId: principalId(1),
            principalType: "USER",
            permissionSetArn: developerPermissionSetArn,
          },
          {
            principalId: principalId(1),
            principalType: "USER",
            permissionSetArn: auditorPermissionSetArn,
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Each principal may only be added once",
        );
      }
    });

    it("rejects a duplicate principal", () => {
      const assignment = {
        principalId: principalId(1),
        principalType: "USER" as const,
        permissionSetArn: developerPermissionSetArn,
      };
      const result = RequestLeaseValidationSchema.safeParse({
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        assignments: [assignment, assignment],
      });

      expect(result.success).toBe(false);
    });

    it("allows the owner to count toward the full assignment limit", () => {
      const assignments = Array.from(
        { length: MAX_ASSIGNMENTS },
        (_, index) => ({
          principalId: principalId(index),
          principalType: "USER" as const,
          permissionSetArn: developerPermissionSetArn,
        }),
      );
      const baseRequest = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
      };

      expect(
        RequestLeaseValidationSchema.safeParse({
          ...baseRequest,
          assignments,
        }).success,
      ).toBe(true);
      expect(
        RequestLeaseValidationSchema.safeParse({
          ...baseRequest,
          assignments: [
            ...assignments,
            {
              principalId: principalId(MAX_ASSIGNMENTS),
              principalType: "USER",
              permissionSetArn: developerPermissionSetArn,
            },
          ],
        }).success,
      ).toBe(false);
    });

    it("rejects malformed Identity Center principal IDs", () => {
      const result = RequestLeaseValidationSchema.safeParse({
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        assignments: [
          {
            principalId: "user-1",
            principalType: "USER",
            permissionSetArn: developerPermissionSetArn,
          },
        ],
      });

      expect(result.success).toBe(false);
    });

    it("requires an explicit permission set for each assignment", () => {
      const result = RequestLeaseValidationSchema.safeParse({
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
        assignments: [
          {
            principalId: principalId(1),
            principalType: "USER",
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.find(
            (issue) =>
              issue.path[0] === "assignments" &&
              issue.path[1] === 0 &&
              issue.path[2] === "permissionSetArn",
          ),
        ).toBeDefined();
      }
    });
  });

  describe("AssignLeaseValidationSchema", () => {
    it("validates valid assignment data", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        selectedUser,
        acceptTerms: true,
        comments: "Test comment",
      };

      const result = AssignLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates valid assignment without optional comments", () => {
      const validData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        selectedUser,
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("requires leaseTemplateUuid", () => {
      const invalidData = {
        selectedUser,
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

    it("requires selectedUser", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const selectedUserError = result.error.issues.find(
          (issue) => issue.path[0] === "selectedUser",
        );
        expect(selectedUserError?.message).toBe(
          "You must provide a valid user",
        );
      }
    });

    it("requires the selected user's principalId", () => {
      const result = AssignLeaseValidationSchema.safeParse({
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        selectedUser: {
          email: "user@example.com",
        },
        acceptTerms: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.find(
            (issue) =>
              issue.path[0] === "selectedUser" &&
              issue.path[1] === "principalId",
          )?.message,
        ).toBe("Invalid input: expected string, received undefined");
      }
    });

    it("validates the selected user's email address", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        selectedUser: {
          ...selectedUser,
          email: "not-an-email",
        },
        acceptTerms: true,
      };

      const result = AssignLeaseValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const emailError = result.error.issues.find(
          (issue) =>
            issue.path[0] === "selectedUser" && issue.path[1] === "email",
        );
        expect(emailError?.message).toContain("valid email");
      }
    });

    it("requires acceptTerms to be true", () => {
      const invalidData = {
        leaseTemplateUuid: "550e8400-e29b-41d4-a716-446655440000",
        selectedUser,
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
          selectedUser: {
            ...selectedUser,
            email,
          },
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
          selectedUser: {
            ...selectedUser,
            email,
          },
          acceptTerms: true,
        };

        const result = AssignLeaseValidationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
      });
    });
  });
});
