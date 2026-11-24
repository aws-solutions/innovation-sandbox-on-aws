// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import { BEDROCK_TOKEN_MONITORING_HREF } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import { MAINTENANCE_MODE_HREF } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import {
  formSearchFields,
  settingAnchor,
  SETTINGS_GROUPS,
  settingsGroupHref,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import {
  resolveSettingsHash,
  SEARCHABLE_SETTINGS,
  searchSettings,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-search";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

describe("Form-owned settings search", () => {
  it("shares a typed nested field name and anchor with its searchable entry", () => {
    const fields = {
      "validation.failureAction": {
        label: "On validation failure",
        description: "Choose what happens when cleanup validation fails.",
      },
    };
    expectTypeOf<
      keyof typeof fields
    >().toEqualTypeOf<"validation.failureAction">();
    const id = settingAnchor("cleanup", "validation.failureAction");
    expect(id).toBe("setting-cleanup-validation-failureAction");
    expect(
      formSearchFields({
        section: "cleanup",
        group: "account-cleanup",
        subgroup: "Cleanup validation",
        fields,
      }),
    ).toEqual([
      {
        id,
        section: "cleanup",
        field: "validation.failureAction",
        group: "account-cleanup",
        subgroup: "Cleanup validation",
        ...fields["validation.failureAction"],
      },
    ]);
  });

  it("rejects misspelled and wrong-section field names at compile time", () => {
    expect(settingAnchor("leases", "serviceBreakdownEnabled")).toBe(
      "setting-leases-serviceBreakdownEnabled",
    );
    // @ts-expect-error Unknown lease field.
    settingAnchor("leases", "serviceBreakdown");
    // @ts-expect-error A valid maintenance field is not a lease field.
    settingAnchor("leases", "enabled");
    // @ts-expect-error Nested fields must match the schema too.
    settingAnchor("cleanup", "validation.failureActions");
    const fields = {
      maxBudget: { label: "Max budget" },
      enabled: { label: "Maintenance mode" },
    };
    expect(fields.maxBudget.label).toBe("Max budget");
    // @ts-expect-error Search definitions cannot contain wrong-section fields.
    formSearchFields({
      section: "leases",
      group: "lease-policies",
      subgroup: "Budget and duration",
      fields,
    });
    // @ts-expect-error Search definitions must retain their section's field names.
    formSearchFields({
      section: "cleanup",
      group: "account-cleanup",
      subgroup: "Cleanup",
      fields: { maxBudget: { label: "Max budget" } },
    });
  });

  it("shares exported links with the form-owned search targets", () => {
    const maintenance = SEARCHABLE_SETTINGS.find(
      (entry) => entry.section === "maintenance" && entry.field === "enabled",
    )!;
    const monitoring = SEARCHABLE_SETTINGS.find(
      (entry) =>
        entry.section === "leases" &&
        entry.field === "allowBedrockTokenMonitoring",
    )!;
    expect(MAINTENANCE_MODE_HREF).toBe(`/settings#${maintenance.id}`);
    expect(BEDROCK_TOKEN_MONITORING_HREF).toBe(`/settings#${monitoring.id}`);
  });

  it("indexes each writable setting once, including both inputs of the rate-limit control", () => {
    expect(new Set(SEARCHABLE_SETTINGS.map((entry) => entry.id)).size).toBe(
      SEARCHABLE_SETTINGS.length,
    );
    for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
      const indexed = SEARCHABLE_SETTINGS.filter(
        (entry) => entry.section === section,
      ).map((entry) => entry.field!);
      const fields = Object.entries(ConfigSchemas[section].parse({})).flatMap(
        ([key, value]) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.keys(value).map((child) => `${key}.${child}`)
            : [key],
      );
      expect(new Set(indexed).size).toBe(indexed.length);
      // The rate-limit control exposes one search result for its two inputs.
      const compoundFields =
        section === "leases" ? ["leaseRequestWindowHours"] : [];
      expect(new Set([...indexed, ...compoundFields])).toEqual(new Set(fields));
    }
    expect(
      SEARCHABLE_SETTINGS.find(
        (entry) => entry.field === "serviceBreakdownEnabled",
      )?.group,
    ).toBe("cost");
  });
  it("ranks labels first and searches each form's descriptions", () => {
    expect(searchSettings("budget")[0].label).toContain("budget");
    expect(searchSettings("retention").map((entry) => entry.label)).toContain(
      "Lease record retention (days)",
    );
    expect(searchSettings("typeahead").map((entry) => entry.label)).toContain(
      "Principal search",
    );
    expect(searchSettings("quarantine").map((entry) => entry.label)).toContain(
      "On validation failure",
    );
    expect(searchSettings(" ")).toEqual([]);
  });
  it("ranks labels before field descriptions and field matches before group matches", () => {
    const ids = searchSettings("users").map((entry) => entry.id);
    const labelMatch = ids.indexOf("setting-leases-allowUserLeaseTermination");
    const fieldMatch = ids.indexOf("setting-leases-enablePrincipalSearch");
    const groupMatch = ids.indexOf("awsAccessPortalUrl");
    expect(labelMatch).toBeGreaterThanOrEqual(0);
    expect(fieldMatch).toBeGreaterThan(labelMatch);
    expect(groupMatch).toBeGreaterThan(fieldMatch);
  });
  it("matches every query word even when the words span field and group text", () => {
    expect(
      searchSettings("service available").map((entry) => entry.id),
    ).toContain("setting-leases-serviceBreakdownEnabled");
    expect(searchSettings("service nonexistent-setting")).toEqual([]);
  });
  it("searches deployment settings by their shared description and preserves their anchors", () => {
    const results = searchSettings(
      "Read-only configuration set at deployment time.",
    );
    // These entries share the same description, so ties stay alphabetical.
    expect(results.map((entry) => entry.id)).toEqual([
      "awsAccessPortalUrl",
      "bedrockInferenceProfilePatterns",
      "isbManagedRegions",
      "version",
    ]);
    for (const entry of results) {
      expect(entry.group).toBe("general");
      expect(entry.subgroup).toBe("Deployment settings");
      expect(entry.section).toBeUndefined();
      expect(entry.field).toBeUndefined();
    }
  });
  it("resolves every indexed field and current settings group", () => {
    for (const entry of SEARCHABLE_SETTINGS)
      expect(resolveSettingsHash(entry.id)).toEqual({
        group: entry.group,
        target: entry.id,
      });
    for (const group of SETTINGS_GROUPS)
      expect(resolveSettingsHash(group.id)).toEqual({ group: group.id });
    expect(
      resolveSettingsHash("setting-leases-allowBedrockTokenMonitoring"),
    ).toEqual({
      group: "lease-policies",
      target: "setting-leases-allowBedrockTokenMonitoring",
    });
  });
  it.each(SETTINGS_GROUPS)(
    "constructs the $label group link with the standard settings route",
    ({ id }) => {
      expect(settingsGroupHref(id)).toBe(`/settings#${id}`);
    },
  );
  it("defaults to General for an unknown hash", () => {
    expect(resolveSettingsHash("unknown-setting")).toEqual({
      group: "general",
    });
  });
});
