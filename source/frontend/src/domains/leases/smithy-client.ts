// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Leases typed adapter over the generated aggregate `IsbClient`. The shared
// transport (signed client, CloudFront handler, JSend error normalization) lives
// in `helpers/isbApiClient`; this file is only the domain-specific command calls
// and input/output mappers. Every migrated domain follows the same shape.
//
// Unlike leaseTemplates there is NO Date<->ISO conversion here: lease timestamps
// (startDate, expirationDate, meta.createdTime, resourceLock.expiresAt, ...) are
// modeled as raw `String` (deviation #3), so the wire strings deserialize
// untouched. Explicit mappers keep generated-member drift visible; frontend
// schemas validate single-item reads and filter malformed entries from lists.

import { HttpRequest } from "@smithy/core/protocols";

import type {
  AssignmentView,
  BedrockTokenHistoryData as SmithyBedrockTokenHistoryData,
  BreachEntry as SmithyBreachEntry,
  BreachHistoryData as SmithyBreachHistoryData,
  BreachInsight as SmithyBreachInsight,
  CostHistoryCurrent as SmithyCostHistoryCurrent,
  CostHistoryData as SmithyCostHistoryData,
  CostHistoryResultRow as SmithyCostHistoryResultRow,
  CostSummaryData as SmithyCostSummaryData,
  CurrentServiceEntry as SmithyCurrentServiceEntry,
  LeaseAssignmentsView,
  LeaseWithId,
  RateLimitEntry as SmithyRateLimitEntry,
  SelectableModel,
  SharedLease,
  TokenSeriesRow as SmithyTokenSeriesRow,
  UpdateLeaseAssignmentsResult,
} from "@amzn/innovation-sandbox-api-client";
import {
  FreezeLeaseCommand,
  GetLeaseAssignmentsCommand,
  GetLeaseBedrockTokenHistoryCommand,
  GetLeaseBreachHistoryCommand,
  GetLeaseCommand,
  GetLeaseCostHistoryCommand,
  GetLeaseCostSummaryCommand,
  IsbClient,
  ListLeasesCommand,
  ListSharedLeasesCommand,
  RequestLeaseCommand,
  ReviewLeaseCommand,
  TerminateLeaseCommand,
  UnfreezeLeaseCommand,
  UpdateLeaseAssignmentsCommand,
  UpdateLeaseCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  GetLeaseAssignmentsResponse,
  GetLeaseAssignmentsResponseSchema,
  LeaseView,
  LeaseViewSchema,
  SharedLeaseView,
  SharedLeaseViewSchema,
  UpdateLeaseAssignmentsResponse,
  UpdateLeaseAssignmentsResponseSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  AssignmentPrincipalRef,
  BedrockTokenHistoryData,
  BreachEntry,
  BreachHistoryData,
  BreachInsight,
  CostHistoryCurrent,
  CostHistoryData,
  CostHistoryPageOptions,
  CostHistoryResultRow,
  CostSummaryData,
  CurrentServiceEntry,
  LeasePatchRequest,
  NewLeaseRequest,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";

// The access types the shared-lease QUERY endpoint actually accepts. The server
// (and the modeled `SharedLeaseAccessType` enum) only ever receives `direct` or
// `group`; the wider frontend `SharedLeaseAccessType`
// (`direct|group|owner|global`) exists solely for display components
// (AccessTypeBadge, the lease table), and its extra values are never routed to
// this endpoint. Narrowing the query param to this type removes the need for an
// `as` cast onto the generated command's input.
export type SharedLeaseQueryAccessType = "direct" | "group";

// Domain-scoped name for the shared signed-client factory.
export { createIsbClient as createLeaseClient } from "../../helpers/isbApiClient";

export interface SmithyLeaseApi {
  listLeases(
    pageIdentifier?: string,
    userEmail?: string,
  ): Promise<ApiPaginatedResult<LeaseView>>;
  getLease(leaseId: string): Promise<LeaseView>;
  requestLease(request: NewLeaseRequest): Promise<void>;
  updateLease(request: LeasePatchRequest): Promise<void>;
  reviewLease(leaseId: string, approve: boolean): Promise<void>;
  terminateLease(leaseId: string): Promise<void>;
  freezeLease(leaseId: string): Promise<void>;
  unfreezeLease(leaseId: string): Promise<void>;
  getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse>;
  updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse>;
  listSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
    maxResults: number,
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SharedLeaseView>>;
  getLeaseCostSummary(leaseId: string): Promise<CostSummaryData>;
  getLeaseCostHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<CostHistoryData>;
  getLeaseBedrockTokenHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BedrockTokenHistoryData>;
  getLeaseBreachHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BreachHistoryData>;
}

/**
 * Re-adds explicitly-cleared members as `null` to an already-serialized restJson1
 * request body. The serializer omits null members, but `UpdateLease`'s edit forms
 * use `null` to CLEAR maxSpend/expirationDate/costReportGroup (vs. an absent member
 * = leave unchanged), so `updateLease` restores them via a build-step middleware
 * before signing. `serializedBody` is the serializer's output; `@aws-sdk/core`'s
 * codec-v2 (`JsonCodec2`) hands it back as a `Uint8Array`, while older codecs used a
 * `string`, so decode both. An undefined/empty body is treated as `{}` (the command
 * carried no serializable members). Any other, non-empty body type throws rather
 * than silently starting from `{}` — otherwise a future codec change would again
 * drop the serializer's members and send only the null clears. Returns the
 * re-serialized body with each named member set to `null`. Exported for unit testing.
 */
export function reinjectNullMembers(
  serializedBody: unknown,
  members: string[],
): string {
  let text: string;
  if (serializedBody == null) {
    text = "";
  } else if (typeof serializedBody === "string") {
    text = serializedBody;
  } else if (ArrayBuffer.isView(serializedBody)) {
    // Realm-agnostic Uint8Array check (@aws-sdk/core codec-v2 bytes); `instanceof`
    // is unreliable across module/JS realms.
    text = new TextDecoder().decode(serializedBody);
  } else {
    throw new TypeError(
      `reinjectNullMembers: unsupported request body type "${typeof serializedBody}"`,
    );
  }
  const body =
    text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  for (const member of members) {
    body[member] = null;
  }
  return JSON.stringify(body);
}

function mapRateLimitEntry(entry: SmithyRateLimitEntry) {
  return {
    basis: entry.basis,
    rate: entry.rate,
    action: entry.action,
  } satisfies Record<keyof SmithyRateLimitEntry, unknown>;
}

function mapLease(lease: LeaseWithId) {
  // Keep every generated member explicit so additions to the Smithy response
  // cannot be silently dropped at the frontend boundary.
  const generatedLease = {
    userEmail: lease.userEmail,
    uuid: lease.uuid,
    status: lease.status,
    originalLeaseTemplateUuid: lease.originalLeaseTemplateUuid,
    originalLeaseTemplateName: lease.originalLeaseTemplateName,
    comments: lease.comments,
    createdBy: lease.createdBy,
    blueprintId: lease.blueprintId,
    blueprintName: lease.blueprintName,
    allowOwnerToShareLease: lease.allowOwnerToShareLease,
    predictiveBudgetEnabled: lease.predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled: lease.bedrockTokenMonitoringEnabled,
    sandboxSpacesEnabled: lease.sandboxSpacesEnabled,
    allowedModelIds: lease.allowedModelIds,
    defaultModelId: lease.defaultModelId,
    rateLimits: lease.rateLimits?.map(mapRateLimitEntry),
    lastPredictedSpend: lease.lastPredictedSpend,
    lastEvaluatedSpend: lease.lastEvaluatedSpend,
    lastEvaluatedHourlySpendRate: lease.lastEvaluatedHourlySpendRate,
    lastEvaluatedDailySpendRate: lease.lastEvaluatedDailySpendRate,
    desiredAssignments: lease.desiredAssignments,
    resourceLock: lease.resourceLock,
    maxSpend: lease.maxSpend,
    budgetThresholds: lease.budgetThresholds,
    leaseDurationInHours: lease.leaseDurationInHours,
    durationThresholds: lease.durationThresholds,
    costReportGroup: lease.costReportGroup,
    meta: lease.meta,
    awsAccountId: lease.awsAccountId,
    approvedBy: lease.approvedBy,
    startDate: lease.startDate,
    expirationDate: lease.expirationDate,
    lastCheckedDate: lease.lastCheckedDate,
    totalCostAccrued: lease.totalCostAccrued,
    endDate: lease.endDate,
    ttl: lease.ttl,
    leaseId: lease.leaseId,
    defaultPermissionSet: lease.defaultPermissionSet,
    allowedPermissionSets: lease.allowedPermissionSets,
    selectableModels: lease.selectableModels,
  } satisfies Record<keyof LeaseWithId, unknown>;

  const { selectableModels, ...frontendLease } = generatedLease;
  return {
    ...frontendLease,
    selectableModels: (selectableModels ?? []).map(toSelectableModel),
  };
}

function toSelectableModel(model: SelectableModel) {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    provider: model.provider,
  } satisfies Record<keyof SelectableModel, unknown>;
}

function mapSharedLease(lease: SharedLease) {
  const sharedFields = {
    accessType: lease.accessType,
    sourceGroupName: lease.sourceGroupName,
  } satisfies Record<Exclude<keyof SharedLease, keyof LeaseWithId>, unknown>;

  return { ...mapLease(lease), ...sharedFields };
}

function mapAssignment(assignment: AssignmentView) {
  return {
    principalId: assignment.principalId,
    principalType: assignment.principalType,
    assigneeEmail: assignment.assigneeEmail,
    displayName: assignment.displayName,
    addedBy: assignment.addedBy,
    addedDate: assignment.addedDate,
    isOwner: assignment.isOwner,
    isDesired: assignment.isDesired,
    syncStatus: assignment.syncStatus,
    permissionSet: assignment.permissionSet,
  } satisfies Record<keyof AssignmentView, unknown>;
}

function mapLeaseAssignments(assignments: LeaseAssignmentsView) {
  return {
    assignments: assignments.assignments?.map(mapAssignment),
    operationInProgress: assignments.operationInProgress,
  } satisfies Record<keyof LeaseAssignmentsView, unknown>;
}

function mapUpdateAssignments(result: UpdateLeaseAssignmentsResult) {
  return {
    desiredCount: result.desiredCount,
  } satisfies Record<keyof UpdateLeaseAssignmentsResult, unknown>;
}

// The cost summary and history pages are mapped onto the shared contract the
// panels read. Each mapper lists every member of both the generated shape and
// the contract, so a member added to only one of them fails to compile here.
// The generated shapes type even a required member `| undefined`; the server
// always sends one, so it is asserted present, as the contract types it. An
// optional member passes through as it came: absent where the server sent no
// value or a null, which restJson1 drops. As the assertion would hide a member
// that turns optional on one side only, the two must also mark the same members
// optional, or the mapper fails to satisfy `never`.
type OptionalMembers<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];
type EveryMember<Generated, Shared> = [OptionalMembers<Generated>] extends [
  OptionalMembers<Shared>,
]
  ? [OptionalMembers<Shared>] extends [OptionalMembers<Generated>]
    ? Record<keyof Generated | keyof Shared, unknown>
    : never
  : never;

function mapCurrentServiceEntry(
  entry: SmithyCurrentServiceEntry,
): CurrentServiceEntry {
  return {
    service: entry.service!,
    amount: entry.amount!,
    shareOfBilledCost: entry.shareOfBilledCost!,
    changePercent: entry.changePercent,
  } satisfies EveryMember<SmithyCurrentServiceEntry, CurrentServiceEntry>;
}

function mapCostHistoryCurrent(
  current: SmithyCostHistoryCurrent,
): CostHistoryCurrent {
  return {
    billedCostAccrued: current.billedCostAccrued!,
    predictedCost: current.predictedCost!,
    hourlyRate: current.hourlyRate,
    dailyRate: current.dailyRate,
    hourlyRateWindowHours: current.hourlyRateWindowHours,
    dailyRateWindowHours: current.dailyRateWindowHours,
    rateSource: current.rateSource,
    hoursToBudgetExhaustion: current.hoursToBudgetExhaustion,
    latestPeriodStart: current.latestPeriodStart!,
    lastReportedAt: current.lastReportedAt!,
    lastCheckedAt: current.lastCheckedAt!,
    // Empty where absent, as the services table already reads it.
    services: (current.services ?? []).map(mapCurrentServiceEntry),
  } satisfies EveryMember<SmithyCostHistoryCurrent, CostHistoryCurrent>;
}

function mapCostHistoryResultRow(
  row: SmithyCostHistoryResultRow,
): CostHistoryResultRow {
  return {
    timestamp: row.timestamp!,
    billedCostAccrued: row.billedCostAccrued!,
    predictedCostAtRefresh: row.predictedCostAtRefresh,
    serviceBreakdown: row.serviceBreakdown,
  } satisfies EveryMember<SmithyCostHistoryResultRow, CostHistoryResultRow>;
}

function mapTokenSeriesRow(row: SmithyTokenSeriesRow): TokenSeriesRow {
  return {
    timestamp: row.timestamp!,
    region: row.region!,
    modelId: row.modelId!,
    input: row.input!,
    output: row.output!,
    cacheRead: row.cacheRead!,
    cacheWrite: row.cacheWrite!,
    monitoredBedrockTokenCost: row.monitoredBedrockTokenCost,
  } satisfies EveryMember<SmithyTokenSeriesRow, TokenSeriesRow>;
}

function mapBreachInsight(insight: SmithyBreachInsight): BreachInsight {
  return {
    kind: insight.kind!,
    service: insight.service!,
    amount: insight.amount!,
    shareOfComparedSpend: insight.shareOfComparedSpend,
    changePercent: insight.changePercent,
  } satisfies EveryMember<SmithyBreachInsight, BreachInsight>;
}

function mapBreachEntry(entry: SmithyBreachEntry): BreachEntry {
  return {
    timestamp: entry.timestamp!,
    triggeredBy: entry.triggeredBy!,
    action: entry.action!,
    thresholdDollars: entry.thresholdDollars,
    thresholdRate: entry.thresholdRate,
    thresholdRateBasis: entry.thresholdRateBasis,
    thresholdHoursRemaining: entry.thresholdHoursRemaining,
    billedCostAtFire: entry.billedCostAtFire!,
    predictedCostAtFire: entry.predictedCostAtFire,
    rateAtFire: entry.rateAtFire,
    rateSourceAtFire: entry.rateSourceAtFire,
    evaluatedBy: entry.evaluatedBy!,
    evaluatedSpendAtFire: entry.evaluatedSpendAtFire,
    monitoredBedrockTokenCostAtFire: entry.monitoredBedrockTokenCostAtFire,
    insight:
      entry.insight === undefined ? undefined : mapBreachInsight(entry.insight),
  } satisfies EveryMember<SmithyBreachEntry, BreachEntry>;
}

// The input the cost, Bedrock token and breach history commands all take.
function toHistoryPageInput(leaseId: string, options: CostHistoryPageOptions) {
  return {
    leaseId,
    maxResults: options.maxResults,
    pageIdentifier: options.pageIdentifier,
    afterTimestamp: options.afterTimestamp,
    beforeTimestamp: options.beforeTimestamp,
  };
}

export class SmithyLeaseClient implements SmithyLeaseApi {
  constructor(private readonly client: IsbClient) {}

  async listLeases(
    pageIdentifier?: string,
    userEmail?: string,
  ): Promise<ApiPaginatedResult<LeaseView>> {
    try {
      const output = await this.client.send(
        new ListLeasesCommand({ pageIdentifier, userEmail }),
      );
      // A missing page is not equivalent to a valid empty result. Validate
      // members independently so one malformed lease does not hide the rest.
      if (!output.data?.result) {
        throw new Error("Leases list response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyLeaseClient",
          getItemId: (lease) => lease.leaseId ?? lease.uuid,
          items: output.data.result,
          itemType: "lease",
          mapItem: mapLease,
          schema: LeaseViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLease(leaseId: string): Promise<LeaseView> {
    try {
      const output = await this.client.send(new GetLeaseCommand({ leaseId }));
      // The handler returns 404 for a missing lease, and pre-Smithy
      // `ApiProxy.get` threw `ApiError` on that 404. Validate a successful
      // response so malformed data cannot enter frontend state.
      if (!output.data) {
        throw new Error("Lease response did not contain data");
      }
      return LeaseViewSchema.parse(mapLease(output.data));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async requestLease(request: NewLeaseRequest): Promise<void> {
    try {
      await this.client.send(
        new RequestLeaseCommand({
          leaseTemplateUuid: request.leaseTemplateUuid,
          comments: request.comments,
          userEmail: request.userEmail,
          assignments: request.assignments,
        }),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async updateLease(request: LeasePatchRequest): Promise<void> {
    const { leaseId, ...rest } = request;
    // The edit forms send an explicit `null` to CLEAR
    // maxSpend/expirationDate/costReportGroup/rateLimits/
    // allowedModelIds/defaultModelId
    // (vs. an absent member = leave
    // unchanged); the server's Zod re-parse reads a body `null` as clear. The
    // generated `restJson1` serializer OMITS null members, so it cannot carry the
    // clear signal on its own. Rather than delegate to `ApiProxy` (retired once
    // every domain is migrated), send the present (non-null) members through the
    // generated `UpdateLeaseCommand` as usual and re-inject the cleared members as
    // `null` into the serialized body (via `reinjectNullMembers`) with a
    // `build`-step middleware — the one restJson1-inexpressible bit. `build` runs
    // after serialization and before SigV4 signing (`finalizeRequest`), so the
    // signature covers the re-injected body. The result reproduces the pre-Smithy
    // wire (`{ ...rest }` with nulls preserved) byte-faithfully while keeping the
    // operation on the generated client. (Revisit if the clear-semantics are
    // redesigned to a serializable form — see the migration docs.)
    const clearedMembers = Object.keys(rest).filter(
      (key) => rest[key as keyof typeof rest] === null,
    );

    const command = new UpdateLeaseCommand({
      leaseId,
      // `?? undefined` drops an explicit `null` here so the serializer omits it;
      // the middleware below re-adds it. An absent (`undefined`) member stays
      // absent = leave unchanged.
      maxSpend: rest.maxSpend ?? undefined,
      budgetThresholds: rest.budgetThresholds,
      expirationDate: rest.expirationDate ?? undefined,
      durationThresholds: rest.durationThresholds,
      costReportGroup: rest.costReportGroup ?? undefined,
      allowOwnerToShareLease: rest.allowOwnerToShareLease,
      rateLimits: rest.rateLimits ?? undefined,
      predictiveBudgetEnabled: rest.predictiveBudgetEnabled,
      bedrockTokenMonitoringEnabled: rest.bedrockTokenMonitoringEnabled,
      sandboxSpacesEnabled: rest.sandboxSpacesEnabled,
      allowedModelIds: rest.allowedModelIds ?? undefined,
      defaultModelId: rest.defaultModelId ?? undefined,
      defaultPermissionSetArn: rest.defaultPermissionSet?.permissionSetArn,
      allowedPermissionSetArns: rest.allowedPermissionSets?.map(
        ({ permissionSetArn }) => permissionSetArn,
      ),
    });

    if (clearedMembers.length > 0) {
      command.middlewareStack.add(
        (next) => async (args) => {
          if (HttpRequest.isInstance(args.request)) {
            const body = reinjectNullMembers(args.request.body, clearedMembers);
            args.request.body = body;
            args.request.headers["content-type"] = "application/json";
            args.request.headers["content-length"] = String(
              new TextEncoder().encode(body).length,
            );
          }
          return next(args);
        },
        { step: "build", name: "reinjectClearedLeaseMembers" },
      );
    }

    try {
      await this.client.send(command);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async reviewLease(leaseId: string, approve: boolean): Promise<void> {
    try {
      await this.client.send(
        new ReviewLeaseCommand({
          leaseId,
          action: approve ? "Approve" : "Deny",
        }),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async terminateLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new TerminateLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async freezeLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new FreezeLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async unfreezeLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new UnfreezeLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse> {
    try {
      const output = await this.client.send(
        new GetLeaseAssignmentsCommand({ leaseId }),
      );
      // Data-bearing read: pre-Smithy returned the JSend `data` and consumers
      // dereference `assignments`, so guard a malformed success (missing `data`)
      // rather than returning `undefined`. A 404 still propagates as `ApiError`.
      if (!output.data) {
        throw new Error("Lease assignments response did not contain data");
      }
      return GetLeaseAssignmentsResponseSchema.parse(
        mapLeaseAssignments(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse> {
    try {
      const output = await this.client.send(
        new UpdateLeaseAssignmentsCommand({ leaseId, assignments }),
      );
      if (!output.data) {
        throw new Error(
          "Update lease assignments response did not contain data",
        );
      }
      return UpdateLeaseAssignmentsResponseSchema.parse(
        mapUpdateAssignments(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
    maxResults: number,
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SharedLeaseView>> {
    try {
      const output = await this.client.send(
        new ListSharedLeasesCommand({
          userId,
          // `accessType` is narrowed to `direct|group` — exactly the modeled
          // `SharedLeaseAccessType` enum the server accepts — so it flows into the
          // generated command's input without a cast. (The wider frontend
          // `SharedLeaseAccessType` is display-only and never reaches here.)
          accessType,
          maxResults,
          pageIdentifier,
        }),
      );
      if (!output.data?.result) {
        throw new Error("Shared leases response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyLeaseClient",
          getItemId: (lease) => lease.leaseId ?? lease.uuid,
          items: output.data.result,
          itemType: "shared lease",
          mapItem: mapSharedLease,
          schema: SharedLeaseViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLeaseCostSummary(leaseId: string): Promise<CostSummaryData> {
    try {
      const output = await this.client.send(
        new GetLeaseCostSummaryCommand({ leaseId }),
      );
      // `current` is legitimately absent where no reading is available.
      if (!output.data) {
        throw new Error("Lease cost summary response did not contain data");
      }
      const { current } = output.data;
      return {
        current:
          current === undefined ? undefined : mapCostHistoryCurrent(current),
      } satisfies EveryMember<SmithyCostSummaryData, CostSummaryData>;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLeaseCostHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<CostHistoryData> {
    try {
      const output = await this.client.send(
        new GetLeaseCostHistoryCommand(toHistoryPageInput(leaseId, options)),
      );
      // The generated shape types the required list optional and consumers map
      // over it unguarded, so a missing one fails here rather than as a
      // TypeError in a panel.
      if (!output.data?.result) {
        throw new Error("Lease cost history response did not contain data");
      }
      return {
        result: output.data.result.map(mapCostHistoryResultRow),
        nextPageIdentifier: output.data.nextPageIdentifier,
      } satisfies EveryMember<SmithyCostHistoryData, CostHistoryData>;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLeaseBedrockTokenHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BedrockTokenHistoryData> {
    try {
      const output = await this.client.send(
        new GetLeaseBedrockTokenHistoryCommand(
          toHistoryPageInput(leaseId, options),
        ),
      );
      // As for the cost history: a missing series fails here, not in the panel.
      if (!output.data?.result) {
        throw new Error(
          "Lease Bedrock token history response did not contain data",
        );
      }
      return {
        result: output.data.result.map(mapTokenSeriesRow),
        nextPageIdentifier: output.data.nextPageIdentifier,
      } satisfies EveryMember<
        SmithyBedrockTokenHistoryData,
        BedrockTokenHistoryData
      >;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLeaseBreachHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BreachHistoryData> {
    try {
      const output = await this.client.send(
        new GetLeaseBreachHistoryCommand(toHistoryPageInput(leaseId, options)),
      );
      // As for the cost history: a missing list fails here, not in the table.
      if (!output.data?.result) {
        throw new Error("Lease breach history response did not contain data");
      }
      return {
        result: output.data.result.map(mapBreachEntry),
        nextPageIdentifier: output.data.nextPageIdentifier,
      } satisfies EveryMember<SmithyBreachHistoryData, BreachHistoryData>;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
