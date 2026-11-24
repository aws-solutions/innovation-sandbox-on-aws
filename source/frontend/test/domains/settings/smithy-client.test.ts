// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Guards the section → generated-Command dispatch. The maps are built with
// `as unknown as CommandCtor` casts (the generated commands have per-section
// input/output types that can't be expressed in one map type), so a section↔
// command swap — the exact mistake the casts could hide — compiles. This table
// asserts every configured section points at the correctly-named command.
import { describe, expect, it } from "vitest";

import * as client from "@amzn/innovation-sandbox-api-client";
import { ConfigurationSectionViewSchemas } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import {
  GET_SECTION_COMMANDS,
  UPDATE_SECTION_COMMANDS,
} from "@amzn/innovation-sandbox-frontend/domains/settings/smithy-client";

const SECTIONS = [
  ["leases", "Leases"],
  ["cleanup", "Cleanup"],
  ["notification", "Notification"],
  ["maintenance", "Maintenance"],
  ["termsOfService", "TermsOfService"],
  ["costReporting", "CostReporting"],
  ["agent", "Agent"],
] as const;

describe("configuration response schemas", () => {
  it("rejects missing response fields instead of applying read defaults", () => {
    expect(
      ConfigurationSectionViewSchemas.maintenance.safeParse({
        lastSavedBy: null,
      }).success,
    ).toBe(false);
  });

  it("tolerates stored leases configuration that violates the write-only window rule", () => {
    expect(
      ConfigurationSectionViewSchemas.leases.safeParse({
        requireMaxBudget: true,
        maxBudget: 50,
        requireMaxDuration: true,
        maxDurationHours: 168,
        maxLeasesPerUser: 3,
        ttl: 1,
        allowUserLeaseTermination: true,
        leaseRequestWindowHours: 25,
        maxLeaseRequestsPerWindow: 10,
        leaseSharingEnabled: false,
        enablePrincipalSearch: true,
        groupAssignmentMode: "NONE",
        allowPredictiveBudgetControls: false,
        serviceBreakdownEnabled: false,
        allowBedrockTokenMonitoring: false,
        lastSavedBy: null,
      }).success,
    ).toBe(true);
  });
});

describe("configuration section → Command dispatch", () => {
  it.each(SECTIONS)(
    "%s maps GET/UPDATE to the matching generated command",
    (section, pascal) => {
      const clientCommands = client as unknown as Record<string, unknown>;
      expect(GET_SECTION_COMMANDS[section]).toBe(
        clientCommands[`Get${pascal}ConfigurationCommand`],
      );
      expect(UPDATE_SECTION_COMMANDS[section]).toBe(
        clientCommands[`Update${pascal}ConfigurationCommand`],
      );
    },
  );

  it("matches the configuration sections for get and update actions", () => {
    const keys = SECTIONS.map(([section]) => section).sort();
    expect(Object.keys(GET_SECTION_COMMANDS).sort()).toEqual(keys);
    expect(Object.keys(UPDATE_SECTION_COMMANDS).sort()).toEqual(keys);
  });
});
