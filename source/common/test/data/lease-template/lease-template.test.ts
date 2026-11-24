// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  LeaseTemplateSchemaVersion,
  PersistedLeaseTemplate,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import type { Visibility } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000001";
const NOW = "2024-01-01T00:00:00Z";

const permissionSetArn = (index: number) =>
  `arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-${index.toString().padStart(16, "0")}`;

function validTemplate(
  overrides: Partial<PersistedLeaseTemplate> = {},
): PersistedLeaseTemplate {
  return {
    uuid: VALID_UUID,
    name: "Test Template",
    description: "A test template",
    requiresApproval: false,
    createdBy: "admin@example.com",
    visibility: "PUBLIC" as Visibility,
    costReportGroup: "team-alpha",
    blueprintId: "00000000-0000-4000-8000-000000000002",
    blueprintName: "My Blueprint",
    allowOwnerToShareLease: false,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    sandboxSpacesEnabled: true,
    maxSpend: 500,
    leaseDurationInHours: 48,
    budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" }],
    durationThresholds: [{ hoursRemaining: 4, action: "FREEZE_ACCOUNT" }],
    meta: {
      schemaVersion: LeaseTemplateSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  };
}

describe("PersistedLeaseTemplateSchema", () => {
  it("should accept a valid template", () => {
    expect(
      PersistedLeaseTemplateSchema.safeParse(validTemplate()).success,
    ).toBe(true);
  });

  it("should accept with only required fields", () => {
    expect(
      PersistedLeaseTemplateSchema.safeParse({
        uuid: VALID_UUID,
        name: "Minimal",
        requiresApproval: true,
        createdBy: "admin@example.com",
        visibility: "PUBLIC",
      }).success,
    ).toBe(true);
  });

  describe("uuid", () => {
    it("should reject when missing", () => {
      const { uuid: _, ...withoutUuid } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(withoutUuid).success).toBe(
        false,
      );
    });

    it("should reject non-UUID string", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ uuid: "not-a-uuid" }),
        ).success,
      ).toBe(false);
    });
  });

  describe("name", () => {
    it("should accept name at max length", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ name: "A".repeat(50) }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["exceeding 50 chars", "A".repeat(51)],
    ])("should reject %s", (_label, name) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(validTemplate({ name })).success,
      ).toBe(false);
    });
  });

  describe("description", () => {
    it("should accept when omitted", () => {
      const { description: _, ...rest } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });

    it("should reject when exceeding 1000 chars", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ description: "A".repeat(1001) }),
        ).success,
      ).toBe(false);
    });
  });

  describe("requiresApproval", () => {
    it.each([true, false])("should accept %s", (value) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ requiresApproval: value }),
        ).success,
      ).toBe(true);
    });

    it("should reject missing", () => {
      const { requiresApproval: _, ...rest } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe("createdBy", () => {
    it("should reject invalid email", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ createdBy: "not-email" }),
        ).success,
      ).toBe(false);
    });
  });

  describe("visibility", () => {
    it.each(["PUBLIC", "PRIVATE"] as Visibility[])(
      "should accept %s",
      (value) => {
        expect(
          PersistedLeaseTemplateSchema.safeParse(
            validTemplate({ visibility: value }),
          ).success,
        ).toBe(true);
      },
    );

    it("should reject invalid value", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ visibility: "INTERNAL" as any }),
        ).success,
      ).toBe(false);
    });
  });

  describe("costReportGroup", () => {
    it("should accept when omitted", () => {
      const { costReportGroup: _, ...rest } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });

    it.each([
      ["empty string", ""],
      ["exceeding 50 chars", "A".repeat(51)],
    ])("should reject %s", (_label, value) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ costReportGroup: value }),
        ).success,
      ).toBe(false);
    });
  });

  describe("blueprintId", () => {
    it.each([
      ["null", { blueprintId: null }],
      ["valid UUID", { blueprintId: "00000000-0000-4000-8000-000000000002" }],
    ])("should accept %s", (_label, overrides) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(validTemplate(overrides))
          .success,
      ).toBe(true);
    });

    it("should reject non-UUID string", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ blueprintId: "not-uuid" }),
        ).success,
      ).toBe(false);
    });

    it("should accept when omitted", () => {
      const { blueprintId: _, ...rest } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });
  });

  describe("blueprintName", () => {
    it.each([
      ["null", { blueprintName: null }],
      ["string", { blueprintName: "My Blueprint" }],
    ])("should accept %s", (_label, overrides) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(validTemplate(overrides))
          .success,
      ).toBe(true);
    });

    it("should accept when omitted", () => {
      const { blueprintName: _, ...rest } = validTemplate();
      expect(PersistedLeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });
  });

  describe("allowOwnerToShareLease", () => {
    it.each([true, false])("should accept %s", (value) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ allowOwnerToShareLease: value }),
        ).success,
      ).toBe(true);
    });

    it("should default to false when omitted", () => {
      const { allowOwnerToShareLease: _, ...rest } = validTemplate();
      const result = PersistedLeaseTemplateSchema.parse(rest);
      expect(result.allowOwnerToShareLease).toBe(false);
    });

    it("should reject non-boolean", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ allowOwnerToShareLease: "yes" as any }),
        ).success,
      ).toBe(false);
    });

    it("should parse a legacy v3 record without allowOwnerToShareLease and default to false", () => {
      const legacyRecord = {
        uuid: VALID_UUID,
        name: "Legacy Template",
        requiresApproval: false,
        createdBy: "admin@example.com",
        visibility: "PUBLIC",
        maxSpend: 100,
        leaseDurationInHours: 24,
        budgetThresholds: [],
        durationThresholds: [],
        meta: {
          schemaVersion: 3,
          createdTime: NOW,
          lastEditTime: NOW,
        },
      };
      const result = PersistedLeaseTemplateSchema.parse(legacyRecord);
      expect(result.allowOwnerToShareLease).toBe(false);
    });
  });

  describe("allowedModelIds (Sandbox Spaces)", () => {
    it("should accept an array of model ids", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            allowedModelIds: [
              "global.anthropic.claude-sonnet-4-6",
              "us.anthropic.claude-sonnet-4-6",
            ],
          }),
        ).success,
      ).toBe(true);
    });

    it("should be omittable (undefined inherits the global set)", () => {
      const { allowedModelIds: _, ...rest } = validTemplate();
      const result = PersistedLeaseTemplateSchema.parse(rest);
      expect(result.allowedModelIds).toBeUndefined();
    });

    it("should reject a non-string member", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ allowedModelIds: [123 as any] }),
        ).success,
      ).toBe(false);
    });
  });

  describe("defaultModelId (Sandbox Spaces)", () => {
    it("should accept a model id", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            allowedModelIds: ["global.anthropic.claude-sonnet-4-6"],
            defaultModelId: "global.anthropic.claude-sonnet-4-6",
          }),
        ).success,
      ).toBe(true);
    });

    it("should be omittable (undefined means no preselection)", () => {
      const { defaultModelId: _, ...rest } = validTemplate();
      const result = PersistedLeaseTemplateSchema.parse(rest);
      expect(result.defaultModelId).toBeUndefined();
    });

    it("should reject an empty string", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ defaultModelId: "" }),
        ).success,
      ).toBe(false);
    });
  });

  describe("permission profiles", () => {
    it("should accept a template without permission profile fields", () => {
      const template = validTemplate({
        meta: {
          schemaVersion: 4,
          createdTime: NOW,
          lastEditTime: NOW,
        },
      });

      const result = PersistedLeaseTemplateSchema.safeParse(template);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultPermissionSetArn).toBeUndefined();
        expect(result.data.allowedPermissionSetArns).toBeUndefined();
      }
    });

    it("should accept a populated permission profile configuration", () => {
      const allowedPermissionSetArns = [
        DEFAULT_PERMISSION_SET_ARN,
        "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000002",
      ];

      const result = PersistedLeaseTemplateSchema.safeParse(
        validTemplate({
          defaultPermissionSetArn: DEFAULT_PERMISSION_SET_ARN,
          allowedPermissionSetArns,
        }),
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultPermissionSetArn).toBe(
          DEFAULT_PERMISSION_SET_ARN,
        );
        expect(result.data.allowedPermissionSetArns).toEqual(
          allowedPermissionSetArns,
        );
      }
    });

    it("should accept 20 allowed permission sets and reject 21", () => {
      const permissionSetArns = Array.from({ length: 21 }, (_, index) =>
        permissionSetArn(index),
      );

      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            allowedPermissionSetArns: permissionSetArns.slice(0, 20),
          }),
        ).success,
      ).toBe(true);
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ allowedPermissionSetArns: permissionSetArns }),
        ).success,
      ).toBe(false);
    });

    it("should reject malformed permission set ARNs", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ defaultPermissionSetArn: "not-an-arn" }),
        ).success,
      ).toBe(false);
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            allowedPermissionSetArns: [
              "arn:aws:iam::123456789012:role/not-a-permission-set",
            ],
          }),
        ).success,
      ).toBe(false);
    });
  });

  describe("sandboxSpacesEnabled", () => {
    it("should default existing templates to false", () => {
      const { sandboxSpacesEnabled: _, ...existingTemplate } = validTemplate();
      expect(
        PersistedLeaseTemplateSchema.parse(existingTemplate)
          .sandboxSpacesEnabled,
      ).toBe(false);
    });

    it("should reject a string value", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse({
          ...validTemplate(),
          sandboxSpacesEnabled: "ENABLED",
        }).success,
      ).toBe(false);
    });
  });

  describe("maxSpend", () => {
    it("should accept positive number", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(validTemplate({ maxSpend: 100 }))
          .success,
      ).toBe(true);
    });

    it.each([0, -1])("should reject %s", (value) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ maxSpend: value }),
        ).success,
      ).toBe(false);
    });
  });

  describe("leaseDurationInHours", () => {
    it("should accept positive number", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ leaseDurationInHours: 24 }),
        ).success,
      ).toBe(true);
    });

    it.each([0, -1])("should reject %s", (value) => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({ leaseDurationInHours: value }),
        ).success,
      ).toBe(false);
    });
  });

  describe("budgetThresholds", () => {
    it("should accept valid thresholds", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [
              { dollarsSpent: 50, action: "ALERT" },
              { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
            ],
          }),
        ).success,
      ).toBe(true);
    });

    it("should reject threshold with zero dollarsSpent", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [{ dollarsSpent: 0, action: "ALERT" }],
          }),
        ).success,
      ).toBe(false);
    });

    it("should reject threshold with invalid action", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [
              { dollarsSpent: 50, action: "TERMINATE" as any },
            ],
          }),
        ).success,
      ).toBe(false);
    });
  });

  describe("durationThresholds", () => {
    it("should accept valid thresholds", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            durationThresholds: [
              { hoursRemaining: 4, action: "ALERT" },
              { hoursRemaining: 1, action: "FREEZE_ACCOUNT" },
            ],
          }),
        ).success,
      ).toBe(true);
    });

    it("should reject threshold with zero hoursRemaining", () => {
      expect(
        PersistedLeaseTemplateSchema.safeParse(
          validTemplate({
            durationThresholds: [{ hoursRemaining: 0, action: "ALERT" }],
          }),
        ).success,
      ).toBe(false);
    });
  });

  it("should reject unknown fields (strict mode)", () => {
    expect(
      PersistedLeaseTemplateSchema.safeParse(
        validTemplate({ unknownField: "value" } as any),
      ).success,
    ).toBe(false);
  });
});
