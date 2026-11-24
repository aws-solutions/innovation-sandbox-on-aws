// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Configurations typed adapter over the generated aggregate `IsbClient`. Same
// shape as the Lease Templates adapter: the shared transport lives in
// `helpers/isbApiClient`; this file is the domain's command dispatch and
// input/output mappers. Because the config sections are section-dependent, the
// domain is modeled as one operation (hence one Command) per section, so a small
// section → Command lookup replaces a single `{section}` call.
import {
  type AdminConfiguration as SmithyAdminConfiguration,
  type ConfigurationResponseMetadata as SmithyConfigurationResponseMetadata,
  GetAgentConfigurationCommand,
  GetCleanupConfigurationCommand,
  GetConfigurationsCommand,
  GetCostReportingConfigurationCommand,
  GetLeasesConfigurationCommand,
  GetMaintenanceConfigurationCommand,
  GetNotificationConfigurationCommand,
  GetTermsOfServiceConfigurationCommand,
  IsbClient,
  UpdateAgentConfigurationCommand,
  UpdateCleanupConfigurationCommand,
  UpdateCostReportingConfigurationCommand,
  UpdateLeasesConfigurationCommand,
  UpdateMaintenanceConfigurationCommand,
  UpdateNotificationConfigurationCommand,
  UpdateTermsOfServiceConfigurationCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  type ConfigSection,
  hasCompleteConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import {
  type AdminConfigurationView,
  type ConfigurationSectionView,
  ConfigurationSectionViewSchemas,
} from "./model";
import type { ConfigurationSectionRequest } from "./types";

// The shared signed-client factory, re-exported under a domain-scoped name so
// call sites read as configuration-specific.
export { createIsbClient as createConfigurationClient } from "../../helpers/isbApiClient";

export interface SmithyConfigurationApi {
  getConfigurations(): Promise<AdminConfigurationView>;
  getConfigurationSection<T extends ConfigSection>(
    section: T,
  ): Promise<ConfigurationSectionView<T>>;
  putConfigurationSection<T extends ConfigSection>(
    section: T,
    data: ConfigurationSectionRequest<T>,
  ): Promise<ConfigurationSectionView<T>>;
}

// One generated Command per section (the domain is modeled as per-section
// operations on literal paths). The value type is erased to a common constructor
// shape: a precise per-section map produces a heterogeneous command union that
// cannot be constructed or passed to `client.send` (their input/output types
// differ), so section dispatch requires this erasure. The section→command routing
// is guarded by identity in smithy-client.test.ts.
type CommandCtor = new (input: object) => object;
type ErasedSectionOutput = { data?: Record<string, unknown> };

export const GET_SECTION_COMMANDS: Record<ConfigSection, CommandCtor> = {
  leases: GetLeasesConfigurationCommand,
  cleanup: GetCleanupConfigurationCommand,
  notification: GetNotificationConfigurationCommand,
  maintenance: GetMaintenanceConfigurationCommand,
  termsOfService: GetTermsOfServiceConfigurationCommand,
  costReporting: GetCostReportingConfigurationCommand,
  agent: GetAgentConfigurationCommand,
};

// `Update*` inputs are required (unlike the reads' empty input), so the classes
// are not assignable to `CommandCtor` — cast the assembled map once (tsc rejects
// removing it; S4325 is a false positive).
export const UPDATE_SECTION_COMMANDS = {
  leases: UpdateLeasesConfigurationCommand,
  cleanup: UpdateCleanupConfigurationCommand,
  notification: UpdateNotificationConfigurationCommand,
  maintenance: UpdateMaintenanceConfigurationCommand,
  termsOfService: UpdateTermsOfServiceConfigurationCommand,
  costReporting: UpdateCostReportingConfigurationCommand,
  agent: UpdateAgentConfigurationCommand,
} as unknown as Record<ConfigSection, CommandCtor>; // NOSONAR typescript:S4325 - cast required (tsc); routing guarded by smithy-client.test.ts

/** The audit members a generated section output carries; the remaining keys are
 * the section's own fields, spread through untyped since a generic loop cannot
 * reach each section's distinct generated output type. */
type SmithySectionAudit = {
  lastSavedBy?: string | null;
  meta?: SmithyConfigurationResponseMetadata;
};

/**
 * Adapts a generated section to `ConfigurationSectionView`: `meta` timestamps are
 * opaque strings (survive byte-for-byte as the concurrency token), `lastSavedBy` is
 * re-coalesced to `null` when absent for the UI's `=== null` never-saved check, and
 * `meta` is emitted only when both timestamps are present (a partial `meta` would
 * drop the token).
 */
function toSectionResponse<T extends ConfigSection>(
  sectionName: T,
  section: object,
): ConfigurationSectionView<T>;
function toSectionResponse(
  sectionName: ConfigSection,
  section: object,
): ConfigurationSectionView<ConfigSection> {
  const { meta, lastSavedBy, ...fields } = section as Record<string, unknown> &
    SmithySectionAudit;
  const complete = hasCompleteConfigurationResponseMetadata(meta);
  const response = {
    ...fields,
    lastSavedBy: lastSavedBy ?? null,
    meta: complete
      ? { createdTime: meta.createdTime, lastEditTime: meta.lastEditTime }
      : undefined,
  };

  switch (sectionName) {
    case "leases":
      return ConfigurationSectionViewSchemas.leases.parse(response);
    case "cleanup":
      return ConfigurationSectionViewSchemas.cleanup.parse(response);
    case "notification":
      return ConfigurationSectionViewSchemas.notification.parse(response);
    case "maintenance":
      return ConfigurationSectionViewSchemas.maintenance.parse(response);
    case "termsOfService":
      return ConfigurationSectionViewSchemas.termsOfService.parse(response);
    case "costReporting":
      return ConfigurationSectionViewSchemas.costReporting.parse(response);
    case "agent":
      return ConfigurationSectionViewSchemas.agent.parse(response);
  }
}

function requireConfigurationMember<T>(
  value: T | undefined,
  member: keyof SmithyAdminConfiguration,
): T {
  if (value === undefined) {
    throw new Error(`Configurations response is missing member: ${member}`);
  }
  return value;
}

/**
 * Maps the form payload (section fields plus `meta.lastEditTime`, the concurrency
 * token) to the Command input. Checked against `undefined`, not truthiness, so an
 * empty-string token is forwarded rather than downgrading the write to a first-save.
 */
function toUpdateInput(data: unknown): object {
  const { meta, ...fields } = (data ?? {}) as {
    meta?: { lastEditTime?: string };
    [field: string]: unknown;
  };
  return {
    ...fields,
    meta:
      meta?.lastEditTime === undefined
        ? undefined
        : { lastEditTime: meta.lastEditTime },
  };
}

export class SmithyConfigurationClient implements SmithyConfigurationApi {
  constructor(private readonly client: IsbClient) {}

  async getConfigurations(): Promise<AdminConfigurationView> {
    try {
      const output = await this.client.send(new GetConfigurationsCommand({}));
      const data = output.data;
      if (!data) {
        throw new Error("Configurations response did not contain data");
      }

      // Keep the aggregate mapping explicit so generated Smithy member changes
      // fail here instead of being hidden by a string-indexed loop.
      return {
        leases: toSectionResponse(
          "leases",
          requireConfigurationMember(data.leases, "leases"),
        ),
        cleanup: toSectionResponse(
          "cleanup",
          requireConfigurationMember(data.cleanup, "cleanup"),
        ),
        notification: toSectionResponse(
          "notification",
          requireConfigurationMember(data.notification, "notification"),
        ),
        maintenance: toSectionResponse(
          "maintenance",
          requireConfigurationMember(data.maintenance, "maintenance"),
        ),
        termsOfService: toSectionResponse(
          "termsOfService",
          requireConfigurationMember(data.termsOfService, "termsOfService"),
        ),
        costReporting: toSectionResponse(
          "costReporting",
          requireConfigurationMember(data.costReporting, "costReporting"),
        ),
        agent: toSectionResponse(
          "agent",
          requireConfigurationMember(data.agent, "agent"),
        ),
        isbManagedRegions: requireConfigurationMember(
          data.isbManagedRegions,
          "isbManagedRegions",
        ),
        awsAccessPortalUrl: requireConfigurationMember(
          data.awsAccessPortalUrl,
          "awsAccessPortalUrl",
        ),
        bedrockInferenceProfilePatterns: requireConfigurationMember(
          data.bedrockInferenceProfilePatterns,
          "bedrockInferenceProfilePatterns",
        ),
      } satisfies AdminConfigurationView;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getConfigurationSection<T extends ConfigSection>(
    section: T,
  ): Promise<ConfigurationSectionView<T>> {
    try {
      const Command = GET_SECTION_COMMANDS[section];
      // Erased dispatch requires the command cast; `send()` otherwise returns
      // the full service-output union. Both assertions are compiler-required.
      const command = new Command({}) as never; // NOSONAR typescript:S4325 -- required by tsc
      const output = (await this.client.send(command)) as ErasedSectionOutput; // NOSONAR typescript:S4325 -- required by tsc
      if (!output.data) {
        throw new Error(
          `Configuration section ${section} response had no data`,
        );
      }
      return toSectionResponse(section, output.data);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async putConfigurationSection<T extends ConfigSection>(
    section: T,
    data: ConfigurationSectionRequest<T>,
  ): Promise<ConfigurationSectionView<T>> {
    try {
      const Command = UPDATE_SECTION_COMMANDS[section];
      const command = new Command(toUpdateInput(data)) as never; // NOSONAR typescript:S4325 -- required by tsc
      const output = (await this.client.send(command)) as ErasedSectionOutput; // NOSONAR typescript:S4325 -- required by tsc
      if (!output.data) {
        throw new Error(
          `Configuration section ${section} response had no data`,
        );
      }
      return toSectionResponse(section, output.data);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
