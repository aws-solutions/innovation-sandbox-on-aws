// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Lease Templates typed adapter over the generated aggregate `IsbClient`. The
// shared transport (signed client, CloudFront handler, JSend error
// normalization) lives in `helpers/isbApiClient`; this file is only the
// domain-specific command calls and input/output mappers. Every migrated domain
// follows the same shape.
import { DateTime } from "luxon";

import type {
  BudgetThreshold as SmithyBudgetThreshold,
  DurationThreshold as SmithyDurationThreshold,
  LeaseTemplate as SmithyLeaseTemplate,
  RateLimitEntry as SmithyRateLimitEntry,
} from "@amzn/innovation-sandbox-api-client";
import {
  CreateLeaseTemplateCommand,
  CreateLeaseTemplateCommandInput,
  DeleteLeaseTemplateCommand,
  GetLeaseTemplateCommand,
  IsbClient,
  ListLeaseTemplatesCommand,
  UpdateLeaseTemplateCommand,
  UpdateLeaseTemplateCommandInput,
} from "@amzn/innovation-sandbox-api-client";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";
import { LeaseTemplateView, LeaseTemplateViewSchema } from "./model";
import {
  CreateLeaseTemplateRequest,
  UpdateLeaseTemplateRequest,
} from "./types";

// Domain-scoped name for the shared signed-client factory.
export { createIsbClient as createLeaseTemplateClient } from "../../helpers/isbApiClient";

export interface SmithyLeaseTemplateApi {
  listLeaseTemplates(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<LeaseTemplateView>>;
  createLeaseTemplate(leaseTemplate: CreateLeaseTemplateRequest): Promise<void>;
  getLeaseTemplate(id: string): Promise<LeaseTemplateView>;
  updateLeaseTemplate(
    id: string,
    body: UpdateLeaseTemplateRequest,
  ): Promise<void>;
  deleteLeaseTemplate(id: string): Promise<void>;
}

function toIsoString(value: Date | undefined): string | undefined {
  return value === undefined
    ? undefined
    : (DateTime.fromJSDate(value, { zone: "utc" }).toISO() ?? undefined);
}

function mapBudgetThreshold(threshold: SmithyBudgetThreshold) {
  return {
    dollarsSpent: threshold.dollarsSpent,
    action: threshold.action,
    triggerOn: threshold.triggerOn,
  } satisfies Record<keyof SmithyBudgetThreshold, unknown>;
}

function mapRateLimitEntry(entry: SmithyRateLimitEntry) {
  return {
    basis: entry.basis,
    rate: entry.rate,
    action: entry.action,
  } satisfies Record<keyof SmithyRateLimitEntry, unknown>;
}

function mapDurationThreshold(threshold: SmithyDurationThreshold) {
  return {
    hoursRemaining: threshold.hoursRemaining,
    action: threshold.action,
  } satisfies Record<keyof SmithyDurationThreshold, unknown>;
}

// The adapter maps and validates the generated response into the frontend-owned
// model. Two representation transforms remain:
//   1. Faithful restore: `@timestamp` members deserialize to `Date` objects; the
//      frontend type (and the old wire) use ISO strings, so `meta`'s timestamps
//      are converted back — matching the pre-Smithy string shape exactly.
//   2. Accepted canonicalization (NOT exact pre-Smithy behavior): the blueprint
//      members are coalesced `null` -> `undefined`. Pre-Smithy preserved whatever
//      the wire sent; here restJson1 has already collapsed null/absence, so this
//      only normalizes to the frontend's single no-blueprint value.
function mapLeaseTemplate(template: SmithyLeaseTemplate) {
  // Make every generated member explicit so a new optional field cannot be
  // silently dropped at the frontend boundary.
  const generatedTemplate = {
    uuid: template.uuid,
    name: template.name,
    description: template.description,
    requiresApproval: template.requiresApproval,
    createdBy: template.createdBy,
    visibility: template.visibility,
    maxSpend: template.maxSpend,
    budgetThresholds: template.budgetThresholds?.map(mapBudgetThreshold),
    leaseDurationInHours: template.leaseDurationInHours,
    durationThresholds: template.durationThresholds?.map(mapDurationThreshold),
    costReportGroup: template.costReportGroup,
    blueprintId: template.blueprintId ?? undefined,
    blueprintName: template.blueprintName ?? undefined,
    allowOwnerToShareLease: template.allowOwnerToShareLease,
    predictiveBudgetEnabled: template.predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled: template.bedrockTokenMonitoringEnabled,
    sandboxSpacesEnabled: template.sandboxSpacesEnabled,
    allowedModelIds: template.allowedModelIds,
    defaultModelId: template.defaultModelId,
    rateLimits: template.rateLimits?.map(mapRateLimitEntry),
    defaultPermissionSet: template.defaultPermissionSet,
    allowedPermissionSets: template.allowedPermissionSets,
    meta: template.meta
      ? {
          createdTime: toIsoString(template.meta.createdTime),
          lastEditTime: toIsoString(template.meta.lastEditTime),
          schemaVersion: template.meta.schemaVersion, // NOSONAR typescript:S1874: Preserve schemaVersion through the API metadata migration and read-modify-write flow.
        }
      : undefined,
  } satisfies Record<keyof SmithyLeaseTemplate, unknown>;

  return generatedTemplate;
}

function toLeaseTemplate(template: SmithyLeaseTemplate): LeaseTemplateView {
  return LeaseTemplateViewSchema.parse(mapLeaseTemplate(template));
}

function toCreateInput(
  leaseTemplate: CreateLeaseTemplateRequest,
): CreateLeaseTemplateCommandInput {
  return {
    name: leaseTemplate.name,
    description: leaseTemplate.description,
    requiresApproval: leaseTemplate.requiresApproval,
    visibility: leaseTemplate.visibility,
    maxSpend: leaseTemplate.maxSpend,
    budgetThresholds: leaseTemplate.budgetThresholds,
    leaseDurationInHours: leaseTemplate.leaseDurationInHours,
    durationThresholds: leaseTemplate.durationThresholds,
    costReportGroup: leaseTemplate.costReportGroup,
    blueprintId: leaseTemplate.blueprintId ?? undefined,
    allowOwnerToShareLease: leaseTemplate.allowOwnerToShareLease,
    predictiveBudgetEnabled: leaseTemplate.predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled: leaseTemplate.bedrockTokenMonitoringEnabled,
    sandboxSpacesEnabled: leaseTemplate.sandboxSpacesEnabled,
    allowedModelIds: leaseTemplate.allowedModelIds,
    defaultModelId: leaseTemplate.defaultModelId,
    rateLimits: leaseTemplate.rateLimits,
    defaultPermissionSetArn: leaseTemplate.defaultPermissionSetArn,
    allowedPermissionSetArns: leaseTemplate.allowedPermissionSetArns,
  };
}

/**
 * The pre-Smithy PUT body accepted `meta` and the store persists it (restoring
 * only `createdTime`), so the model declares it on `UpdateLeaseTemplateInput`
 * (see main.smithy). The frontend does a full read-modify-write and echoes the
 * fetched `meta` so `lastEditTime`/`schemaVersion` are not cleared on the stored
 * item.
 *
 * Note: this does NOT make the update optimistically concurrent. The store only
 * enforces `meta.lastEditTime` when its optional `expected` argument is passed,
 * and the update operation does not pass it — matching the pre-Smithy handler,
 * which also performs an unconditional (last-write-wins) overwrite. Echoing
 * `lastEditTime` back is a persistence courtesy, not a concurrency guard.
 */
function toUpdateInput(
  id: string,
  body: UpdateLeaseTemplateRequest,
): UpdateLeaseTemplateCommandInput {
  return {
    leaseTemplateId: id,
    name: body.name,
    description: body.description,
    requiresApproval: body.requiresApproval,
    visibility: body.visibility,
    maxSpend: body.maxSpend,
    budgetThresholds: body.budgetThresholds,
    leaseDurationInHours: body.leaseDurationInHours,
    durationThresholds: body.durationThresholds,
    costReportGroup: body.costReportGroup,
    blueprintId: body.blueprintId ?? undefined,
    allowOwnerToShareLease: body.allowOwnerToShareLease,
    predictiveBudgetEnabled: body.predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled: body.bedrockTokenMonitoringEnabled,
    sandboxSpacesEnabled: body.sandboxSpacesEnabled,
    allowedModelIds: body.allowedModelIds,
    defaultModelId: body.defaultModelId,
    rateLimits: body.rateLimits,
    defaultPermissionSetArn: body.defaultPermissionSet?.permissionSetArn,
    allowedPermissionSetArns: body.allowedPermissionSets?.map(
      ({ permissionSetArn }) => permissionSetArn,
    ),
    meta: body.meta
      ? {
          createdTime: body.meta.createdTime
            ? DateTime.fromISO(body.meta.createdTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          lastEditTime: body.meta.lastEditTime
            ? DateTime.fromISO(body.meta.lastEditTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          schemaVersion: body.meta.schemaVersion,
        }
      : undefined,
  };
}

export class SmithyLeaseTemplateClient implements SmithyLeaseTemplateApi {
  constructor(private readonly client: IsbClient) {}

  async listLeaseTemplates(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<LeaseTemplateView>> {
    try {
      const output = await this.client.send(
        new ListLeaseTemplatesCommand({ pageIdentifier }),
      );
      // Keep the envelope check: pre-Smithy a missing `data` was `undefined` and
      // dereferencing `response.result` threw. Validate list members independently
      // so one malformed template does not hide otherwise usable results.
      if (!output.data?.result) {
        throw new Error("Lease Template list response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyLeaseTemplateClient",
          getItemId: (template) => template.uuid,
          items: output.data.result,
          itemType: "lease template",
          mapItem: mapLeaseTemplate,
          schema: LeaseTemplateViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async createLeaseTemplate(
    leaseTemplate: CreateLeaseTemplateRequest,
  ): Promise<void> {
    try {
      await this.client.send(
        new CreateLeaseTemplateCommand(toCreateInput(leaseTemplate)),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLeaseTemplate(id: string): Promise<LeaseTemplateView> {
    try {
      const output = await this.client.send(
        new GetLeaseTemplateCommand({ leaseTemplateId: id }),
      );
      if (!output.data) {
        throw new Error("Lease Template response did not contain data");
      }
      return toLeaseTemplate(output.data);
    } catch (error) {
      // Trust the wire: the handler returns 404 for a missing template (see
      // lease-template-operations.ts), and pre-Smithy `ApiProxy.get` threw
      // `ApiError` on that 404 — it did not swallow it into `undefined`. Let the
      // normalized error propagate so the react-query consumer behaves as before.
      throw normalizeSmithyError(error);
    }
  }

  async updateLeaseTemplate(
    id: string,
    body: UpdateLeaseTemplateRequest,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateLeaseTemplateCommand(toUpdateInput(id, body)),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async deleteLeaseTemplate(id: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteLeaseTemplateCommand({ leaseTemplateId: id }),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
