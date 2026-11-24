// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccountNotFoundException,
  ConcurrentModificationException,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ConcurrentDataModificationException,
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { SsmIdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { DynamoLeaseCostHistoryStore } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/dynamo-lease-cost-history-store.js";
import { InvalidCostHistoryPageIdentifierError } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BedrockTokenRow,
  BedrockTokenRowSchema,
  BreachRecord,
  BreachRecordSchema,
  CostObservation,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedLease,
  PersistedLeaseSchema,
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  permissionSetCacheSk,
  PersistedPermissionSetCacheItemSchema,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";
import { leaseSk } from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import {
  PersistedGroupAssignmentSchema,
  PersistedPrincipalCacheItemSchema,
  PersistedUserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { DynamoSandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/dynamo-sandbox-spaces-usage-store.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  AccountNotInActiveError,
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
  NoAccountsAvailableError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import * as leaseAssignment from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import {
  IneligibleAssignmentPrincipalError,
  IneligibleLeaseOwnerError,
  MaxAssignmentsExceededError,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData as generateRawSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  buildCognitoClaims,
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  futureTtl,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  jsendFailBodyLike,
  m2mAdminUser,
  m2mUserRoleOnlyUser,
  mockAuthorizedContext,
  mockGlobalConfig,
  rawBodyLike,
  responseHeaders,
  responseHeadersWithErrorType,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  datetimeAsString,
  now,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  BudgetConfigSchema,
  DurationConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import {
  type DesiredAssignment,
  DesiredAssignmentSchema,
  LEASE_NOT_PENDING_REVIEW_ERROR,
  LeaseKeySchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { permissionSetIdFromArn } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import {
  buildM2mSyntheticEmail,
  IdcIdentitySchema,
  IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { randomUUID } from "crypto";
import { DateTime } from "luxon";

// acquireLock returns the persisted lock so callers can carry it onto a
// full-item put; mocks must resolve a lock rather than undefined.

// The generated restJson1 serializer projects each lease to its modeled shape:
// `meta.schemaVersion` is dropped (deviation #2), and members that are `null`
// (deviation #7 — e.g. blueprintId/blueprintName/approvedBy/awsAccountId) or
// `undefined` (unset optionals) are omitted from the body. All lease timestamps
// are raw `String` (deviation #3), emitted byte-faithfully. Expected success
// bodies are matched with `rawBodyLike` (order-insensitive, null/undefined
// dropped, timestamps NOT canonicalized) against this projection — note the
// matcher also drops null/undefined from the EXPECTED side, so it *tolerates*
// (does not pin) the deviation-#7 omission; the dedicated test below asserts it.
function projectLease(lease: Record<string, any>): Record<string, any> {
  // Drop `leaseTemplateUuid`: it is a request-only input field (the persisted
  // Lease exposes `originalLeaseTemplateUuid`), but the request-lease tests build
  // their stored-lease fixture from `PersistedPendingLeaseSchema.extend({ leaseTemplateUuid })`,
  // so it must be stripped here — the serializer only emits modeled members.
  const {
    meta,
    leaseTemplateUuid: _leaseTemplateUuid,
    // Persistence-only (lifecycle bookkeeping), not a modeled member.
    lifecycleDispatch: _lifecycleDispatch,
    defaultPermissionSetArn = userPermissionSetArn,
    allowedPermissionSetArns,
    ...rest
  } = lease;
  const toReference = (permissionSetArn: string) => ({
    permissionSetArn,
    permissionSetId: permissionSetIdFromArn(permissionSetArn),
    availability: "UNAVAILABLE",
  });

  return {
    ...rest,
    ...(meta
      ? {
          meta: {
            createdTime: meta.createdTime,
            lastEditTime: meta.lastEditTime,
          },
        }
      : {}),
    defaultPermissionSet: toReference(defaultPermissionSetArn),
    allowedPermissionSets: [
      ...new Set([
        defaultPermissionSetArn,
        ...(allowedPermissionSetArns ?? []),
      ]),
    ].map(toReference),
  };
}

function projectRequestedLease(
  lease: Record<string, any>,
): Record<string, any> {
  return projectLease(lease);
}

const MOCK_ACQUIRED_LOCK = {
  ownerId: "mock-lock-owner",
  acquiredAt: "2024-06-01T12:00:00.000Z",
  expiresAt: "2024-06-01T12:15:00.000Z",
};

let mockedGlobalConfig: GlobalConfig;
let mockedReportingConfig: ReportingConfig;
const userPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-user123456789012";
const adminPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-admin12345678901";
const managerPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-manager123456789";
const customPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-custom1234567890";
const secondCustomPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-second1234567890";

function generateSchemaData<T extends z.ZodTypeAny>(
  schema: T,
  overrides?: Partial<z.infer<T>>,
): z.infer<T> {
  const leaseSchemasWithOptionalPermissionProfiles: z.ZodTypeAny[] = [
    PersistedLeaseSchema,
    PersistedMonitoredLeaseSchema,
    PersistedPendingLeaseSchema,
    PersistedApprovalDeniedLeaseSchema,
    PersistedExpiredLeaseSchema,
  ];
  const assignmentSchemasWithOptionalPermissionProfiles: z.ZodTypeAny[] = [
    PersistedUserAssignmentSchema,
    PersistedGroupAssignmentSchema,
  ];

  return generateRawSchemaData(schema, {
    ...(Object.is(schema, PersistedLeaseTemplateSchema) ||
    leaseSchemasWithOptionalPermissionProfiles.some((candidate) =>
      Object.is(schema, candidate),
    )
      ? {
          defaultPermissionSetArn: undefined,
          allowedPermissionSetArns: undefined,
        }
      : {}),
    ...(leaseSchemasWithOptionalPermissionProfiles.some((candidate) =>
      Object.is(schema, candidate),
    )
      ? { desiredAssignments: undefined }
      : {}),
    ...(assignmentSchemasWithOptionalPermissionProfiles.some((candidate) =>
      Object.is(schema, candidate),
    )
      ? { permissionSetArn: undefined }
      : {}),
    ...overrides,
  } as Partial<z.infer<T>>);
}

function permissionSetCacheItem(permissionSetArn: string, name: string) {
  const permissionSetId = permissionSetIdFromArn(permissionSetArn)!;
  return generateSchemaData(PersistedPermissionSetCacheItemSchema, {
    pk: "permissionSetCache",
    sk: permissionSetCacheSk(permissionSetId),
    permissionSetArn,
    permissionSetId,
    name,
    description: `${name} description`,
    sessionDuration: "PT1H",
  });
}

const testEnv = generateSchemaData(LeaseLambdaEnvironmentSchema);
const testReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: false,
};
const testReportingConfigRequired = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: true,
};
let handler: typeof import("@amzn/innovation-sandbox-leases/leases-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (await import("@amzn/innovation-sandbox-leases/leases-handler.js"))
    .handler;
});

beforeEach(() => {
  mockedGlobalConfig = mockGlobalConfig();
  mockedGlobalConfig.leases.maxLeasesPerUser = 3;
  mockedGlobalConfig.leases.maxBudget = 50;
  mockedGlobalConfig.leases.maxDurationHours = 999;
  mockedGlobalConfig.leases.requireMaxBudget = true;
  mockedGlobalConfig.leases.requireMaxDuration = false;
  mockedGlobalConfig.leases.leaseSharingEnabled = true;
  mockedGlobalConfig.leases.groupAssignmentMode = "ALL";
  mockedGlobalConfig.leases.allowUserLeaseTermination = true;
  mockedGlobalConfig.leases.leaseRequestWindowHours = 168;
  mockedGlobalConfig.leases.maxLeaseRequestsPerWindow = 10;
  mockedGlobalConfig.leases.ttl = 30;
  mockedGlobalConfig.maintenance.enabled = false;

  mockedReportingConfig = {
    costReportGroups: [],
    requireCostReportGroup: false,
  };

  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

  // Empty catalog so lease-shape assertions do not depend on model policy.
  vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue([]);

  vi.spyOn(SsmIdcStackConfigStore.prototype, "get").mockResolvedValue({
    identityStoreId: "d-1234567890",
    ssoInstanceArn: "arn:aws:sso:::instance/ssoins-1234567890abcdef",
    adminGroupId: "admin-group",
    managerGroupId: "manager-group",
    userGroupId: "user-group",
    adminPermissionSetArn,
    managerPermissionSetArn,
    userPermissionSetArn,
    solutionVersion: "1.4.0",
    supportedSchemas: "1",
  });
  vi.spyOn(
    DynamoPrincipalStore.prototype,
    "getPermissionSetCacheItems",
  ).mockResolvedValue([]);

  // Default mock for principalStore.batchGetCacheItems — needed because
  // requestLease always enriches the owner's assignment at creation time.
  vi.spyOn(
    DynamoPrincipalStore.prototype,
    "batchGetCacheItems",
  ).mockImplementation(async (principalIds) =>
    principalIds.map((p) =>
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        principalId: p.principalId,
        principalType: p.principalType,
        email:
          p.principalType === "USER"
            ? `${p.principalId.slice(0, 8)}@example.com`
            : undefined,
      }),
    ),
  );
});

afterEach(() => {
  mockedGlobalConfig.leases.groupAssignmentMode = "ALL";
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Leases Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/leases",
    });
    expect(
      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  describe("GET /leases", () => {
    const allLeases: PersistedLease[] = [
      generateSchemaData(PersistedLeaseSchema, {}),
      generateSchemaData(PersistedLeaseSchema, {}),
    ];
    const allLeasesWithRefId = allLeases.map((lease) => {
      return {
        ...projectLease(lease),
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      };
    });

    it("should return 200 with all leases", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allLeases,
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("lists rateLimits and never a singular rateLimit", async () => {
      const rateLimits = [
        { basis: "HOURLY", rate: 8, action: "ALERT" },
      ] satisfies NonNullable<PersistedMonitoredLease["rateLimits"]>;
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockResolvedValue({
        result: [
          generateSchemaData(PersistedMonitoredLeaseSchema, {
            status: "Active",
            predictiveBudgetEnabled: true,
            rateLimits,
          }),
        ],
        nextPageIdentifier: null,
      });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leases",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const [item] = JSON.parse(response.body).data.result;
      expect(item.rateLimits).toEqual(rateLimits);
      expect(item).not.toHaveProperty("rateLimit");
    });

    it("does not query the agent model catalog", async () => {
      const getAgentModelsSpy = vi.spyOn(
        DynamoConfigStore.prototype,
        "getAgentModels",
      );
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allLeases,
          nextPageIdentifier: null,
        }),
      );
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leases",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(getAgentModelsSpy).not.toHaveBeenCalled();
    });

    it("hydrates available and unavailable permission sets once per list page", async () => {
      const lease = generateSchemaData(PersistedLeaseSchema, {
        defaultPermissionSetArn: customPermissionSetArn,
        allowedPermissionSetArns: [
          customPermissionSetArn,
          secondCustomPermissionSetArn,
        ],
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockResolvedValue({
        result: [lease],
        nextPageIdentifier: null,
      });
      const cacheSpy = vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      );
      cacheSpy.mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
      ]);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leases",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const responseLease = JSON.parse(response.body).data.result[0];
      expect(responseLease).not.toHaveProperty("defaultPermissionSetArn");
      expect(responseLease).not.toHaveProperty("allowedPermissionSetArns");
      expect(responseLease.defaultPermissionSet).toEqual(
        expect.objectContaining({
          permissionSetArn: customPermissionSetArn,
          name: "Custom profile",
          availability: "AVAILABLE",
        }),
      );
      expect(responseLease.allowedPermissionSets).toEqual([
        responseLease.defaultPermissionSet,
        {
          permissionSetArn: secondCustomPermissionSetArn,
          permissionSetId: permissionSetIdFromArn(secondCustomPermissionSetArn),
          availability: "UNAVAILABLE",
        },
      ]);
      expect(cacheSpy).toHaveBeenCalledExactlyOnceWith({});
    });

    it("drops null read-path members from the wire (deviation #7)", async () => {
      // `rawBodyLike` drops null/undefined on both sides, so it cannot pin the
      // deviation-#7 omission. Assert the raw body directly: a lease persisted with
      // null `blueprintId`/`blueprintName`/`approvedBy`/`awsAccountId` comes back
      // with those members ABSENT, not emitted as `null`.
      const leaseWithNulls = {
        ...generateSchemaData(PersistedLeaseSchema),
        blueprintId: null,
        blueprintName: null,
        approvedBy: null,
        awsAccountId: null,
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: [leaseWithNulls as any],
          nextPageIdentifier: null,
        }),
      );

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(200);
      const wireLease = JSON.parse(response.body).data.result[0];
      for (const dropped of [
        "blueprintId",
        "blueprintName",
        "approvedBy",
        "awsAccountId",
      ]) {
        expect(wireLease).not.toHaveProperty(dropped);
      }
    });

    it("should return 200 with all leases even when error is set", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allLeases,
          nextPageIdentifier: null,
          error: "Zod Validation Error",
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
            error: "Zod Validation Error",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with first page of leases when pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const findAllMethod = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allLeases,
            nextPageIdentifier: "BBB",
          }),
        );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: "BBB",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllMethod.mock.calls).toHaveLength(1);
      expect(findAllMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier,
          pageSize: Number(maxResults),
        },
      ]);
    });

    it.each([
      { userEmail: "test@example.com" },
      { userEmail: "test+subaddress@example.com" },
    ])(
      "should return 200 with leases belonging to the user provided",
      async ({ userEmail }) => {
        const urlencodedUserEmail = encodeURIComponent(userEmail);

        const leases = [
          generateSchemaData(PersistedLeaseSchema, {
            userEmail,
          }),
          generateSchemaData(PersistedLeaseSchema, {
            userEmail,
          }),
        ].map((lease) => ({
          ...lease,
          leaseId: base64EncodeCompositeKey({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          }),
        }));

        const event = createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leases`,
          queryStringParameters: {
            userEmail: urlencodedUserEmail,
            pageIdentifier: "next-page",
            maxResults: "7",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const findByUserEmailSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
          .mockReturnValue(
            Promise.resolve({
              result: leases,
              nextPageIdentifier: null,
            }),
          );

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 200,
          body: rawBodyLike({
            status: "success",
            data: {
              result: leases.map(projectLease),
              nextPageIdentifier: null,
            },
          }),
          headers: expect.objectContaining(responseHeaders),
        });
        expect(findByUserEmailSpy).toHaveBeenCalledWith({
          userEmail,
          pageIdentifier: "next-page",
          pageSize: 7,
        });
      },
    );

    it("should return 400 with first page when invalid query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const findAllMethod = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allLeases,
            nextPageIdentifier: "BBB",
          }),
        );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation (deviation #4): a malformed integer query param now
        // surfaces as the framework's SerializationException→400 (a generic
        // message) instead of the pre-Smithy Zod field error. Still a 400.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findAllMethod.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });

    it("should return 403 for findAllLeases when the user has only 'User' role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get all leases.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 403 for findLeaseByEmail when the user has only 'User' role and emails don't match", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const urlencodedUserEmail = encodeURIComponent(anotherEmail);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          userEmail: urlencodedUserEmail,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get the requested leases.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 400 and not touch the store when userEmail is malformed", async () => {
      // `userEmail` is modeled as an open `OwnerEmail` String (no `@pattern`), so a
      // malformed address passes model validation and reaches the operation, which
      // re-validates it with `z.email()` and 400s BEFORE any authorization or store
      // access — restoring the pre-Smithy `GetLeasesQueryParametersSchema`'s
      // `z.email().optional()` behavior.
      const findByUserEmailSpy = vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByUserEmail",
      );
      const findAllSpy = vi.spyOn(DynamoLeaseStore.prototype, "findAll");

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: { userEmail: "not-an-email" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: jsendFailBodyLike({
          field: "input",
          message: "Invalid email address",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
      expect(findAllSpy).not.toHaveBeenCalled();
    });

    it("should default pageSize to 2000 (findAll) when maxResults is omitted", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      const findAllSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockResolvedValue({ result: allLeases, nextPageIdentifier: null });

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(findAllSpy).toHaveBeenCalledWith({
        pageIdentifier: undefined,
        pageSize: 2000,
      });
    });

    it("should default pageSize to 2000 (findByUserEmail) when maxResults is omitted", async () => {
      const userEmail = "test@example.com";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: { userEmail: encodeURIComponent(userEmail) },
        isbUser: isbAuthorizedUser.user,
      });
      const findByUserEmailSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(findByUserEmailSpy).toHaveBeenCalledWith({
        userEmail,
        pageIdentifier: undefined,
        pageSize: 2000,
      });
    });
  });

  describe("POST /leases", () => {
    it.each(["default", "allowed"])(
      "rejects a new lease whose saved template retains an unavailable %s profile",
      async (kind) => {
        const template = generateSchemaData(PersistedLeaseTemplateSchema, {
          defaultPermissionSetArn:
            kind === "default" ? customPermissionSetArn : userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
          visibility: "PUBLIC",
          sandboxSpacesEnabled: false,
        });
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: template,
        });
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });
        const request = vi.spyOn(InnovationSandbox, "requestLease");
        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leases",
            body: JSON.stringify({ leaseTemplateUuid: template.uuid }),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toContain(
          "not registered",
        );
        expect(request).not.toHaveBeenCalled();
        expect(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).toHaveBeenCalledExactlyOnceWith({ consistentRead: true });
      },
    );

    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: with no body the model rejects the required
        // leaseTemplateUuid (generated ValidationError, alphabetized envelope)
        // rather than the pre-Smithy "Body not provided." message.
        body: jsendFailBodyLike({
          field: "leaseTemplateUuid",
          message:
            "Value at '/leaseTemplateUuid' failed to satisfy constraint: Member must not be null",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body is malformed json string", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: "just string",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body is not a valid lease object", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          abc: "ABC",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: model validation runs before the operation's strict
        // Zod re-parse, so the required-field violation (leaseTemplateUuid) is
        // reported by the generated ValidationError and short-circuits before the
        // unknown-key ("abc") check runs — a single error now, alphabetized envelope.
        body: jsendFailBodyLike({
          field: "leaseTemplateUuid",
          message:
            "Value at '/leaseTemplateUuid' failed to satisfy constraint: Member must not be null",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body carries an unknown key (guards InputLeaseSchema.strict())", async () => {
      // A well-formed request (valid `leaseTemplateUuid`) PLUS an unknown key. The
      // model passes (required field present; the restJson1 deserializer silently
      // drops the unknown member), so the 400 can only come from the operation's
      // `.strict()` Zod re-parse of the raw body. The "not a valid lease object"
      // test above short-circuits on the missing-required-field MODEL error and
      // never reaches this check — this is the dedicated unknown-key guard.
      const findByUserEmailSpy = vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByUserEmail",
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: "123e4567-e89b-42d3-a456-556642440000",
          unknownKey: "x",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: jsendFailBodyLike({
          field: "input",
          message: 'Unrecognized key: "unknownKey"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
    });

    it("should map an assignment-cap failure during lease creation to 400", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedLeaseTemplateSchema, {
          requiresApproval: true,
        }),
      });
      vi.spyOn(InnovationSandbox, "requestLease").mockRejectedValueOnce(
        new MaxAssignmentsExceededError(
          "Maximum of 20 total assignments allowed.",
        ),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "Maximum of 20",
      );
    });

    it("should map an ineligible assignment principal during lease creation to 400", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedLeaseTemplateSchema, {
          requiresApproval: true,
        }),
      });
      vi.spyOn(InnovationSandbox, "requestLease").mockRejectedValueOnce(
        new IneligibleAssignmentPrincipalError(),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors[0].message).toBe(
        "A lease assignment includes a user who is not a current Innovation Sandbox member.",
      );
    });

    it("should return 409 when user has exceeded the max number of active leases allowed", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: true,
          }),
        }),
      );
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
            generateSchemaData(PersistedPendingLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "PendingApproval",
            }),
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Frozen",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "You have reached the maximum number of active/pending leases allowed (3).",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 404 when the lease template reference doesn't exist", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease template not found.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 for when no accounts are available to lease", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockReturnValue(
        Promise.resolve(storedLease),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "delete").mockResolvedValue({});
      vi.spyOn(InnovationSandbox, "approveLease").mockImplementation(() => {
        throw new NoAccountsAvailableError();
      });
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvents",
      ).mockResolvedValue({} as any);

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "No accounts are available to lease.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 201 for manual approval lease request with valid inputs", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockResolvedValue(
        storedLease,
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: true,
          }),
        }),
      );
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue({} as any);
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectRequestedLease(storedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 201 for a template whose threshold equals maxSpend", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        requiresApproval: true,
        visibility: "PUBLIC",
        sandboxSpacesEnabled: false,
        predictiveBudgetEnabled: false,
        rateLimits: undefined,
        maxSpend: 50,
        budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: template,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: [], nextPageIdentifier: null },
      );
      const createSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "create")
        .mockImplementation(async (lease) => lease);
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue({} as any);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid: template.uuid }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          maxSpend: 50,
          budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
        }),
      );
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new AccountNotFoundException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new ConcurrentModificationException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new TooManyRequestsException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 429,
        body: createFailureResponseBody({
          message:
            "Could not move account due to too many requests. Please try again momentarily.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 201 for auto approval lease request with valid inputs", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockReturnValue(
        Promise.resolve(storedLease),
      );
      const approvedLease: PersistedLease = {
        ...storedLease,
        approvedBy: "AUTO_APPROVED",
        status: "Active",
        awsAccountId: "000000000000",
        startDate: now().toISO(),
        expirationDate: now().plus({ hour: 24 }).toISO(),
        lastCheckedDate: now().toISO(),
        totalCostAccrued: 0,
      };
      vi.spyOn(InnovationSandbox, "approveLease").mockReturnValue(
        Promise.resolve({
          newItem: approvedLease,
          oldItem: storedLease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectRequestedLease(approvedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    describe("Lease Assignment Flow", () => {
      const targetUserEmail = "target.user@example.com";
      const targetUser = generateSchemaData(IdcIdentitySchema, {
        email: targetUserEmail,
      });

      it("should return 201 when admin creates lease for another user", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: targetUserEmail,
          comments: "Lease assigned for training",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          visibility: "PRIVATE",
        });

        const resultLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          userEmail: targetUserEmail,
          createdBy: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
          status: "Active",
          approvedBy: isbAuthorizedUser.user.email,
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // Mock user lookup in IDC
        vi.spyOn(IsbServices, "idcService").mockReturnValue({
          getIsbMemberFromEmail: vi.fn().mockResolvedValue(targetUser),
        } as any);

        // Mock the requestLease call
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 201,
          body: rawBodyLike({
            status: "success",
            data: projectRequestedLease(resultLease),
          }),
          headers: expect.objectContaining(responseHeaders),
        });

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            targetUser,
            createdBy: isbAuthorizedUser.user.email,
            comments: leaseRequest.comments,
            permissionSetConfig: expect.objectContaining({
              defaultPermissionSetArn: userPermissionSetArn,
            }),
          }),
          expect.any(Object),
        );
      });

      it("should return 403 when user role tries to create lease for another user", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: targetUserEmail,
          comments: "Should be denied",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user, // Not authorized
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PUBLIC",
            }),
          }),
        );

        // Spy on requestLease
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 403,
          body: createFailureResponseBody({
            message:
              "Access denied. You do not have permission to create leases for other users.",
          }),
          headers: responseHeadersWithErrorType("AccessDeniedError"),
        });

        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 404 when target user is not an ISB member", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: "nonexistent@example.com",
          comments: "Target user is not eligible",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PUBLIC",
            }),
          }),
        );

        vi.spyOn(IsbServices, "idcService").mockReturnValue({
          getIsbMemberFromEmail: vi.fn().mockResolvedValue(undefined),
        } as any);

        // Spy on requestLease call
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 404,
          body: createFailureResponseBody({
            message: "User is not an eligible ISB member",
          }),
          headers: responseHeaders,
        });

        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 404 when user role tries to access private lease template", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Should be denied - private template",
        };

        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        // Mock private template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PRIVATE",
            }),
          }),
        );

        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, userOnlyContext);

        expect(response).toEqual({
          statusCode: 404,
          body: createFailureResponseBody({
            message: "Lease template not found.",
          }),
          headers: responseHeaders,
        });

        // Spy on requestLease call
        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 201 and allow manager to access private lease template for self", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Manager accessing private template",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          visibility: "PRIVATE",
          requiresApproval: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          createdBy: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        // Mock private template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // Mock the requestLease call
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response.statusCode).toBe(201);
        expect(JSON.parse(response.body).status).toBe("success");

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            targetUser: expect.objectContaining({
              email: isbAuthorizedUser.user.email,
              type: "user",
            }),
            comments: leaseRequest.comments,
            permissionSetConfig: expect.objectContaining({
              defaultPermissionSetArn: userPermissionSetArn,
            }),
          }),
          expect.any(Object),
        );
      });

      it("should not set createdBy when a user requests a lease with their own email (no auto-approval bypass)", async () => {
        const selfEmail = isbAuthorizedUserUserRoleOnly.user.email;
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: selfEmail,
          comments: "Self request with own email",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          visibility: "PUBLIC",
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: selfEmail,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // A plain User is subject to the rate limiter, which reads existing
        // leases; return none so the request proceeds to requestLease.
        vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
          Promise.resolve({
            result: [],
            nextPageIdentifier: null,
          }),
        );

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response.statusCode).toBe(201);
        // A self-referential userEmail must NOT be treated as a cross-user
        // assignment: createdBy stays undefined so requestLease honors the
        // template's requiresApproval flag instead of auto-approving.
        expect(requestLeaseSpy).toHaveBeenCalledTimes(1);
        const requestLeaseArg = requestLeaseSpy.mock.calls[0]![0];
        expect(requestLeaseArg.createdBy).toBeUndefined();
      });
    });

    describe("Pre-Approval Assignments", () => {
      it("should return 201 and pass assignments to requestLease", async () => {
        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "GROUP" as const,
          },
        ];
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Lease with pre-approval assignments",
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          allowOwnerToShareLease: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            assignments: assignments.map((assignment) => ({
              ...assignment,
              permissionSetArn: userPermissionSetArn,
            })),
            comments: leaseRequest.comments,
          }),
          expect.any(Object),
        );
      });

      it("should return 201 without assignments when none provided", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Regular lease without assignments",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data).toBeDefined();

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            assignments: undefined,
            comments: leaseRequest.comments,
          }),
          expect.any(Object),
        );
      });

      it("should return 400 when assignments exceed the sharing limit", async () => {
        const assignments = Array.from({ length: 21 }, (_, i) => ({
          principalId: `a1b2c3d4e5-${String(i).padStart(8, "0")}-e29b-41d4-a716-446655440000`,
          principalType: "USER" as const,
        }));
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("20");
      });

      it("should pass an assignments array with exactly 20 items to the facade", async () => {
        const assignments = Array.from({ length: 20 }, () => ({
          principalId: generateSchemaData(DesiredAssignmentSchema).principalId,
          principalType: "USER" as const,
        }));
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          allowOwnerToShareLease: true,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
          generateSchemaData(PersistedPendingLeaseSchema, {}),
        );

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
      });

      it("should return 400 when assignments contain duplicates", async () => {
        const duplicateId = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440001";
        const assignments = [
          { principalId: duplicateId, principalType: "USER" as const },
          { principalId: duplicateId, principalType: "USER" as const },
        ];
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            uuid: leaseRequest.leaseTemplateUuid,
            allowOwnerToShareLease: true,
          }),
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("principal");
      });

      it("should normalize one permission set per initial principal", async () => {
        const defaultPermissionSetArn =
          "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-default123456789";
        const customPermissionSetArn =
          "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-custom1234567890";
        const principalId = generateSchemaData(
          DesiredAssignmentSchema,
        ).principalId;
        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          allowOwnerToShareLease: true,
          defaultPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
        });
        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          defaultPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
        });
        const cacheItems = [
          [defaultPermissionSetArn, "Default profile"],
          [customPermissionSetArn, "Custom profile"],
        ].map(([permissionSetArn, name]) => {
          const permissionSetId = permissionSetArn!.split("/").at(-1)!;
          return generateSchemaData(PersistedPermissionSetCacheItemSchema, {
            pk: "permissionSetCache",
            sk: permissionSetCacheSk(permissionSetId),
            permissionSetArn,
            permissionSetId,
            name,
          });
        });

        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue(cacheItems);
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leases",
            body: JSON.stringify({
              leaseTemplateUuid: leaseTemplate.uuid,
              assignments: [
                { principalId, principalType: "USER" },
                {
                  principalId,
                  principalType: "GROUP",
                  permissionSetArn: customPermissionSetArn,
                },
              ],
            }),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            assignments: [
              {
                principalId,
                principalType: "USER",
                permissionSetArn: defaultPermissionSetArn,
              },
              {
                principalId,
                principalType: "GROUP",
                permissionSetArn: customPermissionSetArn,
              },
            ],
            permissionSetConfig: {
              defaultPermissionSetArn,
              allowedPermissionSetArns: [customPermissionSetArn],
            },
          }),
          expect.any(Object),
        );

        const wireLease = JSON.parse(response.body).data;
        expect(wireLease).not.toHaveProperty("defaultPermissionSetArn");
        expect(wireLease).not.toHaveProperty("allowedPermissionSetArns");
        expect(wireLease.defaultPermissionSet).toEqual(
          expect.objectContaining({
            permissionSetArn: defaultPermissionSetArn,
            name: "Default profile",
            availability: "AVAILABLE",
          }),
        );
        expect(wireLease.allowedPermissionSets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              permissionSetArn: defaultPermissionSetArn,
            }),
            expect.objectContaining({
              permissionSetArn: customPermissionSetArn,
            }),
          ]),
        );
      });

      it("should reject multiple permission sets for one principal", async () => {
        const defaultPermissionSetArn =
          "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-default123456789";
        const principalId = generateSchemaData(
          DesiredAssignmentSchema,
        ).principalId;
        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          allowOwnerToShareLease: true,
          defaultPermissionSetArn,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue([
          permissionSetCacheItem(defaultPermissionSetArn, "Registered default"),
        ]);
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leases",
            body: JSON.stringify({
              leaseTemplateUuid: leaseTemplate.uuid,
              assignments: [
                { principalId, principalType: "USER" },
                {
                  principalId,
                  principalType: "USER",
                  permissionSetArn: defaultPermissionSetArn,
                },
              ],
            }),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toContain(
          "only one permission set",
        );
        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it.each([
        ["system role", adminPermissionSetArn, "system role"],
        [
          "permission set outside the template snapshot",
          "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-outside123456789",
          "not allowed by this lease",
        ],
      ])(
        "should reject an initial assignment using a %s",
        async (_, permissionSetArn, message) => {
          const leaseTemplate = generateSchemaData(
            PersistedLeaseTemplateSchema,
            {
              uuid: randomUUID(),
              allowOwnerToShareLease: true,
              defaultPermissionSetArn: userPermissionSetArn,
            },
          );
          vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue(
            {
              result: leaseTemplate,
            },
          );

          const response = await handler(
            createAPIGatewayProxyEvent({
              httpMethod: "POST",
              path: "/leases",
              body: JSON.stringify({
                leaseTemplateUuid: leaseTemplate.uuid,
                assignments: [
                  {
                    principalId: generateSchemaData(DesiredAssignmentSchema)
                      .principalId,
                    principalType: "USER",
                    permissionSetArn,
                  },
                ],
              }),
              headers: { "Content-Type": "application/json" },
              isbUser: isbAuthorizedUser.user,
            }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );

          expect(response.statusCode).toBe(400);
          expect(JSON.parse(response.body).data.errors[0].message).toContain(
            message,
          );
        },
      );

      it("should reject group assignments for every role when groups are disabled", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const groupAssignment = generateSchemaData(DesiredAssignmentSchema, {
          principalType: "GROUP",
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments: [groupAssignment],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "New group assignments are not enabled",
        );
      });

      it("should return 400 when user provides assignments but leaseSharingEnabled is false", async () => {
        const disabledConfig = {
          ...mockedGlobalConfig,
          leases: { ...mockedGlobalConfig.leases, leaseSharingEnabled: false },
        };
        mockAppConfigMiddleware(disabledConfig, mockedReportingConfig);

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          allowOwnerToShareLease: true,
          visibility: "PUBLIC",
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: leaseTemplate.uuid,
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, disabledConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("sharing is not enabled");
      });

      it("should return 201 when leaseSharingEnabled is false and no assignments provided", async () => {
        const disabledConfig = {
          ...mockedGlobalConfig,
          leases: { ...mockedGlobalConfig.leases, leaseSharingEnabled: false },
        };
        mockAppConfigMiddleware(disabledConfig, mockedReportingConfig);

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          requiresApproval: true,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
          generateSchemaData(PersistedPendingLeaseSchema, {}),
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid: leaseTemplate.uuid }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, disabledConfig),
        );

        expect(response.statusCode).toBe(201);
      });

      it("should allow an explicit owner permission when lease sharing is disabled", async () => {
        const disabledConfig = {
          ...mockedGlobalConfig,
          leases: { ...mockedGlobalConfig.leases, leaseSharingEnabled: false },
        };
        mockAppConfigMiddleware(disabledConfig, mockedReportingConfig);

        const customPermissionSetArn =
          "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-custom1234567890";
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue([
          permissionSetCacheItem(customPermissionSetArn, "Registered custom"),
        ]);
        const owner = {
          ...isbAuthorizedUserUserRoleOnly.user,
          userId: generateSchemaData(DesiredAssignmentSchema).principalId,
        };
        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          visibility: "PUBLIC",
          allowOwnerToShareLease: false,
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
        });
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(
            generateSchemaData(PersistedPendingLeaseSchema, {}),
          );

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leases",
            body: JSON.stringify({
              leaseTemplateUuid: leaseTemplate.uuid,
              assignments: [
                {
                  principalId: owner.userId,
                  principalType: "USER",
                  permissionSetArn: customPermissionSetArn,
                },
              ],
            }),
            headers: { "Content-Type": "application/json" },
            isbUser: owner,
          }),
          {
            ...mockAuthorizedContext(testEnv, disabledConfig),
            user: owner,
          },
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            assignments: [
              expect.objectContaining({
                principalId: owner.userId,
                permissionSetArn: customPermissionSetArn,
              }),
            ],
          }),
          expect.any(Object),
        );
      });

      it("should return 403 when a regular user provides assignments for a template with allowOwnerToShareLease false", async () => {
        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          visibility: "PUBLIC",
          allowOwnerToShareLease: false,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        // A plain User is subject to the rate limiter, which reads existing
        // leases; return none so the request reaches the sharing gate.
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, userOnlyContext);

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "Owner sharing is not enabled",
        );
        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 201 when an Admin/Manager provides assignments even if allowOwnerToShareLease is false", async () => {
        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          allowOwnerToShareLease: false,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(
            generateSchemaData(PersistedPendingLeaseSchema, {}),
          );

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            assignments: assignments.map((assignment) => ({
              ...assignment,
              permissionSetArn: userPermissionSetArn,
            })),
          }),
          expect.any(Object),
        );
      });
    });
  });

  describe("GET /leases/{leaseId}", () => {
    it("should return 400 when leaseId contains characters outside the base64url alphabet", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/not*a*valid*id",
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: the leaseId `@pattern` violation is now rendered by
        // the generated ValidationError (framework message, alphabetized envelope)
        // rather than the pre-Smithy Zod regex message.
        body: jsendFailBodyLike({
          field: "leaseId",
          message:
            "Value at '/leaseId' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[A-Za-z0-9_-]+$",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when leaseId is alphabet-valid but not a decodable composite key", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/INVALID_LEASE_ID",
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when lease does not exist", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }), // record does not exist
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 403 (not 404) for a non-existent lease when caller is a 'User'", async () => {
      // Existence oracle guard: a non-admin/manager caller must not be able to
      // distinguish a missing lease (404) from an existing-but-inaccessible one
      // (403) via the status code. Both collapse to 403 for non-elevated users.
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }), // record does not exist
      );

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
    });

    it("should return 200 with lease", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(lease),
            leaseId: leaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("returns rateLimits and never a singular rateLimit", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const rateLimits = [
        { basis: "HOURLY", rate: 8, action: "ALERT" },
        { basis: "DAILY", rate: 120, action: "FREEZE_ACCOUNT" },
      ] satisfies NonNullable<PersistedMonitoredLease["rateLimits"]>;
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseKey,
        status: "Active",
        predictiveBudgetEnabled: true,
        rateLimits,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leases/${base64EncodeCompositeKey(leaseKey)}`,
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body).data;
      expect(data.rateLimits).toEqual(rateLimits);
      expect(data).not.toHaveProperty("rateLimit");
    });

    describe("selectableModels", () => {
      const catalogRow = (modelId: string, enabled: boolean) => ({
        modelId,
        enabled,
        displayName: `${modelId} name`,
        provider: "Anthropic",
        availability: "global",
        inputPricePer1KTokens: 1,
      });

      const getLeaseWith = async (
        allowedModelIds: string[] | undefined,
        options: {
          leaseSandboxSpacesEnabled?: boolean;
          globalSandboxSpacesEnabled?: boolean;
        } = {},
      ) => {
        const leaseKey = generateSchemaData(LeaseKeySchema);
        const lease = generateSchemaData(PersistedLeaseSchema, {
          ...leaseKey,
          allowedModelIds,
          sandboxSpacesEnabled: options.leaseSandboxSpacesEnabled ?? true,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: lease,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leases/${base64EncodeCompositeKey(leaseKey)}`,
          isbUser: isbAuthorizedUser.user,
        });
        mockedGlobalConfig.agent.sandboxSpacesEnabled =
          options.globalSandboxSpacesEnabled ?? true;
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
        const result = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(result.statusCode).toBe(200);
        return JSON.parse(result.body).data.selectableModels;
      };

      it.each([
        { leaseSandboxSpacesEnabled: false },
        { globalSandboxSpacesEnabled: false },
      ])(
        "leaves the member unset and does not read the catalog when %o",
        async (options) => {
          const getAgentModelsSpy = vi.spyOn(
            DynamoConfigStore.prototype,
            "getAgentModels",
          );
          expect(await getLeaseWith(undefined, options)).toBeUndefined();
          expect(getAgentModelsSpy).not.toHaveBeenCalled();
        },
      );

      it("returns every enabled model with display fields only when the lease has no subset", async () => {
        vi.spyOn(
          DynamoConfigStore.prototype,
          "getAgentModels",
        ).mockResolvedValue([
          catalogRow("model-a", true),
          catalogRow("model-b", false),
          catalogRow("model-c", true),
        ] as never);

        expect(await getLeaseWith(undefined)).toEqual([
          {
            modelId: "model-a",
            displayName: "model-a name",
            provider: "Anthropic",
          },
          {
            modelId: "model-c",
            displayName: "model-c name",
            provider: "Anthropic",
          },
        ]);
      });

      it("narrows to the lease subset and drops a subset member that is disabled", async () => {
        vi.spyOn(
          DynamoConfigStore.prototype,
          "getAgentModels",
        ).mockResolvedValue([
          catalogRow("model-a", true),
          catalogRow("model-b", false),
          catalogRow("model-c", true),
        ] as never);

        expect(
          (await getLeaseWith(["model-b", "model-c"])).map(
            (model: { modelId: string }) => model.modelId,
          ),
        ).toEqual(["model-c"]);
      });
    });

    it("round-trips a ttl above the signed 32-bit ceiling on the read path", async () => {
      // `ttl` is modeled as `Long`, not `Integer` (deviation): a Unix-epoch-second
      // value crosses 2,147,483,647 (Jan 2038). Prove a value above the 32-bit
      // ceiling survives the read serialization intact — no overflow/truncation.
      const largeTtl = 2_200_000_000; // > 2_147_483_647
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        ...leaseKey,
        ttl: largeTtl,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(lease),
            leaseId: leaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Belt-and-braces: the exact numeric value survives on the wire.
      expect(JSON.parse(response.body).data.ttl).toBe(largeTtl);
    });

    it("should return 200 when requesting somebody else's lease as 'Admin' or 'Manager'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUser.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(lease),
            leaseId: leaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when requesting somebody else's lease as 'User'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: undefined,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 200 when requesting somebody else's lease as 'User' with shared access via desiredAssignments", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: isbAuthorizedUserUserRoleOnly.user.userId,
            principalType: "USER",
            displayName: "Test User",
            email: isbAuthorizedUserUserRoleOnly.user.email,
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(lease),
            leaseId: leaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when requesting somebody else's lease as 'User' without shared access", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: "some-other-user-id",
            principalType: "USER",
            displayName: "Other User",
            email: "other@example.com",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 200 when requesting somebody else's lease as 'User' with group-based shared access", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const groupId = "group-shared-123";
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: groupId,
            principalType: "GROUP",
            displayName: "Engineering Team",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: lease }),
      );
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getGroupMembershipCache",
      ).mockResolvedValue({
        result: {
          pk: `user#${isbAuthorizedUserUserRoleOnly.user.userId}`,
          sk: "groupMembership",
          groupIds: [groupId, "other-group"],
          ttl: 9999999999,
        },
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(lease),
            leaseId: leaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when user is not a member of the group in desiredAssignments", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: "group-not-mine",
            principalType: "GROUP",
            displayName: "Other Team",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: lease }),
      );
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getGroupMembershipCache",
      ).mockResolvedValue({
        result: {
          pk: `user#${isbAuthorizedUserUserRoleOnly.user.userId}`,
          sk: "groupMembership",
          groupIds: ["my-group-1", "my-group-2"],
          ttl: 9999999999,
        },
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 500 when data store call fails", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  describe("PATCH /leases/{leaseId}", () => {
    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: "/leases/LEASE101",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: PATCH has no required model members, so an absent
        // body passes model validation and is caught by the operation's strict Zod
        // re-parse (delegated 400) as "expected object, received undefined" rather
        // than the pre-Smithy "Body not provided." message.
        body: createFailureResponseBody({
          field: "input",
          message: "Invalid input: expected object, received undefined",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body doesn't contain any valid keys to update", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          abc: "ABC",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "abc"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when the lease to patch doesn't exist", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          expirationDate: new Date().toISOString(),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when the body contains fields that cannot be patched", async () => {
      const requestJsonBody = {
        expirationDate: new Date().toISOString(),
        userEmail: "new.user@example.com", // cannot update this field
        leaseTerms: {
          budgetThresholds: [
            {
              dollarAmount: 100,
              action: "RECLAIM_ACCOUNT",
            },
          ],
          durationThresholds: [
            {
              afterDurationHours: 100,
              action: "RECLAIM_ACCOUNT",
            },
          ],
        },
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: "/leases/LEASE101",
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized keys: "userEmail", "leaseTerms"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when patching a pending lease", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedPendingLeaseSchema, {
        meta: undefined,
        ...leaseCompositeKey,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const requestJsonBody = {
        ...generateSchemaData(BudgetConfigSchema, {
          rateLimits: undefined,
          maxSpend: 20,
        }),
        ...generateSchemaData(
          DurationConfigSchema.omit({ leaseDurationInHours: true }),
        ),
      };

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Can only update an active lease",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it.each([
      { name: "expired", leaseType: PersistedExpiredLeaseSchema },
      { name: "pending", leaseType: PersistedPendingLeaseSchema },
      { name: "denied", leaseType: PersistedApprovalDeniedLeaseSchema },
    ])(
      "should return 400 when patching a(n) $name lease",
      async ({ leaseType }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(leaseType, {
          meta: undefined,
          ...leaseCompositeKey,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          ...generateSchemaData(BudgetConfigSchema, {
            rateLimits: undefined,
            maxSpend: 20,
          }),
          ...generateSchemaData(
            DurationConfigSchema.omit({ leaseDurationInHours: true }),
          ),
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: "Can only update an active lease",
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it("returns 409 when patching a lease with an active operation lock", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        resourceLock: {
          ownerId: "assignment-update",
          acquiredAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          meta: { intent: "UPDATE" },
        },
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      const updateSpy = vi.spyOn(DynamoLeaseStore.prototype, "update");

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            allowOwnerToShareLease: !oldLease.allowOwnerToShareLease,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "Another operation is in progress",
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it.each([
      {
        budget: 100,
        duration: 24,
        expectedError:
          "Max budget cannot be greater than the global max budget (50).",
      },
      {
        budget: 20,
        duration: 100,
        expectedError:
          "Duration cannot be greater than the global max duration (48).",
      },
      {
        budget: undefined,
        duration: 24,
        expectedError:
          "A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.",
      },
      {
        budget: 20,
        duration: undefined,
        expectedError:
          "A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.",
      },
    ])(
      "should return 400 when the patch would violate global config constraints",
      async ({ budget, duration, expectedError }) => {
        mockedGlobalConfig.leases.maxDurationHours = 48;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.maxBudget = 50;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockAppConfigMiddleware(mockedGlobalConfig);

        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const startDate = <DateTime<true>>DateTime.fromObject(
          {
            year: 2025,
            month: 5,
            day: 2,
            hour: 12,
          },
          { zone: "utc" },
        );
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          meta: undefined,
          ...leaseCompositeKey,
          maxSpend: 25,
          leaseDurationInHours: 24,
          startDate: datetimeAsString(startDate),
          expirationDate: datetimeAsString(startDate.plus({ hours: 24 })),
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          expirationDate: duration
            ? datetimeAsString(startDate.plus({ hours: duration }))
            : null,
          maxSpend: budget ?? null,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([
      {
        // Setting an invalid group is blocked regardless of the previous value.
        patchCostReportGroup: "invalid-group",
        previousCostReportGroup: undefined,
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        // Clearing a previously-set group (null) when one is required is blocked.
        patchCostReportGroup: null,
        previousCostReportGroup: "valid-group-1",
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when the patch would violate cost reporting constraints",
      async ({
        patchCostReportGroup,
        previousCostReportGroup,
        reportingConfig,
        expectedError,
      }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          costReportGroup: previousCostReportGroup,
          startDate: new Date().toISOString(),
          expirationDate: undefined,
          budgetThresholds: undefined,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          maxSpend: 20,
          costReportGroup: patchCostReportGroup,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([{ status: "Active" }, { status: "Frozen" }])(
      "should return 200 for a valid patch request on a(n) $status lease",
      async ({ status }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          rateLimits: undefined,
          ...leaseCompositeKey,
          status: <"Active" | "Frozen">status,
          leaseDurationInHours: 48,
          costReportGroup: undefined,
          startDate: new Date().toISOString(),
          budgetThresholds: undefined,
          durationThresholds: undefined,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          expirationDate: new Date().toISOString(),
          ...generateSchemaData(BudgetConfigSchema, {
            rateLimits: undefined,
            maxSpend: 20, //mockGlobalConfig.maxSpend is 50
            budgetThresholds: undefined,
          }),
          ...generateSchemaData(
            DurationConfigSchema.omit({ leaseDurationInHours: true }),
            { durationThresholds: undefined },
          ),
          costReportGroup: undefined,
        };

        const updatedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...oldLease,
          ...requestJsonBody,
        });

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const spyPut = vi
          .spyOn(DynamoLeaseStore.prototype, "update")
          .mockReturnValue(
            Promise.resolve({
              newItem: updatedLease,
              oldItem: oldLease,
            }),
          );

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 200,
          body: rawBodyLike({
            status: "success",
            data: projectLease(updatedLease),
          }),
          headers: expect.objectContaining(responseHeaders),
        });
        expect(spyPut).toHaveBeenCalledOnce();
        expect(spyPut).toHaveBeenCalledWith(
          {
            ...updatedLease,
            ...requestJsonBody,
          },
          oldLease,
        );
      },
    );

    it("round-trips a registered profile edit, narrows unused profiles, and persists no hydrated metadata", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const desiredPrincipalId = randomUUID();
      const persistedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        costReportGroup: undefined,
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        startDate: "2030-01-01T00:00:00.000Z",
        expirationDate: "2030-01-03T00:00:00.000Z",
        defaultPermissionSetArn: userPermissionSetArn,
        allowedPermissionSetArns: [
          customPermissionSetArn,
          secondCustomPermissionSetArn,
        ],
        desiredAssignments: [
          {
            principalId: desiredPrincipalId,
            principalType: "USER",
            permissionSetArn: customPermissionSetArn,
          },
        ],
      });
      const leaseWithResponseMetadata = {
        ...persistedLease,
        defaultPermissionSet: {},
        allowedPermissionSets: [],
      };
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: leaseWithResponseMetadata as PersistedLease,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
      ]);

      const updatedLease = {
        ...persistedLease,
        defaultPermissionSetArn: customPermissionSetArn,
        allowedPermissionSetArns: [userPermissionSetArn],
      };
      const updateSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockResolvedValue({
          oldItem: persistedLease,
          newItem: updatedLease,
        });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: customPermissionSetArn,
            allowedPermissionSetArns: [userPermissionSetArn],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).toHaveBeenCalledExactlyOnceWith({ consistentRead: true });

      expect(updateSpy).toHaveBeenCalledWith(
        updatedLease,
        leaseWithResponseMetadata,
      );
      const persistedArgument = updateSpy.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(persistedArgument).not.toHaveProperty("defaultPermissionSet");
      expect(persistedArgument).not.toHaveProperty("allowedPermissionSets");

      const responseLease = JSON.parse(response.body).data;
      expect(responseLease).not.toHaveProperty("defaultPermissionSetArn");
      expect(responseLease).not.toHaveProperty("allowedPermissionSetArns");
      expect(responseLease.defaultPermissionSet).toEqual(
        expect.objectContaining({
          permissionSetArn: customPermissionSetArn,
          name: "Custom profile",
          availability: "AVAILABLE",
        }),
      );
      expect(responseLease.allowedPermissionSets).toEqual([
        responseLease.defaultPermissionSet,
        {
          permissionSetArn: userPermissionSetArn,
          permissionSetId: permissionSetIdFromArn(userPermissionSetArn),
          availability: "UNAVAILABLE",
        },
      ]);
    });

    it("preserves the previous effective profile on legacy desired rows when the default changes", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const desiredPrincipalId = randomUUID();
      const persistedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        costReportGroup: undefined,
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        startDate: "2030-01-01T00:00:00.000Z",
        expirationDate: "2030-01-03T00:00:00.000Z",
        resourceLock: undefined,
        defaultPermissionSetArn: userPermissionSetArn,
        allowedPermissionSetArns: [customPermissionSetArn],
        desiredAssignments: [
          {
            principalId: desiredPrincipalId,
            principalType: "USER",
          },
        ],
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: persistedLease,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
      ]);
      const updateSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockImplementation(async (lease) => ({
          oldItem: persistedLease,
          newItem: lease,
        }));

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: customPermissionSetArn,
            allowedPermissionSetArns: [userPermissionSetArn],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPermissionSetArn: customPermissionSetArn,
          desiredAssignments: [
            expect.objectContaining({
              principalId: desiredPrincipalId,
              permissionSetArn: userPermissionSetArn,
            }),
          ],
        }),
        persistedLease,
      );
    });

    it("leaves legacy desired rows unchanged when the permission-set default does not change", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const desiredAssignment = {
        principalId: randomUUID(),
        principalType: "USER" as const,
      };
      const persistedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        costReportGroup: undefined,
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        startDate: "2030-01-01T00:00:00.000Z",
        expirationDate: "2030-01-03T00:00:00.000Z",
        resourceLock: undefined,
        defaultPermissionSetArn: userPermissionSetArn,
        allowedPermissionSetArns: [customPermissionSetArn],
        desiredAssignments: [desiredAssignment],
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: persistedLease,
      });
      const updateSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockImplementation(async (lease) => ({
          oldItem: persistedLease,
          newItem: lease,
        }));

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: userPermissionSetArn,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          desiredAssignments: [desiredAssignment],
        }),
        persistedLease,
      );
      expect(
        updateSpy.mock.calls[0]![0].desiredAssignments![0],
      ).not.toHaveProperty("permissionSetArn");
    });

    it("does not mask unexpected permission-profile validation errors", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const persistedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        costReportGroup: undefined,
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        startDate: "2030-01-01T00:00:00.000Z",
        expirationDate: "2030-01-03T00:00:00.000Z",
        defaultPermissionSetArn: userPermissionSetArn,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: persistedLease,
      });
      vi.mocked(SsmIdcStackConfigStore.prototype.get).mockResolvedValueOnce({
        identityStoreId: "d-1234567890",
        get ssoInstanceArn(): string {
          throw new Error("Unexpected permission-profile validation failure");
        },
        adminGroupId: "admin-group",
        managerGroupId: "manager-group",
        userGroupId: "user-group",
        adminPermissionSetArn,
        managerPermissionSetArn,
        userPermissionSetArn,
        solutionVersion: "1.4.0",
        supportedSchemas: "1",
      });
      const updateSpy = vi.spyOn(DynamoLeaseStore.prototype, "update");

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: customPermissionSetArn,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(500);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("returns 409 when the lease changes after PATCH reads it", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        budgetThresholds: undefined,
        durationThresholds: undefined,
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockRejectedValue(
        new ConcurrentDataModificationException("stale"),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            allowOwnerToShareLease: !oldLease.allowOwnerToShareLease,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "Retry with the latest lease state",
      );
      vi.mocked(DynamoLeaseStore.prototype.update).mockRestore();
    });

    it("does not change account tags after a conflicting PATCH", async () => {
      mockAppConfigMiddleware(mockedGlobalConfig, {
        costReportGroups: ["new-group"],
        requireCostReportGroup: false,
      });
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        resourceLock: undefined,
        maxSpend: 25,
        leaseDurationInHours: 48,
        budgetThresholds: undefined,
        durationThresholds: undefined,
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      const writeSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockRejectedValue(
          new ConcurrentDataModificationException("assignment state changed"),
        );
      const taggingSpy = vi.spyOn(IsbServices, "organizationsTaggingService");
      const eventSpy = vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvent");

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({ costReportGroup: "new-group" }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(taggingSpy).not.toHaveBeenCalled();
      expect(eventSpy).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "the lease disappears before persistence",
        error: new UnknownItem("Lease not found."),
        expectedStatus: 404,
      },
      {
        name: "the lease store fails unexpectedly",
        error: new Error("Unexpected update failure"),
        expectedStatus: 500,
      },
    ])(
      "returns $expectedStatus when $name",
      async ({ error, expectedStatus }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const persistedLease = generateSchemaData(
          PersistedMonitoredLeaseSchema,
          {
            costReportGroup: undefined,
            ...leaseCompositeKey,
            status: "Active",
            maxSpend: 25,
            leaseDurationInHours: 48,
            startDate: "2030-01-01T00:00:00.000Z",
            expirationDate: "2030-01-03T00:00:00.000Z",
            resourceLock: undefined,
          },
        );
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: persistedLease,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "update").mockRejectedValueOnce(
          error,
        );

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PATCH",
            path: `/leases/${leaseId}`,
            body: JSON.stringify({
              allowOwnerToShareLease: !persistedLease.allowOwnerToShareLease,
            }),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(expectedStatus);
      },
    );

    it("returns 400 when a direct profile edit adds an uncached permission set", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          status: "Active",
          defaultPermissionSetArn: userPermissionSetArn,
        }),
      });
      const updateSpy = vi.spyOn(DynamoLeaseStore.prototype, "update");

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            allowedPermissionSetArns: [customPermissionSetArn],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "not registered",
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it.each([adminPermissionSetArn, managerPermissionSetArn])(
      "returns 400 when a direct profile edit selects system role %s",
      async (permissionSetArn) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: generateSchemaData(PersistedMonitoredLeaseSchema, {
            ...leaseCompositeKey,
            status: "Active",
            defaultPermissionSetArn: userPermissionSetArn,
          }),
        });

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PATCH",
            path: `/leases/${leaseId}`,
            body: JSON.stringify({
              allowedPermissionSetArns: [permissionSetArn],
            }),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toContain(
          "system role",
        );
      },
    );

    it("returns 409 when profile narrowing removes a desired assignment's permission set", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          status: "Active",
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
          desiredAssignments: [
            {
              principalId: randomUUID(),
              principalType: "USER",
              permissionSetArn: customPermissionSetArn,
            },
          ],
        }),
      });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            allowedPermissionSetArns: [],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "still used by a desired assignment",
      );
      expect(response.headers).toEqual(
        expect.objectContaining(responseHeadersWithErrorType("ConflictError")),
      );
    });

    it("returns 409 when profile narrowing removes a legacy owner's implicit permission set", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          status: "Active",
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
          desiredAssignments: undefined,
        }),
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
      ]);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: customPermissionSetArn,
            allowedPermissionSetArns: [],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).data.errors[0].message).toContain(
        "legacy owner assignment",
      );
      expect(response.headers).toEqual(
        expect.objectContaining(responseHeadersWithErrorType("ConflictError")),
      );
    });

    it("allows removing a custom default that a legacy owner never used", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const persistedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        costReportGroup: undefined,
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 25,
        leaseDurationInHours: 48,
        startDate: "2030-01-01T00:00:00.000Z",
        expirationDate: "2030-01-03T00:00:00.000Z",
        resourceLock: undefined,
        defaultPermissionSetArn: customPermissionSetArn,
        allowedPermissionSetArns: [userPermissionSetArn],
        desiredAssignments: undefined,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: persistedLease,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(userPermissionSetArn, "Built-in user access"),
      ]);
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockImplementation(
        async (lease) => ({
          oldItem: persistedLease,
          newItem: lease,
        }),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            defaultPermissionSetArn: userPermissionSetArn,
            allowedPermissionSetArns: [],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
    });

    describe("rateLimits", () => {
      const rateLimits = [
        { basis: "HOURLY", rate: 10, action: "FREEZE_ACCOUNT" },
        { basis: "HOURLY", rate: 15, action: "ALERT" },
      ] as const;
      const patchLease = async (
        predictiveBudgetEnabled: boolean,
        requestJsonBody: Record<string, unknown>,
        existingRateFields: Pick<PersistedMonitoredLease, "rateLimits"> = {
          rateLimits: [{ basis: "DAILY", rate: 75, action: "ALERT" }],
        },
        globalConfig: typeof mockedGlobalConfig = mockedGlobalConfig,
      ) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...existingRateFields,
          predictiveBudgetEnabled,
          ...leaseCompositeKey,
          status: "Active",
          leaseDurationInHours: 48,
          costReportGroup: undefined,
          startDate: new Date().toISOString(),
          budgetThresholds: undefined,
          durationThresholds: undefined,
          maxSpend: 20,
          resourceLock: undefined,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: oldLease,
        });
        const spyPut = vi
          .spyOn(DynamoLeaseStore.prototype, "update")
          .mockImplementation(async (newItem) => ({
            newItem: newItem as typeof oldLease,
            oldItem: oldLease,
          }));
        mockAppConfigMiddleware(globalConfig, mockedReportingConfig);
        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PATCH",
            path: `/leases/${leaseId}`,
            body: JSON.stringify(requestJsonBody),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, globalConfig),
        );
        return { response, spyPut };
      };

      it.each([
        ["without rateLimits", {}],
        ["beside rateLimits", { rateLimits }],
      ])(
        "rejects a singular rateLimit member %s as an unknown key",
        async (_label, extra) => {
          const { response, spyPut } = await patchLease(true, {
            ...extra,
            rateLimit: { maxHourlyRate: 5 },
          });

          expect(response).toEqual({
            statusCode: 400,
            body: createFailureResponseBody({
              field: "input",
              message: 'Unrecognized key: "rateLimit"',
            }),
            headers: responseHeadersWithErrorType("ValidationError"),
          });
          expect(spyPut).not.toHaveBeenCalled();
        },
      );

      it.each<{
        name: string;
        body: Record<string, unknown>;
        predictive?: boolean;
        existing?: Pick<PersistedMonitoredLease, "rateLimits">;
        gateClosed?: boolean;
        expected: PersistedMonitoredLease["rateLimits"];
      }>([
        {
          name: "replaces the stored list",
          body: { rateLimits },
          expected: [...rateLimits],
        },
        {
          name: "replaces the list on an opted-in lease after the global gate closes",
          body: { rateLimits },
          gateClosed: true,
          expected: [...rateLimits],
        },
        {
          name: "clears the list with an explicit null",
          body: { rateLimits: null },
          expected: undefined,
        },
        {
          name: "clears the list with an explicit empty list",
          body: { rateLimits: [] },
          expected: [],
        },
        {
          name: "accepts an empty list on a lease without predictive controls",
          body: { rateLimits: [] },
          predictive: false,
          existing: { rateLimits: undefined },
          expected: [],
        },
        {
          name: "keeps the stored list when rateLimits is not sent",
          body: { maxSpend: 25 },
          expected: [{ basis: "DAILY", rate: 75, action: "ALERT" }],
        },
      ])(
        "$name",
        async ({ body, predictive = true, existing, gateClosed, expected }) => {
          const config = gateClosed
            ? {
                ...mockedGlobalConfig,
                leases: {
                  ...mockedGlobalConfig.leases,
                  allowPredictiveBudgetControls: false,
                },
              }
            : undefined;
          const { response, spyPut } = await patchLease(
            predictive,
            body,
            existing,
            config,
          );

          expect(response.statusCode).toBe(200);
          const persisted = spyPut.mock.calls[0]![0] as PersistedMonitoredLease;
          expect(persisted.rateLimits).toEqual(expected);
          expect(persisted).not.toHaveProperty("rateLimit");
          const data = JSON.parse(response.body).data;
          expect(data.rateLimits).toEqual(expected);
          expect(data).not.toHaveProperty("rateLimit");
        },
      );

      it.each([
        [
          "a non-empty list on a lease without predictive controls",
          false,
          rateLimits,
          "rateLimits requires a lease with predictive budget controls enabled.",
        ],
        [
          "a repeated (basis, rate) pair",
          true,
          [
            { basis: "DAILY", rate: 50, action: "ALERT" },
            { basis: "DAILY", rate: 50, action: "FREEZE_ACCOUNT" },
          ],
          "duplicate rate limit",
        ],
      ])("rejects %s", async (_label, predictive, list, message) => {
        const { response, spyPut } = await patchLease(predictive, {
          rateLimits: list,
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain(message);
        expect(spyPut).not.toHaveBeenCalled();
      });
    });

    it("should return 400 for a PREDICTED threshold on a lease without predictive budget controls", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: undefined,
        predictiveBudgetEnabled: false,
        ...leaseCompositeKey,
        status: "Active",
        leaseDurationInHours: 48,
        costReportGroup: undefined,
        startDate: now().toISO(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        maxSpend: 20,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      const spyPut = vi.spyOn(DynamoLeaseStore.prototype, "update");

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            budgetThresholds: [
              {
                dollarsSpent: 10,
                action: "FREEZE_ACCOUNT",
                triggerOn: "PREDICTED",
              },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "budgetThresholds",
          message:
            "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(spyPut).not.toHaveBeenCalled();
    });

    describe("budget thresholds at maxSpend", () => {
      const patchLease = async (
        stored: { maxSpend: number; dollarsSpent: number },
        body: Record<string, unknown>,
      ) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          rateLimits: undefined,
          predictiveBudgetEnabled: false,
          ...leaseCompositeKey,
          status: "Active",
          leaseDurationInHours: 48,
          costReportGroup: undefined,
          startDate: now().toISO(),
          budgetThresholds: [
            { dollarsSpent: stored.dollarsSpent, action: "ALERT" },
          ],
          durationThresholds: undefined,
          maxSpend: stored.maxSpend,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: oldLease,
        });
        const spyPut = vi
          .spyOn(DynamoLeaseStore.prototype, "update")
          .mockImplementation(async (newItem) => ({
            newItem,
            oldItem: oldLease,
          }));
        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PATCH",
            path: `/leases/${leaseId}`,
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        return { response, spyPut };
      };

      it.each([
        [
          "a threshold equal to the stored maxSpend",
          { budgetThresholds: [{ dollarsSpent: 20, action: "ALERT" }] },
          "Every budget threshold dollarsSpent must be less than maxSpend (20).",
        ],
        [
          "a threshold above the maxSpend it sends",
          {
            maxSpend: 15,
            budgetThresholds: [{ dollarsSpent: 16, action: "ALERT" }],
          },
          "Every budget threshold dollarsSpent must be less than maxSpend (15).",
        ],
        [
          "a maxSpend below a stored threshold",
          { maxSpend: 10 },
          "Every budget threshold dollarsSpent must be less than maxSpend (10).",
        ],
      ])("should return 400 for %s", async (_label, body, message) => {
        const { response, spyPut } = await patchLease(
          { maxSpend: 20, dollarsSpent: 15 },
          body,
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
        expect(spyPut).not.toHaveBeenCalled();
      });

      it("should return 200 when the patch lowers maxSpend and the threshold together", async () => {
        const body = {
          maxSpend: 10,
          budgetThresholds: [{ dollarsSpent: 5, action: "ALERT" }],
        };
        const { response, spyPut } = await patchLease(
          { maxSpend: 20, dollarsSpent: 15 },
          body,
        );

        expect(response.statusCode).toBe(200);
        expect(spyPut).toHaveBeenCalledWith(
          expect.objectContaining(body),
          expect.anything(),
        );
      });

      it("should return 200 for an unrelated edit on a lease whose stored threshold equals maxSpend", async () => {
        const { response, spyPut } = await patchLease(
          { maxSpend: 20, dollarsSpent: 20 },
          { durationThresholds: [] },
        );

        expect(response.statusCode).toBe(200);
        expect(spyPut).toHaveBeenCalledWith(
          expect.objectContaining({
            maxSpend: 20,
            budgetThresholds: [{ dollarsSpent: 20, action: "ALERT" }],
          }),
          expect.anything(),
        );
      });
    });

    it("should accept a PREDICTED threshold on a lease with predictive budget controls", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: undefined,
        predictiveBudgetEnabled: true,
        ...leaseCompositeKey,
        status: "Active",
        leaseDurationInHours: 48,
        costReportGroup: undefined,
        startDate: now().toISO(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        maxSpend: 20,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      const requestJsonBody = {
        budgetThresholds: [
          {
            dollarsSpent: 15,
            action: "FREEZE_ACCOUNT" as const,
            triggerOn: "PREDICTED" as const,
          },
        ],
      };
      const updatedLease = { ...oldLease, ...requestJsonBody };
      const spyPut = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockResolvedValue({ newItem: updatedLease, oldItem: oldLease });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(spyPut).toHaveBeenCalledWith(
        expect.objectContaining(requestJsonBody),
        oldLease,
      );
    });

    it("should not check stored thresholds the request does not change", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const storedThresholds = [
        {
          dollarsSpent: 10,
          action: "FREEZE_ACCOUNT" as const,
          triggerOn: "PREDICTED" as const,
        },
      ];
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: undefined,
        predictiveBudgetEnabled: false,
        ...leaseCompositeKey,
        status: "Active",
        leaseDurationInHours: 48,
        costReportGroup: undefined,
        startDate: now().toISO(),
        budgetThresholds: storedThresholds,
        durationThresholds: undefined,
        maxSpend: 20,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      const requestJsonBody = { maxSpend: 25 };
      const updatedLease = { ...oldLease, ...requestJsonBody };
      const spyPut = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockResolvedValue({ newItem: updatedLease, oldItem: oldLease });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(spyPut).toHaveBeenCalledWith(
        expect.objectContaining({
          maxSpend: 25,
          budgetThresholds: storedThresholds,
        }),
        oldLease,
      );
    });

    it.each([
      "lastPredictedSpend",
      "lastEvaluatedSpend",
      "lastEvaluatedHourlySpendRate",
      "lastEvaluatedDailySpendRate",
    ])(
      "should return 400 when the body carries the de-duplication scalar %s",
      async (field) => {
        // These four are what threshold evaluation compares against to decide a
        // threshold has already fired. A client able to set them could re-arm or
        // silence every threshold on the lease, so the patch schema's pick list
        // must keep excluding them.
        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: "/leases/LEASE101",
          body: JSON.stringify({ [field]: 1 }),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "input",
            message: `Unrecognized key: "${field}"`,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it("allows patching other fields when a required cost report group is already missing", async () => {
      // Lease predates the requirement and has no cost report group; a group is
      // now required. Patching an unrelated field (maxSpend) must still succeed.
      mockAppConfigMiddleware(mockedGlobalConfig, testReportingConfigRequired);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
        expirationDate: undefined,
        budgetThresholds: undefined,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: oldLease }),
      );

      // Patch only maxSpend — costReportGroup is not included in the body.
      const requestJsonBody = { maxSpend: 20 };
      const updatedLease = { ...oldLease, maxSpend: 20 };

      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({ newItem: updatedLease, oldItem: oldLease }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toEqual(200);
    });

    it("should return 200 when nullable values are used to clear data", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: undefined,
        ...leaseCompositeKey,
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const requestJsonBody = {
        ...generateSchemaData(BudgetConfigSchema, {
          rateLimits: undefined,
          budgetThresholds: undefined,
        }),
        ...generateSchemaData(
          DurationConfigSchema.omit({ leaseDurationInHours: true }),
          { durationThresholds: undefined },
        ),
        expirationDate: null,
        maxSpend: 20, //no max budget is disallowed in mock global config
      };

      const updatedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...oldLease,
        ...requestJsonBody,
        expirationDate: undefined,
        maxSpend: 20,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const spyPut = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockReturnValue(
          Promise.resolve({
            newItem: updatedLease,
            oldItem: oldLease,
          }),
        );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectLease(updatedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(spyPut).toHaveBeenCalledOnce();
      expect(spyPut).toHaveBeenCalledWith(
        {
          ...updatedLease,
        },
        oldLease,
      );
    });

    it("re-tags the CostReportGroup tag on the account when costReportGroup changes", async () => {
      const reportingConfig = {
        costReportGroups: ["valid-group-1", "valid-group-2"],
        requireCostReportGroup: false,
      };
      mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: "valid-group-1",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        allowOwnerToShareLease: false,
      });
      const updatedLease = { ...oldLease, costReportGroup: "valid-group-2" };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      } as any);
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue({
        newItem: updatedLease,
        oldItem: oldLease,
      } as any);
      const tagSpy = vi
        .spyOn(OrganizationsTaggingService.prototype, "tagAccount")
        .mockResolvedValue(undefined);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({ costReportGroup: "valid-group-2" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(tagSpy).toHaveBeenCalledOnce();
      expect(tagSpy).toHaveBeenCalledWith(oldLease.awsAccountId, {
        CostReportGroup: "valid-group-2",
      });
    });

    it("returns 200 even when the re-tag call fails (fire-and-forget)", async () => {
      const reportingConfig = {
        costReportGroups: ["valid-group-1", "valid-group-2"],
        requireCostReportGroup: false,
      };
      mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: "valid-group-1",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        allowOwnerToShareLease: false,
      });
      const updatedLease = { ...oldLease, costReportGroup: "valid-group-2" };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      } as any);
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue({
        newItem: updatedLease,
        oldItem: oldLease,
      } as any);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "tagAccount",
      ).mockRejectedValue(new Error("simulated CE failure"));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({ costReportGroup: "valid-group-2" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
    });

    it("should return 400 when setting allowOwnerToShareLease to true while leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        expirationDate: undefined,
        budgetThresholds: undefined,
        durationThresholds: undefined,
        costReportGroup: undefined,
        allowOwnerToShareLease: false,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          allowOwnerToShareLease: true,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, disabledSharingConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Cannot enable allowOwnerToShareLease because lease sharing is not available.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("allows an unchanged sharing-enabled lease while leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        expirationDate: undefined,
        budgetThresholds: undefined,
        durationThresholds: undefined,
        costReportGroup: undefined,
        allowOwnerToShareLease: true,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue({
        newItem: oldLease,
        oldItem: oldLease,
      });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify({
            allowOwnerToShareLease: true,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, disabledSharingConfig),
      );

      expect(response.statusCode).toBe(200);
    });

    describe("M2M-assignee guard", () => {
      it("returns 400 and writes nothing when an M2M caller requests a lease for self", async () => {
        const createSpy = vi.spyOn(DynamoLeaseStore.prototype, "create");
        const eventSpy = vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid: randomUUID() }),
          headers: { "Content-Type": "application/json" },
          isbUser: m2mAdminUser,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
        expect(eventSpy).not.toHaveBeenCalled();
      });

      it("returns 400 and writes nothing when a Manager assigns a lease to a synthetic email", async () => {
        const createSpy = vi.spyOn(DynamoLeaseStore.prototype, "create");
        const syntheticEmail = buildM2mSyntheticEmail("some-client", "User");

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            userEmail: syntheticEmail,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe("POST /leases - rate limit", () => {
    function buildLeaseAt(opts: {
      userEmail: string;
      createdAtIso: string;
    }): PersistedMonitoredLease {
      const base = generateSchemaData(PersistedMonitoredLeaseSchema, {
        userEmail: opts.userEmail,
        status: "Active",
      });
      return {
        ...base,
        meta: {
          schemaVersion: 4,
          createdTime: opts.createdAtIso,
          lastEditTime: opts.createdAtIso,
        },
      };
    }

    function makeUserOnlyEvent() {
      return createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: randomUUID(),
          comments: "rate limit test",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
    }

    function makeUserOnlyContext(globalConfig?: GlobalConfig) {
      return {
        ...mockAuthorizedContext(testEnv, globalConfig ?? mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };
    }

    function mockPublicTemplate() {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            visibility: "PUBLIC",
          }),
        }),
      );
    }

    it("returns 429 with retryAt when User has reached the lease request limit", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const earliest = DateTime.utc().minus({ hours: 24 }).toISO()!;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 10 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      // ensure earliest is at index 0
      seededLeases[0] = buildLeaseAt({ userEmail, createdAtIso: earliest });

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(429);
      expect(body.data.retryAt).toBe(
        DateTime.fromISO(earliest, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
      );
      expect(requestLeaseSpy).not.toHaveBeenCalled();
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });

    // The 429 path emits a LeaseRequestRateLimited warn log carrying every
    // documented field. The tests above assert the response shape but never
    // the structured log payload.
    it("emits a LeaseRequestRateLimited log with all documented fields on 429", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const earliest = DateTime.utc().minus({ hours: 24 }).toISO()!;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 10 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      seededLeases[0] = buildLeaseAt({ userEmail, createdAtIso: earliest });

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const warnSpy = vi.spyOn(Logger.prototype, "warn");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(429);
      const rateLimitedLog = warnSpy.mock.calls.find(
        (call) => call[0] === "LeaseRequestRateLimited",
      );
      expect(rateLimitedLog).toBeDefined();
      expect(rateLimitedLog![1]).toEqual({
        logDetailType: "LeaseRequestRateLimited",
        targetUserEmail: userEmail,
        callerEmail: userEmail,
        currentCount: 10,
        limit: 10,
        retryAt: DateTime.fromISO(earliest, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
        effectiveWindowHours: 168,
      });
    });

    it("returns retryAt at the Nth-oldest lease when count exceeds the limit", async () => {
      // Simulates admin/manager assignments pushing the user above the limit:
      // user has 12 leases, limit is 10. Aging out only the earliest still
      // leaves 11 in window, so retryAt must be the (count - limit)th oldest
      // i.e. the 2nd-oldest in this case.
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 12 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            // index 0 is oldest (24h ago), index 11 is newest (13h ago)
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      const expectedPivot = seededLeases[2]!.meta!.createdTime!; // 12 - 10 = 2

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(429);
      expect(body.data.retryAt).toBe(
        DateTime.fromISO(expectedPivot, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
      );
      expect(requestLeaseSpy).not.toHaveBeenCalled();
    });

    it("calculates retryAt after scanning multiple pages", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 12 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      const expectedPivot = seededLeases[2]!.meta!.createdTime!;
      const findByUserEmailSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
        .mockResolvedValueOnce({
          result: seededLeases.slice(0, 6),
          nextPageIdentifier: "next-page",
        })
        .mockResolvedValueOnce({
          result: seededLeases.slice(6),
          nextPageIdentifier: null,
        });

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(429);
      expect(body.data.retryAt).toBe(
        DateTime.fromISO(expectedPivot, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
      );
      expect(findByUserEmailSpy).toHaveBeenCalledTimes(2);
    });

    it("returns 201 when User is under the limit", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const seededLeases: PersistedLease[] = Array.from({ length: 5 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema, {}));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it("returns 201 when the earliest lease has aged out of the window", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      // 10 leases but the earliest is 200h old (outside 168h window)
      const inWindow: PersistedLease[] = Array.from({ length: 9 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      const outOfWindow = buildLeaseAt({
        userEmail,
        createdAtIso: DateTime.utc().minus({ hours: 200 }).toISO()!,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: [outOfWindow, ...inWindow], nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema, {}));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it("exempts Admin/Manager assigning on behalf of a user at the limit", async () => {
      mockPublicTemplate();
      const targetEmail = "target-user@example.com";
      vi.spyOn(IsbServices, "idcService").mockReturnValue({
        getIsbMemberFromEmail: vi.fn().mockResolvedValue({
          type: "user",
          email: targetEmail,
          userId: "target-id",
          roles: ["User"],
        }),
      } as any);
      const tenLeases: PersistedLease[] = Array.from({ length: 10 }, (_, i) =>
        buildLeaseAt({
          userEmail: targetEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      const findByUserEmailSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
        .mockResolvedValue({ result: tenLeases, nextPageIdentifier: null });
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema, {}));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: randomUUID(),
          userEmail: targetEmail,
          comments: "admin assignment",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it.each([
      {
        excludedStatus: "PendingApproval" as const,
        schema: PersistedPendingLeaseSchema,
      },
      {
        excludedStatus: "ApprovalDenied" as const,
        schema: PersistedApprovalDeniedLeaseSchema,
      },
    ])(
      "does not count $excludedStatus leases toward the rate limit",
      async ({ excludedStatus, schema }) => {
        mockPublicTemplate();
        const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
        const seededLeases: PersistedLease[] = Array.from(
          { length: 10 },
          (_, i) => ({
            ...generateSchemaData(schema, {
              userEmail,
              status: excludedStatus,
            }),
            meta: {
              schemaVersion: 5,
              createdTime: DateTime.utc()
                .minus({ hours: i + 1 })
                .toISO()!,
              lastEditTime: DateTime.utc()
                .minus({ hours: i + 1 })
                .toISO()!,
            },
          }),
        );
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({
          result: seededLeases,
          nextPageIdentifier: null,
        });
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(
            generateSchemaData(PersistedPendingLeaseSchema, {}),
          );

        const response = await handler(
          makeUserOnlyEvent(),
          makeUserOnlyContext(),
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledOnce();
      },
    );

    it("emits LeaseRequestWindowCapped log at most once per cold start", async () => {
      mockPublicTemplate();
      const cappedConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          ttl: 30,
          leaseRequestWindowHours: 1000,
        },
      };
      mockAppConfigMiddleware(cappedConfig, mockedReportingConfig);
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: [], nextPageIdentifier: null },
      );
      vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
        generateSchemaData(PersistedPendingLeaseSchema, {}),
      );
      const warnSpy = vi.spyOn(Logger.prototype, "warn");

      // Two back-to-back invocations within the same module instance (warm Lambda)
      await handler(makeUserOnlyEvent(), makeUserOnlyContext(cappedConfig));
      await handler(makeUserOnlyEvent(), makeUserOnlyContext(cappedConfig));

      const cappedLogCount = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0] === "LeaseRequestWindowCapped",
      ).length;
      // Either 0 (already emitted earlier in suite) or 1 (this is the first
      // time the cap was hit), but never 2 from these two back-to-back calls.
      expect(cappedLogCount).toBeLessThanOrEqual(1);
    });

    it("caps the effective window at leases.ttl * 24 when leaseRequestWindowHours is larger", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      // ttl is 30 days = 720h. Configure window > ttl*24 to trigger the cap.
      const cappedConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          ttl: 30,
          leaseRequestWindowHours: 1000,
        },
      };
      mockAppConfigMiddleware(cappedConfig, mockedReportingConfig);

      // Earliest lease at 800h old: outside 720h cap, but within configured 1000h
      const earliestOutOfCap = buildLeaseAt({
        userEmail,
        createdAtIso: DateTime.utc().minus({ hours: 800 }).toISO()!,
      });
      const inCap: PersistedLease[] = Array.from({ length: 9 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        {
          result: [earliestOutOfCap, ...inCap],
          nextPageIdentifier: null,
        },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema, {}));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(cappedConfig),
      );

      // 9 in-cap leases < 10 limit yields 201. If cap weren't applied, 10 leases would yield 429.
      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/review", () => {
    it("approves a saved lease without rechecking profile registration", async () => {
      const lease = generateSchemaData(PersistedPendingLeaseSchema, {
        defaultPermissionSetArn: customPermissionSetArn,
        allowedPermissionSetArns: [customPermissionSetArn],
        desiredAssignments: undefined,
      });
      const leaseId = base64EncodeCompositeKey({
        uuid: lease.uuid,
        userEmail: lease.userEmail,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const approve = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({ newItem: lease });
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${leaseId}/review`,
          body: JSON.stringify({ action: "Approve" }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(200);
      expect(approve).toHaveBeenCalledExactlyOnceWith(
        { lease, approver: isbAuthorizedUser.user.email },
        expect.anything(),
      );
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });

    it("should allow an Admin/Manager to approve their own lease request", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        userEmail: isbAuthorizedUser.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should approve a pending lease with an existing group when new group assignments are disabled", async () => {
      mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
      mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        desiredAssignments: [
          generateSchemaData(DesiredAssignmentSchema, {
            principalType: "GROUP",
            permissionSetArn: userPermissionSetArn,
          }),
        ],
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({ action: "Approve" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should allow an Admin/Manager to deny their own lease request", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        userEmail: isbAuthorizedUser.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Deny",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const denyLeaseSpy = vi
        .spyOn(InnovationSandbox, "denyLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(denyLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 400 and when the request body is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
          invalidField: "invalid",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "invalidField"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when the lease is in a non-reviewable state", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: LEASE_NOT_PENDING_REVIEW_ERROR,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });

    it("should return 400 when the lease owner is not a current ISB member", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new IneligibleLeaseOwnerError(mockedLease.userEmail),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/review`,
          body: JSON.stringify({ action: "Approve" }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors[0].message).toBe(
        `The lease owner ${mockedLease.userEmail} is not a current Innovation Sandbox member.`,
      );
    });

    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/freeze", () => {
    it("should return 200 and invoke the freezeLease action", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when the lease is in a non-freezeable state", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only active leases can be frozen.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it.each([
      { statusCode: 409, error: AccountNotInActiveError },
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by freeze call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/freeze`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const freezeLeaseSpy = vi
          .spyOn(InnovationSandbox, "freezeLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers:
            statusCode === 409
              ? responseHeadersWithErrorType("ConflictError")
              : responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(freezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 409 when a competing lock holder blocks the freeze", async () => {
      // Previously fell through to the generic handler as a 500, which gave the
      // caller no way to tell a retryable conflict from a server fault.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "freezeLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Another operation is currently being processed for this lease. Try again once it completes.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/terminate", () => {
    it("should return 200 and invoke the lease termination process", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 409 when a termination is already being processed", async () => {
      // Terminate preempts every other intent, so a conflict here means another
      // termination already holds the lock.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "terminateLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "A termination is already being processed for this lease.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 404 when lease is not found", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when lease is in non-active state", async () => {
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only [Active, Frozen, Provisioning] leases can be terminated.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it.each([
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by terminate call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/terminate`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const terminateLeaseSpy = vi
          .spyOn(InnovationSandbox, "terminateLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({ message: error.name }),
          headers: responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(terminateLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockRejectedValue(new Error());

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 200 and pass UserTerminated when User owns an Active lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(200);
      expect(terminateLeaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expiredStatus: "UserTerminated" }),
        expect.anything(),
      );
    });

    it("should return 403 when User attempts to terminate another user's lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: `another_${isbAuthorizedUserUserRoleOnly.user.email}`,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it.each([{ status: "Frozen" }, { status: "Provisioning" }] as const)(
      "should return 403 when User attempts to terminate own $status lease",
      async ({ status }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          status,
          userEmail: isbAuthorizedUserUserRoleOnly.user.email,
        });
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/terminate`,
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: mockedLease,
        });
        const terminateLeaseSpy = vi
          .spyOn(InnovationSandbox, "terminateLease")
          .mockResolvedValue();

        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const response = await handler(event, userOnlyContext);

        expect(response.statusCode).toBe(403);
        expect(terminateLeaseSpy).not.toHaveBeenCalled();
      },
    );

    it("should return 403 when User attempts to terminate but allowUserLeaseTermination is disabled", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const optedOutConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowUserLeaseTermination: false,
        },
      };
      mockAppConfigMiddleware(optedOutConfig, mockedReportingConfig);
      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, optedOutConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 403 (not 409) when a User terminates another user's non-monitored lease", async () => {
      // Regression guard against a status oracle: authorization is checked before
      // the isMonitoredLease status check. Otherwise a non-owner User who knows a
      // leaseId learns the lease's lifecycle state from the response code
      // (409 = expired/quarantined, 403 = active/monitored). The authorization
      // gate fires first so both cases return the same 403.
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema, {
        userEmail: `another_${isbAuthorizedUserUserRoleOnly.user.email}`,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when a User terminates their own non-monitored lease", async () => {
      // Mirror of the oracle guard: an authorized caller (the owner) passes the
      // authorization gate and legitimately sees the 409 status response. Confirms
      // the gate does not over-block authorized users.
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema, {
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(409);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 403 (not 404) when a User terminates a non-existent lease", async () => {
      // Existence oracle guard: a non-owner User who knows a leaseId must not be
      // able to tell a missing lease (404) apart from one that exists but is not
      // theirs (403). Authorization wraps the existence branch so both return 403.
      const mockedLeaseId = base64EncodeCompositeKey(
        generateSchemaData(LeaseKeySchema),
      )!;
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toBe(
        "User is not authorized to terminate this lease.",
      );
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 404 when an Admin/Manager terminates a non-existent lease", async () => {
      // Elevated callers legitimately need an accurate 404 for operational tooling.
      const mockedLeaseId = base64EncodeCompositeKey(
        generateSchemaData(LeaseKeySchema),
      )!;
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toBe("Lease not found.");
    });

    it("should preserve ManuallyTerminated when Admin/Manager terminates another user's Frozen lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
        userEmail: "someone-else@example.com",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(terminateLeaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expiredStatus: "ManuallyTerminated" }),
        expect.anything(),
      );
    });
  });

  // Handler-chain coverage that runs the REAL InnovationSandbox facade
  // (mocking only the store / OU / IDC / event-bridge boundary) and asserts on
  // the published LeaseTerminatedEvent. The tests above stub the facade and
  // only check its call arguments; these verify the event that the downstream
  // email subscriber actually consumes is published with the right reason.type.
  describe("POST /leases/{leaseId}/terminate - published event", () => {
    // Earlier tests stub InnovationSandbox.terminateLease and the
    // IsbServices.idcService factory, and the suite's afterEach uses
    // clearAllMocks (which does not restore implementations), so those stubs
    // would persist here. Restore them so the real facade runs end to end and
    // builds a real IdcService whose prototype methods we spy below.
    beforeEach(() => {
      vi.spyOn(InnovationSandbox, "terminateLease").mockRestore();
      vi.spyOn(IsbServices, "idcService").mockRestore();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Stub the collaborators the real terminateLease touches so it runs end to
    // end without hitting AWS. sendIsbEvents is left as the assertion seam.
    function stubTerminationCollaborators(account: { awsAccountId: string }) {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedSandboxAccountSchema, {
          awsAccountId: account.awsAccountId,
          status: "Active",
        }),
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue(
        {} as any,
      );
      vi.spyOn(
        SandboxOuService.prototype,
        "transactionalMoveAccount",
      ).mockReturnValue({
        complete: vi.fn().mockResolvedValue(undefined),
      } as any);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "updateStatusTag",
      ).mockResolvedValue(undefined);
      vi.spyOn(IdcService.prototype, "getUserFromEmail").mockResolvedValue(
        undefined,
      );
      vi.spyOn(DynamoLeaseStore.prototype, "acquireLock").mockResolvedValue(
        MOCK_ACQUIRED_LOCK,
      );
      vi.spyOn(DynamoLeaseStore.prototype, "releaseLock").mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "stampLeaseTtl",
      ).mockResolvedValue();
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "listLeaseUserUsage",
      ).mockResolvedValue({ usage: [] });
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "recordLifecycleDispatch",
      ).mockResolvedValue();
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue({} as any);
      return vi
        .spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents")
        .mockResolvedValue({} as any);
    }

    function publishedTerminationReason(
      sendIsbEventsSpy: ReturnType<typeof vi.spyOn>,
    ) {
      const terminatedEvent = sendIsbEventsSpy.mock.calls
        .flat()
        .find(
          (arg: unknown): arg is LeaseTerminatedEvent =>
            arg instanceof LeaseTerminatedEvent,
        );
      return terminatedEvent?.Detail.reason.type;
    }

    it("publishes a LeaseTerminatedEvent with reason UserTerminated when a User terminates their own Active lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
        awsAccountId: "000000000000",
        blueprintId: null,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const sendIsbEventsSpy = stubTerminationCollaborators(mockedLease);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(publishedTerminationReason(sendIsbEventsSpy)).toBe(
        "UserTerminated",
      );
    });

    it("publishes a LeaseTerminatedEvent with reason ManuallyTerminated when an Admin terminates another user's lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: "someone-else@example.com",
        awsAccountId: "000000000000",
        blueprintId: null,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const sendIsbEventsSpy = stubTerminationCollaborators(mockedLease);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(publishedTerminationReason(sendIsbEventsSpy)).toBe(
        "ManuallyTerminated",
      );
    });
  });

  describe("POST /leases/{leaseId}/unfreeze", () => {
    it.each(["USER", "GROUP"] as const)(
      "unfreezes a lease with an unavailable %s profile for the worker to report individually",
      async (principalType) => {
        const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          status: "Frozen",
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
          desiredAssignments: [
            {
              principalType: "USER",
              principalId: randomUUID(),
              permissionSetArn: userPermissionSetArn,
            },
            {
              principalType,
              principalId: randomUUID(),
              permissionSetArn: customPermissionSetArn,
            },
          ],
        });
        const leaseId = base64EncodeCompositeKey({
          uuid: lease.uuid,
          userEmail: lease.userEmail,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: lease,
        });
        const unfreeze = vi
          .spyOn(InnovationSandbox, "unfreezeLease")
          .mockResolvedValue({ newItem: { ...lease, status: "Active" } });
        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: `/leases/${leaseId}/unfreeze`,
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(200);
        expect(unfreeze).toHaveBeenCalledExactlyOnceWith(
          { lease },
          expect.anything(),
        );
        expect(JSON.parse(response.body).data).toMatchObject({
          status: "Active",
          desiredAssignments: lease.desiredAssignments,
          allowedPermissionSets: expect.arrayContaining([
            expect.objectContaining({
              permissionSetArn: customPermissionSetArn,
              availability: "UNAVAILABLE",
            }),
          ]),
        });
        expect(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).toHaveBeenCalledExactlyOnceWith({});
      },
    );

    it("keeps the lease Frozen when response hydration cannot read the catalog", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const leaseId = base64EncodeCompositeKey({
        uuid: lease.uuid,
        userEmail: lease.userEmail,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockRejectedValue(new Error("catalog unavailable"));
      const unfreeze = vi.spyOn(InnovationSandbox, "unfreezeLease");
      const update = vi.spyOn(DynamoLeaseStore.prototype, "update");
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${leaseId}/unfreeze`,
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(500);
      expect(unfreeze).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it("should return 200 and invoke the unfreezeLease action", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(mockedLease),
            leaseId: mockedLeaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 409 when assignment processing holds the lock", async () => {
      // Unfreeze is non-critical, so ANY live lock rejects it. This previously
      // surfaced as a 500.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "unfreezeLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Another operation is currently being processed for this lease. Try again once it completes.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });
    it("should return 400 when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalled();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 404 when the lease does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when the lease is not frozen", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {});
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only frozen leases can be unfrozen.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });
    it.each([
      { statusCode: 409, error: AccountNotInFrozenError },
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by unfreeze call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          status: "Frozen",
        });
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/unfreeze`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const unfreezeLeaseSpy = vi
          .spyOn(InnovationSandbox, "unfreezeLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers:
            statusCode === 409
              ? responseHeadersWithErrorType("ConflictError")
              : responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("GET /leases/{leaseId}/assignments", () => {
    const leaseOwnerEmail = "owner@example.com";
    const leaseUuid = "550e8400-e29b-41d4-a716-446655440000";

    // The response is now the reconciled view (desired set unioned with the
    // access records), so both inputs must be pinned: zocker would otherwise
    // generate random desiredAssignments and a random resourceLock, changing the
    // row count and the derived statuses from run to run.
    const lease = generateSchemaData(PersistedLeaseSchema, {
      userEmail: leaseOwnerEmail,
      uuid: leaseUuid,
      status: "Active",
      desiredAssignments: [],
      resourceLock: undefined,
    });

    const leaseId = base64EncodeCompositeKey({
      userEmail: lease.userEmail,
      uuid: lease.uuid,
    })!;

    function createGetAssignmentsEvent(encodedLeaseId: string, user: IsbUser) {
      return createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${encodedLeaseId}/assignments`,
        pathParameters: { leaseId: encodedLeaseId },
        isbUser: user,
      });
    }

    it("should return 200 with assignments for Admin", async () => {
      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
      expect(body.data.assignments[0].principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(body.data.assignments[0].principalType).toBe("USER");
    });

    it("hydrates concrete and legacy built-in assignment profiles", async () => {
      const customAssignment = generateSchemaData(
        PersistedUserAssignmentSchema,
        {
          pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          sk: `lease#${leaseUuid}#ps#${permissionSetIdFromArn(customPermissionSetArn)}`,
          userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          principalType: "USER",
          leaseId: leaseUuid,
          leaseOwnerEmail,
          permissionSetArn: customPermissionSetArn,
        },
      );
      const legacyAssignment = generateSchemaData(
        PersistedUserAssignmentSchema,
        {
          pk: "user#b1c2d3e4-f5a6-7890-bcde-f01234567890",
          sk: `lease#${leaseUuid}`,
          userId: "b1c2d3e4-f5a6-7890-bcde-f01234567890",
          principalType: "USER",
          leaseId: leaseUuid,
          leaseOwnerEmail,
          permissionSetArn: undefined,
        },
      );
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [customAssignment, legacyAssignment],
        nextPageIdentifier: null,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
        permissionSetCacheItem(userPermissionSetArn, "BuiltInUserAccess"),
      ]);

      const response = await handler(
        createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const assignments = JSON.parse(response.body).data.assignments;
      expect(
        assignments.find(
          (assignment: { principalId: string }) =>
            assignment.principalId === customAssignment.userId,
        ).permissionSet,
      ).toEqual(
        expect.objectContaining({
          permissionSetArn: customPermissionSetArn,
          name: "Custom profile",
          availability: "AVAILABLE",
        }),
      );
      expect(
        assignments.find(
          (assignment: { principalId: string }) =>
            assignment.principalId === legacyAssignment.userId,
        ).permissionSet,
      ).toEqual(
        expect.objectContaining({
          permissionSetArn: userPermissionSetArn,
          name: "BuiltInUserAccess",
          availability: "AVAILABLE",
        }),
      );
    });

    it("hydrates independent grant and revoke details for a permission-set replacement", async () => {
      const principalId = "a0b1c2d3-e4f5-6789-abcd-ef0123456789";
      const replacementLease = {
        ...lease,
        defaultPermissionSetArn: userPermissionSetArn,
        desiredAssignments: [
          {
            principalId,
            principalType: "USER" as const,
            displayName: "Alice",
            email: "alice@example.com",
            permissionSetArn: customPermissionSetArn,
          },
        ],
      };
      const currentAssignments = [
        generateSchemaData(PersistedUserAssignmentSchema, {
          pk: `user#${principalId}`,
          sk: `lease#${leaseUuid}#ps#${permissionSetIdFromArn(customPermissionSetArn)}`,
          userId: principalId,
          principalType: "USER",
          leaseId: leaseUuid,
          leaseOwnerEmail,
          permissionSetArn: customPermissionSetArn,
        }),
        generateSchemaData(PersistedUserAssignmentSchema, {
          pk: `user#${principalId}`,
          sk: `lease#${leaseUuid}#ps#${permissionSetIdFromArn(userPermissionSetArn)}`,
          userId: principalId,
          principalType: "USER",
          leaseId: leaseUuid,
          leaseOwnerEmail,
          permissionSetArn: userPermissionSetArn,
        }),
      ];
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: replacementLease,
      });
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: currentAssignments,
        nextPageIdentifier: null,
      });
      vi.mocked(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).mockResolvedValue([
        permissionSetCacheItem(customPermissionSetArn, "Custom profile"),
        permissionSetCacheItem(userPermissionSetArn, "BuiltInUserAccess"),
      ]);

      const response = await handler(
        createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const responseAssignments = JSON.parse(response.body).data.assignments;
      expect(responseAssignments).toHaveLength(2);
      const customAssignment = responseAssignments.find(
        (assignment: { permissionSet: { permissionSetArn: string } }) =>
          assignment.permissionSet.permissionSetArn === customPermissionSetArn,
      );
      const builtInAssignment = responseAssignments.find(
        (assignment: { permissionSet: { permissionSetArn: string } }) =>
          assignment.permissionSet.permissionSetArn === userPermissionSetArn,
      );
      expect(customAssignment).toEqual(
        expect.objectContaining({
          isDesired: true,
          syncStatus: "active",
          permissionSet: expect.objectContaining({
            permissionSetArn: customPermissionSetArn,
            name: "Custom profile",
          }),
        }),
      );
      expect(builtInAssignment).toEqual(
        expect.objectContaining({
          isDesired: false,
          syncStatus: "revokeFailed",
          permissionSet: expect.objectContaining({
            permissionSetArn: userPermissionSetArn,
            name: "BuiltInUserAccess",
          }),
        }),
      );
    });

    it("should return 200 with assignments for Manager", async () => {
      const managerUser: IsbUser = {
        type: "user",
        email: "manager@example.com",
        userId: "managerId",
        roles: ["Manager"],
      };

      const groupAssignment = generateSchemaData(
        PersistedGroupAssignmentSchema,
        {
          pk: "group#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          sk: `lease#${leaseUuid}`,
          groupId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          principalType: "GROUP",
          leaseId: leaseUuid,
          leaseOwnerEmail,
        },
      );

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [groupAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, managerUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: managerUser, claims: buildCognitoClaims(managerUser) },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
      expect(body.data.assignments[0].principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(body.data.assignments[0].principalType).toBe("GROUP");
    });

    it("should return 200 with assignments for lease Owner", async () => {
      const ownerUser: IsbUser = {
        type: "user",
        email: leaseOwnerEmail,
        userId: "ownerId",
        roles: ["User"],
      };

      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, ownerUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: ownerUser, claims: buildCognitoClaims(ownerUser) },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
    });

    it("should return 403 for non-owner User", async () => {
      const otherUser: IsbUser = {
        type: "user",
        email: "other@example.com",
        userId: "otherId",
        roles: ["User"],
      };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const event = createGetAssignmentsEvent(leaseId, otherUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: otherUser, claims: buildCognitoClaims(otherUser) },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
    });

    it("should return 404 when lease not found", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toBe("Lease not found.");
    });

    it("should return 403 when lease not found and user is not Admin/Manager", async () => {
      const otherUser: IsbUser = {
        type: "user",
        email: "other@example.com",
        userId: "otherId",
        roles: ["User"],
      };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = createGetAssignmentsEvent(leaseId, otherUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: otherUser, claims: buildCognitoClaims(otherUser) },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
    });

    it("should return 200 with empty assignments list", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(0);
    });

    it("should return 200 with mixed user and group assignments", async () => {
      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
        assigneeEmail: "user1@example.com",
      });

      const groupAssignment = generateSchemaData(
        PersistedGroupAssignmentSchema,
        {
          pk: "group#b1c2d3e4-f5a6-7890-bcde-f01234567890",
          sk: `lease#${leaseUuid}`,
          groupId: "b1c2d3e4-f5a6-7890-bcde-f01234567890",
          principalType: "GROUP",
          displayName: "Engineering Team",
          leaseId: leaseUuid,
          leaseOwnerEmail,
        },
      );

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment, groupAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(2);

      const userResult = body.data.assignments.find(
        (a: { principalType: string }) => a.principalType === "USER",
      );
      expect(userResult.principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(userResult.assigneeEmail).toBe("user1@example.com");

      const groupResult = body.data.assignments.find(
        (a: { principalType: string }) => a.principalType === "GROUP",
      );
      expect(groupResult.principalId).toBe(
        "b1c2d3e4-f5a6-7890-bcde-f01234567890",
      );
      expect(groupResult.displayName).toBe("Engineering Team");
    });

    it("should call getAssignmentsForLease with the lease UUID", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const getAssignmentsSpy = vi
        .spyOn(DynamoPrincipalStore.prototype, "getAssignmentsForLease")
        .mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(getAssignmentsSpy).toHaveBeenCalledWith({
        leaseId: leaseUuid,
      });
    });
  });

  describe("PUT /leases/{leaseId}/assignments", () => {
    const putLeaseKey = generateSchemaData(LeaseKeySchema);
    const putOwnerEmail = putLeaseKey.userEmail;
    const putLeaseId = putLeaseKey.uuid;
    const putLeaseCompositeKey = base64EncodeCompositeKey(putLeaseKey)!;
    const putOwnerIdcId = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";

    const putActiveLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      userEmail: putOwnerEmail,
      uuid: putLeaseId,
      status: "Active",
      allowOwnerToShareLease: true,
      desiredAssignments: [],
    });

    function stubServiceToSucceed() {
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "batchGetCacheItems",
      ).mockResolvedValue([
        generateSchemaData(PersistedPrincipalCacheItemSchema, {
          sk: `user#${putOwnerIdcId}`,
          principalId: putOwnerIdcId,
          principalType: "USER",
          email: putOwnerEmail,
        }),
      ]);
      vi.spyOn(
        IdcService.prototype,
        "getCachedPrincipalByAttr",
      ).mockResolvedValue({
        principalId: putOwnerIdcId,
        principalType: "USER",
        displayName: "Owner User",
        email: putOwnerEmail,
      });
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "acquireLockWithDesiredAssignments",
      ).mockResolvedValue(MOCK_ACQUIRED_LOCK);
      vi.spyOn(DynamoLeaseStore.prototype, "releaseLock").mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue(undefined as any);
    }

    function createPutEvent(
      body: unknown,
      user: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: `/leases/${putLeaseCompositeKey}/assignments`,
        pathParameters: { leaseId: putLeaseCompositeKey },
        body: JSON.stringify(body),
        isbUser: user,
      });
    }

    it("passes the raw validated lease state to the atomic write and publishes nothing on conflict", async () => {
      const snapshot = {
        ...putActiveLease,
        defaultPermissionSetArn: undefined,
        allowedPermissionSetArns: undefined,
      };
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: snapshot,
      });
      stubServiceToSucceed();
      const writeSpy = vi
        .mocked(DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments)
        .mockRejectedValue(
          new ConcurrentDataModificationException(
            "validated profile state changed",
          ),
        );
      const eventSpy = vi.mocked(IsbEventBridgeClient.prototype.sendIsbEvent);
      const releaseSpy = vi.mocked(DynamoLeaseStore.prototype.releaseLock);

      const response = await handler(
        createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).data.errors[0].message).toBe(
        "Lease state changed after assignment validation. Refresh the lease and retry.",
      );
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedLease: snapshot,
          desiredAssignments: [
            expect.objectContaining({ permissionSetArn: userPermissionSetArn }),
          ],
        }),
      );
      expect(snapshot.defaultPermissionSetArn).toBeUndefined();
      expect(eventSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    describe("request validation", () => {
      it("accepts a replacement without a prior GET or client version, using the current lease for validation", async () => {
        const currentLease = {
          ...putActiveLease,
          desiredAssignments: [
            {
              principalId: putOwnerIdcId,
              principalType: "USER" as const,
              permissionSetArn: userPermissionSetArn,
            },
            {
              principalId: crypto.randomUUID(),
              principalType: "USER" as const,
              permissionSetArn: userPermissionSetArn,
            },
          ],
        };
        const readSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({ result: currentLease });
        stubServiceToSucceed();
        const writeSpy = vi.mocked(
          DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
        );
        const eventSpy = vi.mocked(IsbEventBridgeClient.prototype.sendIsbEvent);
        const body = {
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        };

        const response = await handler(
          createPutEvent(body),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(202);
        expect(readSpy).toHaveBeenCalledWith(putLeaseKey, {
          consistentRead: true,
        });
        expect(writeSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedLease: currentLease,
            desiredAssignments: [
              expect.objectContaining({
                principalId: putOwnerIdcId,
                principalType: "USER",
                permissionSetArn: userPermissionSetArn,
              }),
            ],
          }),
        );
        expect(eventSpy).toHaveBeenCalledOnce();
      });

      it("should return 400 for missing assignments field", async () => {
        const event = createPutEvent({});
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });

      it("should return 400 when assignments is not an array", async () => {
        const event = createPutEvent({ assignments: "not-an-array" });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });

      it("should return 400 for invalid principalType", async () => {
        const event = createPutEvent({
          assignments: [{ principalId: "user-1", principalType: "INVALID" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });
    });

    describe("permission profile validation", () => {
      it("rejects multiple permission sets for one principal", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: {
            ...putActiveLease,
            defaultPermissionSetArn: userPermissionSetArn,
            allowedPermissionSetArns: [],
          } as PersistedLease,
        });

        const response = await handler(
          createPutEvent({
            assignments: [
              {
                principalId: putOwnerIdcId,
                principalType: "USER",
              },
              {
                principalId: putOwnerIdcId,
                principalType: "USER",
                permissionSetArn: userPermissionSetArn,
              },
            ],
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toContain(
          "only one permission set",
        );
      });

      it("rejects a permission set outside the lease's effective allowed set", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: {
            ...putActiveLease,
            defaultPermissionSetArn: userPermissionSetArn,
            allowedPermissionSetArns: [],
          } as PersistedLease,
        });

        const response = await handler(
          createPutEvent({
            assignments: [
              {
                principalId: putOwnerIdcId,
                principalType: "USER",
                permissionSetArn: customPermissionSetArn,
              },
            ],
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toContain(
          "not allowed by this lease",
        );
      });

      it.each([adminPermissionSetArn, managerPermissionSetArn])(
        "rejects system-role assignment %s",
        async (permissionSetArn) => {
          vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
            result: {
              ...putActiveLease,
              defaultPermissionSetArn: userPermissionSetArn,
              allowedPermissionSetArns: [],
            } as PersistedLease,
          });

          const response = await handler(
            createPutEvent({
              assignments: [
                {
                  principalId: putOwnerIdcId,
                  principalType: "USER",
                  permissionSetArn,
                },
              ],
            }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );

          expect(response.statusCode).toBe(400);
          expect(JSON.parse(response.body).data.errors[0].message).toContain(
            "system role",
          );
        },
      );

      it("accepts USER/GROUP identity collisions as distinct principals", async () => {
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue([
          permissionSetCacheItem(customPermissionSetArn, "Registered custom"),
        ]);
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: {
            ...putActiveLease,
            defaultPermissionSetArn: userPermissionSetArn,
            allowedPermissionSetArns: [customPermissionSetArn],
          } as PersistedLease,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            displayName: "Owner User",
            email: putOwnerEmail,
          }),
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `group#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "GROUP",
            displayName: "Owner-id group",
            email: undefined,
          }),
        ]);
        const lockSpy = vi
          .spyOn(
            DynamoLeaseStore.prototype,
            "acquireLockWithDesiredAssignments",
          )
          .mockResolvedValue(MOCK_ACQUIRED_LOCK);
        vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        ).mockResolvedValue(undefined as any);

        const response = await handler(
          createPutEvent({
            assignments: [
              {
                principalId: putOwnerIdcId,
                principalType: "USER",
                permissionSetArn: customPermissionSetArn,
              },
              {
                principalId: putOwnerIdcId,
                principalType: "GROUP",
                permissionSetArn: customPermissionSetArn,
              },
            ],
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
        expect(lockSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            desiredAssignments: expect.arrayContaining([
              expect.objectContaining({
                principalType: "USER",
                principalId: putOwnerIdcId,
                permissionSetArn: customPermissionSetArn,
              }),
              expect.objectContaining({
                principalType: "GROUP",
                principalId: putOwnerIdcId,
                permissionSetArn: customPermissionSetArn,
              }),
            ]),
          }),
        );
      });
    });

    describe("deregistered permission sets", () => {
      const owner = {
        principalId: putOwnerIdcId,
        principalType: "USER",
        permissionSetArn: userPermissionSetArn,
      } as const;
      const shared = {
        principalId: "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440001",
        principalType: "USER",
        permissionSetArn: customPermissionSetArn,
      } as const;

      function stubActive(
        desiredAssignments: DesiredAssignment[] = [owner, shared],
        defaultPermissionSetArn = userPermissionSetArn,
      ) {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: {
            ...putActiveLease,
            defaultPermissionSetArn,
            allowedPermissionSetArns: [
              userPermissionSetArn,
              customPermissionSetArn,
            ],
            desiredAssignments: [...desiredAssignments],
          } as PersistedLease,
        });
        stubServiceToSucceed();
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockImplementation(async (principals) =>
          principals.map((p) =>
            generateSchemaData(PersistedPrincipalCacheItemSchema, {
              sk: `user#${p.principalId}`,
              principalId: p.principalId,
              principalType: p.principalType,
              email:
                p.principalId === putOwnerIdcId
                  ? putOwnerEmail
                  : "shared@example.com",
            }),
          ),
        );
      }

      it.each(["USER", "GROUP"])(
        "rejects a new %s tuple before changing desired state or publishing work",
        async (principalType) => {
          stubActive([owner]);
          const response = await handler(
            createPutEvent({
              assignments: [owner, { ...shared, principalType }],
            }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );
          expect(response.statusCode).toBe(400);
          expect(JSON.parse(response.body).data.errors[0].message).toContain(
            "Register it again or select an available permission set",
          );
          expect(
            DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
          ).not.toHaveBeenCalled();
          expect(
            IsbEventBridgeClient.prototype.sendIsbEvent,
          ).not.toHaveBeenCalled();
        },
      );

      it.each(["unchanged", "removal"])(
        "accepts %s unavailable tuples without reading the failed catalog",
        async (kind) => {
          stubActive();
          vi.mocked(
            DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
          ).mockRejectedValue(new Error("catalog unavailable"));
          const assignments = kind === "removal" ? [owner] : [owner, shared];
          const response = await handler(
            createPutEvent({ assignments }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );
          expect(response.statusCode).toBe(202);
          expect(
            DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
          ).not.toHaveBeenCalled();
          expect(
            DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
          ).toHaveBeenCalledWith(
            expect.objectContaining({
              desiredAssignments: expect.arrayContaining(
                assignments.map((a) => expect.objectContaining(a)),
              ),
            }),
          );
        },
      );

      it("requires current registration for an implicitly restored owner tuple", async () => {
        stubActive([owner], customPermissionSetArn);
        const response = await handler(
          createPutEvent({ assignments: [] }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
        expect(
          DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
        ).not.toHaveBeenCalled();
      });

      it("fails closed without writes or events when a new custom tuple cannot read the catalog", async () => {
        stubActive([owner]);
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockRejectedValue(new Error("catalog unavailable"));
        const response = await handler(
          createPutEvent({ assignments: [owner, shared] }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(500);
        expect(
          DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
        ).not.toHaveBeenCalled();
        expect(
          IsbEventBridgeClient.prototype.sendIsbEvent,
        ).not.toHaveBeenCalled();
      });

      it("accepts a new custom tuple after a consistent registered catalog read", async () => {
        stubActive([owner]);
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue([
          permissionSetCacheItem(customPermissionSetArn, "Registered custom"),
        ]);
        const response = await handler(
          createPutEvent({ assignments: [owner, shared] }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(202);
        expect(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).toHaveBeenCalledExactlyOnceWith({ consistentRead: true });
      });
    });

    describe("feature flag", () => {
      it("should return 403 when leaseSharingEnabled is false for non-admin user", async () => {
        mockedGlobalConfig.leases.leaseSharingEnabled = false;
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("not enabled");
      });

      it("should allow Admin even when leaseSharingEnabled is false", async () => {
        mockedGlobalConfig.leases.leaseSharingEnabled = false;
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });
    });

    describe("group assignment mode", () => {
      it("should reject a new group assignment for an admin", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, desiredAssignments: [] } as any,
        });

        const event = createPutEvent({
          assignments: [
            {
              principalId: crypto.randomUUID(),
              principalType: "GROUP",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "New group assignments are not enabled",
        );
      });

      it("should allow an existing group assignment to be removed", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const currentLease = {
          ...putActiveLease,
          desiredAssignments: [
            {
              principalId: crypto.randomUUID(),
              principalType: "GROUP",
            },
          ],
        } as PersistedLease;
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: currentLease,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });

      it("should allow an existing group's permission set to be replaced", async () => {
        vi.mocked(
          DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
        ).mockResolvedValue([
          permissionSetCacheItem(customPermissionSetArn, "Registered custom"),
        ]);
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const existingGroupId = crypto.randomUUID();
        const currentLease = {
          ...putActiveLease,
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: [customPermissionSetArn],
          desiredAssignments: [
            {
              principalId: existingGroupId,
              principalType: "GROUP",
              permissionSetArn: userPermissionSetArn,
            },
          ],
        } as PersistedLease;
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: currentLease,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            displayName: "Owner User",
            email: putOwnerEmail,
          }),
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `group#${existingGroupId}`,
            principalId: existingGroupId,
            principalType: "GROUP",
            displayName: "Existing group",
            email: undefined,
          }),
        ]);
        const lockSpy = vi
          .spyOn(
            DynamoLeaseStore.prototype,
            "acquireLockWithDesiredAssignments",
          )
          .mockResolvedValue(MOCK_ACQUIRED_LOCK);
        vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        ).mockResolvedValue(undefined as any);

        const response = await handler(
          createPutEvent({
            assignments: [
              {
                principalId: putOwnerIdcId,
                principalType: "USER",
              },
              {
                principalId: existingGroupId,
                principalType: "GROUP",
                permissionSetArn: customPermissionSetArn,
              },
            ],
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
        expect(lockSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            desiredAssignments: expect.arrayContaining([
              expect.objectContaining({
                principalId: existingGroupId,
                principalType: "GROUP",
                permissionSetArn: customPermissionSetArn,
              }),
            ]),
          }),
        );
      });
    });

    describe("lease fetch", () => {
      it("should return 404 when lease not found for an admin/manager", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: undefined,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(404);
      });

      it("should return 403 (not 404) for a non-elevated non-owner when the lease does not exist", async () => {
        // Existence oracle guard: a plain User must not be able to tell a
        // missing lease (404) apart from one they simply cannot manage (403).
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: undefined,
        });

        const otherUser: IsbUser = {
          type: "user",
          email: "other@example.com",
          roles: ["User"],
          userId: "other-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          otherUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toBe(
          "Active user is not authorized to manage assignments for this lease.",
        );
      });
    });

    describe("authorization", () => {
      it("should return 403 for non-owner non-elevated user", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });

        const otherUser: IsbUser = {
          type: "user",
          email: "other@example.com",
          roles: ["User"],
          userId: "other-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          otherUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("should return 403 when owner does not have allowOwnerToShareLease", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, allowOwnerToShareLease: false } as any,
        });

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "Owner sharing is not enabled",
        );
      });

      it("should allow Admin even when allowOwnerToShareLease is false", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, allowOwnerToShareLease: false } as any,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });

      it("should allow a non-elevated owner when sharing is enabled", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });
    });

    describe("lease status", () => {
      it("should return 409 when lease is Frozen", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, status: "Frozen" } as any,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(409);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "not in an active status",
        );
      });

      it("should return 409 when lease is Expired", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, status: "Expired" } as any,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(409);
      });
    });

    it("reuses the resolved lease owner when its cache entry is missing", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: putActiveLease,
      });
      stubServiceToSucceed();
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "batchGetCacheItems",
      ).mockResolvedValue([]);
      const lookupById = vi
        .spyOn(IdcService.prototype, "getCachedPrincipalById")
        .mockRejectedValue(new Error("Unexpected second owner lookup"));
      const lookup = vi
        .spyOn(IdcService.prototype, "getCachedPrincipalByAttr")
        .mockResolvedValueOnce({
          principalId: putOwnerIdcId,
          principalType: "USER",
          email: putOwnerEmail.toUpperCase(),
          displayName: "Owner User",
        })
        .mockRejectedValue(new Error("Unexpected second owner lookup"));

      const response = await handler(
        createPutEvent({ assignments: [] }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(202);
      expect(lookup).toHaveBeenCalledOnce();
      expect(lookupById).not.toHaveBeenCalled();
      expect(
        DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          desiredAssignments: [
            expect.objectContaining({
              principalId: putOwnerIdcId,
              principalType: "USER",
              email: putOwnerEmail.toUpperCase(),
              displayName: "Owner User",
            }),
          ],
        }),
      );
    });

    describe("error mapping", () => {
      it.each([
        { principalType: "GROUP" as const, email: putOwnerEmail },
        { principalType: "USER" as const, email: undefined },
      ])(
        "rejects an invalid owner lookup before changing assignments: %j",
        async (owner) => {
          vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
            result: putActiveLease,
          });
          stubServiceToSucceed();
          vi.spyOn(
            IdcService.prototype,
            "getCachedPrincipalByAttr",
          ).mockResolvedValue({ principalId: putOwnerIdcId, ...owner });

          const response = await handler(
            createPutEvent({ assignments: [] }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );

          expect(response.statusCode).toBe(400);
          expect(
            DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
          ).not.toHaveBeenCalled();
          expect(
            IsbEventBridgeClient.prototype.sendIsbEvent,
          ).not.toHaveBeenCalled();
        },
      );

      it("should return 400 without changing assignments when the owner is not an ISB member", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue(undefined);

        const event = createPutEvent({
          assignments: [
            {
              principalId: "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440099",
              principalType: "USER",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toBe(
          `The lease owner ${putOwnerEmail} is not a current Innovation Sandbox member.`,
        );
        expect(
          DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
        ).not.toHaveBeenCalled();
        expect(
          IsbEventBridgeClient.prototype.sendIsbEvent,
        ).not.toHaveBeenCalled();
      });

      it("should return 500 without changing assignments when the owner lookup fails unexpectedly", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockRejectedValue(new Error("Identity Center unavailable"));

        const response = await handler(
          createPutEvent({ assignments: [] }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(500);
        expect(
          DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
        ).not.toHaveBeenCalled();
        expect(
          IsbEventBridgeClient.prototype.sendIsbEvent,
        ).not.toHaveBeenCalled();
      });

      it.each([
        {
          reason: "a held lock",
          error: new ResourceLockConflictError("Lock held"),
          statusCode: 409,
          message:
            "Another operation is currently being processed for this lease. Try again once it completes.",
        },
        {
          reason: "a deleted lease",
          error: new UnknownItem("Lease no longer exists"),
          statusCode: 404,
          message: "Lease not found.",
        },
      ])(
        "reports $reason precisely and publishes nothing",
        async ({ error, statusCode, message }) => {
          vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
            result: putActiveLease,
          });
          stubServiceToSucceed();
          vi.mocked(
            DynamoLeaseStore.prototype.acquireLockWithDesiredAssignments,
          ).mockRejectedValue(error);

          const response = await handler(
            createPutEvent({
              assignments: [
                { principalId: putOwnerIdcId, principalType: "USER" },
              ],
            }),
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          );

          expect(response.statusCode).toBe(statusCode);
          expect(JSON.parse(response.body).data.errors[0].message).toBe(
            message,
          );
          expect(
            IsbEventBridgeClient.prototype.sendIsbEvent,
          ).not.toHaveBeenCalled();
          expect(DynamoLeaseStore.prototype.releaseLock).not.toHaveBeenCalled();
        },
      );

      it("should map MaxAssignmentsExceededError to 400", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockRejectedValue(
          new MaxAssignmentsExceededError(
            "Maximum of 20 total assignments allowed.",
          ),
        );

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("Maximum of 20");
      });

      it("should map IneligibleAssignmentPrincipalError to 400", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockRejectedValue(new IneligibleAssignmentPrincipalError());

        const response = await handler(
          createPutEvent({
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].message).toBe(
          "A lease assignment includes a user who is not a current Innovation Sandbox member.",
        );
      });
    });

    describe("happy path", () => {
      it("should return 202 on successful delegation to service", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: "user#c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
            principalId: "c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
            principalType: "USER",
            email: "seconduser@example.com",
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockResolvedValue(MOCK_ACQUIRED_LOCK);
        vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        ).mockResolvedValue(undefined as any);

        const event = createPutEvent({
          assignments: [
            {
              principalId: "c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
              principalType: "USER",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data).toHaveProperty("desiredCount");
      });
    });
  });

  describe("lease cost routes", () => {
    // The worked example from the design doc, so the arithmetic below is pinned to
    // the figures the design states rather than to whatever the code produces.
    const LAST_CHECKED_AT = "2026-08-11T11:00:00.000Z";
    const observations: CostObservation[] = [
      costRow("2026-08-11T08:00:00.000Z", 60, 46, {
        "Amazon Bedrock": 52.1,
        "Amazon Elastic Compute Cloud - Compute": 6.4,
        "Amazon Simple Storage Service": 1.5,
      }),
      costRow("2026-08-11T00:00:00.000Z", 32, 28, {
        "Amazon Bedrock": 24.6,
        "Amazon Elastic Compute Cloud - Compute": 6.2,
        "Amazon Simple Storage Service": 1.2,
      }),
      costRow("2026-08-10T16:00:00.000Z", 18, null, {
        "Amazon Bedrock": 11.2,
        "Amazon Elastic Compute Cloud - Compute": 5.9,
        "Amazon Simple Storage Service": 0.9,
      }),
      costRow("2026-08-10T08:00:00.000Z", 8, null, {
        "Amazon Bedrock": 2.0,
        "Amazon Elastic Compute Cloud - Compute": 5.2,
        "Amazon Simple Storage Service": 0.8,
      }),
    ];

    function costRow(
      timestamp: string,
      billedCostAccrued: number,
      predictedCostAtRefresh: number | null,
      serviceBreakdown?: Record<string, number>,
    ): CostObservation {
      return {
        leaseUuid: randomUUID(),
        sk: `COST#${timestamp}`,
        billedCostAccrued,
        billedCostDelta: 0,
        predictedCostAtRefresh,
        latestPeriodStart: timestamp.slice(0, 10),
        latestPeriodAmount: 0,
        ...(serviceBreakdown === undefined
          ? {}
          : { serviceBreakdown, latestPeriodServiceAmounts: serviceBreakdown }),
        billedBedrockTokenCost: null,
        ttl: futureTtl(),
        meta: { schemaVersion: LeaseCostHistorySchemaVersion },
      };
    }

    function monitoredLease(overrides: Partial<PersistedMonitoredLease> = {}) {
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: isbAuthorizedUser.user.email,
      });
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseKey,
        status: "Active",
        startDate: "2026-08-10T00:00:00.000Z",
        lastCheckedDate: LAST_CHECKED_AT,
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
        ],
        rateLimits: [
          { basis: "HOURLY", rate: 12, action: "ALERT" },
          { basis: "DAILY", rate: 200, action: "ALERT" },
        ],
        predictiveBudgetEnabled: true,
        bedrockTokenMonitoringEnabled: false,
        // What the last monitoring run persisted for the series below, since
        // `current` reports these back rather than recomputing them; the generator
        // would otherwise randomize all four.
        lastPredictedSpend: 70.5,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 52,
        lastEvaluatedSpend: null,
        ...overrides,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      return {
        lease,
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        })!,
      };
    }

    function mockCostHistory(
      rows: CostObservation[],
      overrides: {
        nextPageIdentifier?: string | null;
        recent?: Awaited<
          ReturnType<DynamoLeaseCostHistoryStore["getRecentCostObservations"]>
        >;
        breaches?: BreachRecord[];
        tokens?: BedrockTokenRow[];
      } = {},
    ) {
      const nextPageIdentifier = overrides.nextPageIdentifier ?? null;
      const listCostObservations = vi
        .spyOn(DynamoLeaseCostHistoryStore.prototype, "listCostObservations")
        .mockResolvedValue({ result: rows, nextPageIdentifier });
      const getRecentCostObservations = vi
        .spyOn(
          DynamoLeaseCostHistoryStore.prototype,
          "getRecentCostObservations",
        )
        .mockResolvedValue(
          overrides.recent ?? { complete: true, result: rows },
        );
      const listBreachRecordPage = vi
        .spyOn(DynamoLeaseCostHistoryStore.prototype, "listBreachRecordPage")
        .mockResolvedValue({
          result: overrides.breaches ?? [],
          nextPageIdentifier,
        });
      const listBedrockTokenRows = vi
        .spyOn(DynamoLeaseCostHistoryStore.prototype, "listBedrockTokenRows")
        .mockResolvedValue({
          result: overrides.tokens ?? [],
          nextPageIdentifier,
        });
      vi.spyOn(
        DynamoLeaseCostHistoryStore.prototype,
        "getNewestBedrockTokenRow",
      ).mockResolvedValue({ complete: true, result: overrides.tokens?.[0] });
      return {
        listCostObservations,
        getRecentCostObservations,
        listBreachRecordPage,
        listBedrockTokenRows,
      };
    }

    /** The cursor the store hands back: the oldest row the previous page returned. */
    function pageCursor(
      leaseUuid: string,
      timestamp: string,
      window: { from: string; to: string } | null = null,
      skPrefix = "COST#",
    ) {
      return base64EncodeCompositeKey({
        version: 1,
        key: { leaseUuid, sk: `${skPrefix}${timestamp}` },
        window,
      })!;
    }

    type CostRoute =
      "costSummary" | "costHistory" | "bedrockTokenHistory" | "breachHistory";

    async function getRoute(
      route: CostRoute,
      leaseId: string,
      queryStringParameters: Record<string, string> = {},
      user: IsbUser = isbAuthorizedUser.user,
    ) {
      return handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leases/${leaseId}/${route}`,
          isbUser: user,
          queryStringParameters,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
    }

    async function dataOf(
      route: CostRoute,
      leaseId: string,
      queryStringParameters: Record<string, string> = {},
    ) {
      return JSON.parse(
        (await getRoute(route, leaseId, queryStringParameters)).body,
      ).data;
    }

    /** Each history route, the store read behind it and the prefix its cursors carry. */
    const historyRoutes = [
      ["costHistory", "listCostObservations", "COST#"],
      ["bedrockTokenHistory", "listBedrockTokenRows", "BEDROCK_TOKEN#"],
      ["breachHistory", "listBreachRecordPage", "BREACH#"],
    ] as const;

    describe("GET /leases/{leaseId}/costSummary", () => {
      it("reproduces the worked example's headline figures and returns nothing else", async () => {
        const { leaseId } = monitoredLease();
        const mocks = mockCostHistory(observations);

        const response = await getRoute("costSummary", leaseId);

        expect(response.statusCode).toBe(200);
        const { data } = JSON.parse(response.body);
        expect(Object.keys(data)).toEqual(["current"]);
        expect(data.current).toEqual({
          billedCostAccrued: 60,
          predictedCost: 70.5,
          hourlyRate: 3.5,
          dailyRate: 52,
          hourlyRateWindowHours: 8,
          dailyRateWindowHours: 24,
          rateSource: "HOURLY",
          hoursToBudgetExhaustion: 8.4,
          latestPeriodStart: "2026-08-11",
          lastReportedAt: "2026-08-11T08:00:00.000Z",
          lastCheckedAt: LAST_CHECKED_AT,
          services: [
            {
              service: "Amazon Bedrock",
              amount: 52.1,
              shareOfBilledCost: 0.87,
              changePercent: 112,
            },
            {
              service: "Amazon Elastic Compute Cloud - Compute",
              amount: 6.4,
              shareOfBilledCost: 0.11,
              changePercent: 3,
            },
            {
              service: "Amazon Simple Storage Service",
              amount: 1.5,
              shareOfBilledCost: 0.02,
              changePercent: 25,
            },
          ],
        });

        // Independent rounding would total 1.01; the smallest share is the residual.
        expect(
          data.current.services.reduce(
            (sum: number, entry: { shareOfBilledCost: number }) =>
              sum + entry.shareOfBilledCost,
            0,
          ),
        ).toBeCloseTo(1, 10);
        // The headline comes from the newest readings, never from a history page.
        expect(mocks.getRecentCostObservations).toHaveBeenCalledOnce();
        expect(mocks.listCostObservations).not.toHaveBeenCalled();
      });

      it("keeps the shares summing to 1.00 behind a long tail of small services", async () => {
        const tail = Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`Service ${index}`, 0.5]),
        );
        const { leaseId } = monitoredLease();
        mockCostHistory([
          costRow("2026-08-11T08:00:00.000Z", 100, 46, {
            "Amazon Bedrock": 95,
            ...tail,
          }),
        ]);

        const data = await dataOf("costSummary", leaseId);

        // Each tail entry is 0.005 of the total, which rounds up on its own: eleven
        // independently rounded shares would total 1.04 and leave no residual.
        const shares = data.current.services.map(
          (entry: { shareOfBilledCost: number }) => entry.shareOfBilledCost,
        );
        expect(shares[0]).toBe(0.95);
        expect(Math.min(...shares)).toBeGreaterThanOrEqual(0);
        expect(
          shares.reduce((sum: number, share: number) => sum + share, 0),
        ).toBeCloseTo(1, 10);
      });

      it("omits every rate-derived figure for a lease in its first reporting interval", async () => {
        const { leaseId } = monitoredLease({
          lastPredictedSpend: null,
          lastEvaluatedHourlySpendRate: null,
          lastEvaluatedDailySpendRate: null,
        });
        mockCostHistory([observations[0]!]);

        const response = await getRoute("costSummary", leaseId);

        expect(response.statusCode).toBe(200);
        const { data } = JSON.parse(response.body);
        for (const field of [
          "hourlyRate",
          "dailyRate",
          "hourlyRateWindowHours",
          "dailyRateWindowHours",
          "rateSource",
          "hoursToBudgetExhaustion",
        ]) {
          expect(data.current).not.toHaveProperty(field);
        }
        // The projection falls back to the reported total rather than going absent.
        expect(data.current.predictedCost).toBe(60);
        expect(data.current.services[0]).not.toHaveProperty("changePercent");
      });

      it("reports no rate-derived figure for a lease that never opted in", async () => {
        // The persisted scalars are left in place, so what suppresses the figures
        // below is the opt-in and not an absence of stored numbers.
        const { leaseId } = monitoredLease({ predictiveBudgetEnabled: false });
        mockCostHistory(
          observations.map((row) => ({ ...row, predictedCostAtRefresh: null })),
        );

        const data = await dataOf("costSummary", leaseId);

        // No rate was ever computed for the lease, so nothing that differences one
        // reading against another is reported.
        expect(data.current).not.toHaveProperty("hourlyRate");
        expect(data.current).not.toHaveProperty("rateSource");
        expect(data.current).not.toHaveProperty("hoursToBudgetExhaustion");
        expect(data.current.services[0]).not.toHaveProperty("changePercent");
        expect(data.current.billedCostAccrued).toBe(60);
      });

      it("omits the exhaustion countdown when there is no budget to exhaust", async () => {
        const { leaseId } = monitoredLease({ maxSpend: undefined });
        mockCostHistory(observations);

        const data = await dataOf("costSummary", leaseId);

        expect(data.current).not.toHaveProperty("hoursToBudgetExhaustion");
      });

      it("omits the exhaustion countdown on a flat series rather than dividing by a zero rate", async () => {
        const { leaseId } = monitoredLease({
          lastPredictedSpend: 60,
          lastEvaluatedHourlySpendRate: 0,
          lastEvaluatedDailySpendRate: 0,
        });
        mockCostHistory(
          observations.map((row) => ({ ...row, billedCostAccrued: 60 })),
        );

        const data = await dataOf("costSummary", leaseId);

        expect(data.current.hourlyRate).toBe(0);
        // Not Infinity, which is what dividing the remaining budget by 0 would give.
        expect(data.current).not.toHaveProperty("hoursToBudgetExhaustion");
      });

      it("returns an empty services array with a non-zero reported cost when no breakdown is collected", async () => {
        const { leaseId } = monitoredLease();
        mockCostHistory([
          costRow("2026-08-11T08:00:00.000Z", 60, 46),
          costRow("2026-08-11T00:00:00.000Z", 32, 28),
        ]);

        const data = await dataOf("costSummary", leaseId);

        expect(data.current.services).toEqual([]);
        expect(data.current.billedCostAccrued).toBe(60);
      });

      it("returns an empty services array when the breakdown covers only part of the reported total", async () => {
        const { leaseId } = monitoredLease();
        mockCostHistory([
          {
            ...costRow("2026-08-11T08:00:00.000Z", 60, 46, {
              "Amazon Bedrock": 30,
              "Amazon Simple Storage Service": 10,
            }),
            breakdownCoversFrom: "2026-08-11",
          },
          observations[1]!,
        ]);

        const data = await dataOf("costSummary", leaseId);

        // Sharing $40 of breakdown over a $60 total hands the $20 collected before
        // the breakdown started to the smallest service as the residual.
        expect(data.current.services).toEqual([]);
        expect(data.current.billedCostAccrued).toBe(60);
      });

      it("labels the persisted rate on a series too short to measure its window", async () => {
        const { leaseId } = monitoredLease();
        mockCostHistory([observations[0]!]);

        const data = await dataOf("costSummary", leaseId);

        // The run persisted an hourly rate, so the figure and the label reporting
        // which of the two rates it is have to arrive together.
        expect(data.current.hourlyRate).toBe(3.5);
        expect(data.current.rateSource).toBe("HOURLY");
        // The window needs a second reading to measure, and goes absent.
        expect(data.current).not.toHaveProperty("hourlyRateWindowHours");
      });

      it("omits current when the observation series is unreadable", async () => {
        const { leaseId } = monitoredLease();
        mockCostHistory(observations, {
          recent: {
            complete: false,
            droppedRecordCount: 1,
            droppedRecordReason: "SCHEMA_VALIDATION",
          },
        });

        const data = await dataOf("costSummary", leaseId);

        // Absent rather than zeroed: "$0.00 spent" on a lease that may be at its cap.
        expect(data).toEqual({});
      });

      it("recomputes the remainder rates and burns the countdown at the summed rates the poll persisted on a monitored lease", async () => {
        // The design's worked example: the persisted pair holds remainder plus
        // monitored Bedrock, 2.00 + 6.00 an hour, and the projection anchored on the
        // evaluated spend.
        const { leaseId, lease } = monitoredLease({
          bedrockTokenMonitoringEnabled: true,
          lastEvaluatedSpend: 66,
          lastPredictedSpend: 72,
          lastEvaluatedHourlySpendRate: 8,
          lastEvaluatedDailySpendRate: null,
        });
        const liveRow = generateSchemaData(BedrockTokenRowSchema, {
          leaseUuid: lease.uuid,
          sk: "BEDROCK_TOKEN#2026-08-11T10:50:00.000Z",
          monitoredBedrockTokenCost: 26,
          monitoredBedrockTokenCostDelta: 6,
        });
        mockCostHistory(
          [
            { ...observations[0]!, billedBedrockTokenCost: 20 },
            { ...observations[1]!, billedBedrockTokenCost: 8 },
          ],
          { tokens: [liveRow] },
        );

        const data = await dataOf("costSummary", leaseId);

        expect(data.current).toMatchObject({
          predictedCost: 72,
          // (40 - 24) over eight hours: the rate the projection carried forward
          hourlyRate: 2,
          hourlyRateWindowHours: 8,
        });
        // the countdown burns at the summed rate: (100 - 72) / 8
        expect(data.current.hoursToBudgetExhaustion).toBe(3.5);
      });

      it("anchors its own projection on evaluated spend while the poll has not written one", async () => {
        const { leaseId, lease } = monitoredLease({
          bedrockTokenMonitoringEnabled: true,
          lastEvaluatedSpend: 66,
          lastPredictedSpend: null,
          lastEvaluatedHourlySpendRate: null,
          lastEvaluatedDailySpendRate: null,
        });
        const liveRow = generateSchemaData(BedrockTokenRowSchema, {
          leaseUuid: lease.uuid,
          sk: "BEDROCK_TOKEN#2026-08-11T10:50:00.000Z",
          monitoredBedrockTokenCost: 26,
          monitoredBedrockTokenCostDelta: 6,
        });
        mockCostHistory(
          [
            { ...observations[0]!, billedBedrockTokenCost: 20 },
            { ...observations[1]!, billedBedrockTokenCost: 8 },
          ],
          { tokens: [liveRow] },
        );

        const data = await dataOf("costSummary", leaseId);

        // 66.00 carried forward three hours at the 2.00 remainder rate, not 60.00
        expect(data.current.predictedCost).toBeCloseTo(72, 10);
      });

      it("measures a monitored lease with no monitored value as an unmonitored one", async () => {
        const { leaseId } = monitoredLease({
          bedrockTokenMonitoringEnabled: true,
          lastEvaluatedSpend: 60,
          lastPredictedSpend: 60,
          lastEvaluatedHourlySpendRate: 3.5,
          lastEvaluatedDailySpendRate: null,
        });
        mockCostHistory([
          { ...observations[0]!, billedBedrockTokenCost: 20 },
          { ...observations[1]!, billedBedrockTokenCost: 8 },
        ]);

        const data = await dataOf("costSummary", leaseId);

        // no token row, so nothing is swapped in: the billed rate
        expect(data.current).toMatchObject({ hourlyRate: 3.5 });
      });
    });

    describe("GET /leases/{leaseId}/costHistory", () => {
      it("returns the reported series and nothing else", async () => {
        const { leaseId } = monitoredLease();
        const mocks = mockCostHistory(observations);

        const response = await getRoute("costHistory", leaseId);

        expect(response.statusCode).toBe(200);
        const { data } = JSON.parse(response.body);
        // The cursor is null on the last page, which the wire omits.
        expect(Object.keys(data)).toEqual(["result"]);
        expect(data.result).toEqual([
          {
            timestamp: "2026-08-11T08:00:00.000Z",
            billedCostAccrued: 60,
            predictedCostAtRefresh: 46,
            serviceBreakdown: {
              "Amazon Bedrock": 52.1,
              "Amazon Elastic Compute Cloud - Compute": 6.4,
              "Amazon Simple Storage Service": 1.5,
            },
          },
          expect.objectContaining({
            timestamp: "2026-08-11T00:00:00.000Z",
            billedCostAccrued: 32,
            predictedCostAtRefresh: 28,
          }),
          expect.objectContaining({ timestamp: "2026-08-10T16:00:00.000Z" }),
          expect.objectContaining({ timestamp: "2026-08-10T08:00:00.000Z" }),
        ]);
        // The headline figures belong to the cost summary alone.
        expect(mocks.getRecentCostObservations).not.toHaveBeenCalled();
      });

      it("omits a row's null projection and absent breakdown", async () => {
        const { leaseId } = monitoredLease();
        mockCostHistory([costRow("2026-08-10T08:00:00.000Z", 8, null)]);

        const data = await dataOf("costHistory", leaseId);

        expect(data.result).toEqual([
          { timestamp: "2026-08-10T08:00:00.000Z", billedCostAccrued: 8 },
        ]);
      });

      it.each([
        ["extended", "2026-08-10T18:00:00+05:00"],
        ["basic", "2026-08-10T18:00:00+0500"],
        ["hour-only", "2026-08-10T18:00:00+05"],
      ])(
        "normalizes an offset-bearing bound in %s form to UTC",
        async (_form, afterTimestamp) => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);

          await getRoute("costHistory", leaseId, {
            afterTimestamp,
            beforeTimestamp: "2026-08-11T04:00:00Z",
          });

          // The sort keys are fixed-width UTC millis, so a bound that is neither
          // would drop the rows nearest the edge it names.
          expect(mocks.listCostObservations).toHaveBeenCalledWith(
            expect.any(String),
            {
              pageSize: 100,
              window: {
                from: "2026-08-10T13:00:00.000Z",
                to: "2026-08-11T03:59:59.999Z",
              },
            },
          );
        },
      );

      it("fills a lone upper bound with the lease's start", async () => {
        const { leaseId, lease } = monitoredLease();
        const mocks = mockCostHistory(observations);

        await getRoute("costHistory", leaseId, {
          beforeTimestamp: "2026-08-11T04:00:00.000Z",
        });

        expect(mocks.listCostObservations).toHaveBeenCalledWith(
          expect.any(String),
          {
            pageSize: 100,
            window: { from: lease.startDate, to: "2026-08-11T03:59:59.999Z" },
          },
        );
      });

      it("fills a lone lower bound with now", async () => {
        const { leaseId } = monitoredLease();
        const mocks = mockCostHistory(observations);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime("2026-08-11T09:30:00.000Z");

        try {
          await getRoute("costHistory", leaseId, {
            afterTimestamp: "2026-08-10T12:00:00.000Z",
          });
        } finally {
          vi.useRealTimers();
        }

        // Now itself, not the newest reading or the millisecond before now: a
        // "since" range has to keep including whatever lands next.
        expect(mocks.listCostObservations).toHaveBeenCalledWith(
          expect.any(String),
          {
            pageSize: 100,
            window: {
              from: "2026-08-10T12:00:00.000Z",
              to: "2026-08-11T09:30:00.000Z",
            },
          },
        );
      });

      it("preserves a resolved upper bound across lower-bound-only pages", async () => {
        const { leaseId, lease } = monitoredLease();
        const window = {
          from: "2026-08-10T12:00:00.000Z",
          to: "2026-08-12T00:00:00.000Z",
        };
        const cursor = pageCursor(
          lease.uuid,
          "2026-08-11T00:00:00.000Z",
          window,
        );
        const mocks = mockCostHistory(observations.slice(2));

        await getRoute("costHistory", leaseId, {
          pageIdentifier: cursor,
          afterTimestamp: window.from,
        });

        expect(mocks.listCostObservations).toHaveBeenCalledWith(
          expect.any(String),
          { pageSize: 100, pageIdentifier: cursor, window },
        );
      });

      it("takes the window from the cursor where the page resends no bounds", async () => {
        const { leaseId, lease } = monitoredLease();
        const window = {
          from: "2026-08-10T12:00:00.000Z",
          to: "2026-08-12T00:00:00.000Z",
        };
        const cursor = pageCursor(
          lease.uuid,
          "2026-08-11T00:00:00.000Z",
          window,
        );
        const mocks = mockCostHistory(observations.slice(2));

        await getRoute("costHistory", leaseId, { pageIdentifier: cursor });

        // Read as unbounded, this would hand the store a cursor cut against a window
        // the request no longer names, which it rejects as mismatched.
        expect(mocks.listCostObservations).toHaveBeenCalledWith(
          expect.any(String),
          { pageSize: 100, pageIdentifier: cursor, window },
        );
      });

      it.each([
        ["a bound that is not an instant", { afterTimestamp: "last tuesday" }],
        ["a date-only bound", { afterTimestamp: "2026-08-10" }],
        [
          "a timezone-less bound",
          { afterTimestamp: "2026-08-10T12:00:00.000" },
        ],
        [
          "an expanded-year bound",
          { afterTimestamp: "+010000-01-01T00:00:00.000Z" },
        ],
        ["an upper bound that is not an instant", { beforeTimestamp: "soon" }],
        [
          "an upper bound with no fixed-width instant before it",
          { beforeTimestamp: "0000-01-01T00:00:00.000Z" },
        ],
      ])("should return 400 for %s", async (_name, range) => {
        const { leaseId } = monitoredLease();
        const mocks = mockCostHistory(observations);

        const response = await getRoute("costHistory", leaseId, range);

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain(
          `${Object.keys(range)[0]} must be an ISO 8601 instant.`,
        );
        expect(mocks.listCostObservations).not.toHaveBeenCalled();
      });
    });

    describe("GET /leases/{leaseId}/bedrockTokenHistory", () => {
      it("returns the flattened token series and nothing else", async () => {
        const { leaseId, lease } = monitoredLease();
        const tokenRow = generateSchemaData(BedrockTokenRowSchema, {
          leaseUuid: lease.uuid,
          sk: "BEDROCK_TOKEN#2026-08-11T10:55:00.000Z",
          tokens: {
            "us-east-1": {
              "amazon.nova-pro-v1:0": {
                input: 184320,
                output: 41200,
                cacheRead: 1104000,
                cacheWrite: 92400,
              },
            },
          },
          coveredThrough: { "us-east-1": "2026-08-11T10:55:00.000Z" },
          monitoredBedrockTokenCost: 12.44,
          monitoredBedrockTokenCostDelta: 1,
        });
        mockCostHistory(observations, { tokens: [tokenRow] });

        const data = await dataOf("bedrockTokenHistory", leaseId);

        expect(Object.keys(data)).toEqual(["result"]);
        // `coveredThrough`, an internal poll anchor, never reaches the response.
        expect(data.result).toEqual([
          {
            timestamp: "2026-08-11T10:55:00.000Z",
            region: "us-east-1",
            modelId: "amazon.nova-pro-v1:0",
            input: 184320,
            output: 41200,
            cacheRead: 1104000,
            cacheWrite: 92400,
            monitoredBedrockTokenCost: 12.44,
          },
        ]);
      });

      it("serves the reading before a range as a one-reading page", async () => {
        const { leaseId, lease } = monitoredLease();
        const before = generateSchemaData(BedrockTokenRowSchema, {
          leaseUuid: lease.uuid,
          sk: "BEDROCK_TOKEN#2026-08-10T23:50:00.000Z",
          tokens: {
            "us-east-1": {
              "amazon.nova-pro-v1:0": {
                input: 120,
                output: 40,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          },
          coveredThrough: { "us-east-1": "2026-08-10T23:50:00.000Z" },
          monitoredBedrockTokenCost: 0.01,
          monitoredBedrockTokenCostDelta: 0.01,
        });
        const mocks = mockCostHistory(observations, { tokens: [before] });

        // What a client measuring a range from 2026-08-11T00:00Z asks for.
        const data = await dataOf("bedrockTokenHistory", leaseId, {
          beforeTimestamp: "2026-08-11T00:00:00.000Z",
          maxResults: "1",
        });

        expect(mocks.listBedrockTokenRows).toHaveBeenCalledWith(lease.uuid, {
          pageSize: 1,
          window: { from: lease.startDate, to: "2026-08-10T23:59:59.999Z" },
        });
        expect(data.result).toEqual([
          {
            timestamp: "2026-08-10T23:50:00.000Z",
            region: "us-east-1",
            modelId: "amazon.nova-pro-v1:0",
            input: 120,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            monitoredBedrockTokenCost: 0.01,
          },
        ]);
      });

      it("serves the reading before a range that opens before the lease as an empty page", async () => {
        const { leaseId, lease } = monitoredLease();
        const mocks = mockCostHistory(observations);

        // A seven-day range on a lease that started 2026-08-10T00:00Z.
        const response = await getRoute("bedrockTokenHistory", leaseId, {
          beforeTimestamp: "2026-08-05T00:00:00.000Z",
          maxResults: "1",
        });

        // Not the 400 an inverted range gets: filling the lower bound with the
        // lease start would put it after the upper bound.
        expect(response.statusCode).toBe(200);
        expect(mocks.listBedrockTokenRows).toHaveBeenCalledWith(lease.uuid, {
          pageSize: 1,
          window: {
            from: "1970-01-01T00:00:00.000Z",
            to: "2026-08-04T23:59:59.999Z",
          },
        });
        // No reading and no cursor: nothing precedes the range.
        expect(JSON.parse(response.body).data).toEqual({ result: [] });
      });

      it("serves the reading before a range that opens at the epoch as an empty page", async () => {
        const { leaseId, lease } = monitoredLease();
        const mocks = mockCostHistory(observations);
        const lastIncluded = "1969-12-31T23:59:59.999Z";

        const response = await getRoute("bedrockTokenHistory", leaseId, {
          beforeTimestamp: "1970-01-01T00:00:00.000Z",
          maxResults: "1",
        });

        // Not the epoch floor as the lower bound, which would invert the window
        // and make the store throw.
        expect(response.statusCode).toBe(200);
        expect(mocks.listBedrockTokenRows).toHaveBeenCalledWith(lease.uuid, {
          pageSize: 1,
          window: { from: lastIncluded, to: lastIncluded },
        });
        expect(JSON.parse(response.body).data).toEqual({ result: [] });
      });
    });

    describe("GET /leases/{leaseId}/breachHistory", () => {
      it("returns the thresholds that fired and nothing else", async () => {
        const { leaseId, lease } = monitoredLease();
        const breach = generateSchemaData(BreachRecordSchema, {
          leaseUuid: lease.uuid,
          sk: `BREACH#${LAST_CHECKED_AT}`,
          triggeredBy: "PREDICTED",
          action: "ALERT",
          thresholdDollars: 70,
          thresholdRate: null,
          thresholdRateBasis: null,
          billedCostAtFire: 60,
          predictedCostAtFire: 70.5,
          rateAtFire: 3.5,
          rateSourceAtFire: "HOURLY",
          evaluatedBy: "LEASE_MONITORING",
          evaluatedSpendAtFire: null,
          monitoredBedrockTokenCostAtFire: null,
          insight: null,
        });
        mockCostHistory(observations, { breaches: [breach] });

        const data = await dataOf("breachHistory", leaseId);

        expect(Object.keys(data)).toEqual(["result"]);
        expect(data.result).toEqual([
          expect.objectContaining({
            timestamp: LAST_CHECKED_AT,
            triggeredBy: "PREDICTED",
            thresholdDollars: 70,
            predictedCostAtFire: 70.5,
          }),
        ]);
      });

      it("returns DURATION and EXPIRY breaches", async () => {
        const { leaseId, lease } = monitoredLease();
        // Measured in time and checked only by Lease Monitoring, so neither kind
        // names a dollar or rate threshold, a projection, a rate or an evaluated spend figure.
        const leaseEnd: Omit<BreachRecord, "sk" | "triggeredBy" | "action"> = {
          leaseUuid: lease.uuid,
          thresholdDollars: null,
          thresholdRate: null,
          thresholdRateBasis: null,
          billedCostAtFire: 60,
          predictedCostAtFire: null,
          evaluatedBy: "LEASE_MONITORING",
          evaluatedSpendAtFire: null,
          monitoredBedrockTokenCostAtFire: null,
          rateAtFire: null,
          rateSourceAtFire: null,
          insight: null,
          ttl: futureTtl(),
          meta: { schemaVersion: LeaseCostHistorySchemaVersion },
        };
        mockCostHistory(observations, {
          breaches: [
            {
              ...leaseEnd,
              sk: "BREACH#2026-08-11T10:00:00.000Z",
              triggeredBy: "EXPIRY",
              action: "TERMINATE",
            },
            {
              ...leaseEnd,
              sk: "BREACH#2026-08-10T10:00:00.000Z",
              triggeredBy: "DURATION",
              action: "FREEZE_ACCOUNT",
              thresholdHoursRemaining: 24,
            },
          ],
        });

        const data = await dataOf("breachHistory", leaseId);

        // The wire omits the null members rather than sending them.
        expect(data.result).toEqual([
          {
            timestamp: "2026-08-11T10:00:00.000Z",
            triggeredBy: "EXPIRY",
            action: "TERMINATE",
            billedCostAtFire: 60,
            evaluatedBy: "LEASE_MONITORING",
          },
          {
            timestamp: "2026-08-10T10:00:00.000Z",
            triggeredBy: "DURATION",
            action: "FREEZE_ACCOUNT",
            thresholdHoursRemaining: 24,
            billedCostAtFire: 60,
            evaluatedBy: "LEASE_MONITORING",
          },
        ]);
      });

      it("returns a RATE breach's rate threshold, evaluated spend figures and insight", async () => {
        const { leaseId, lease } = monitoredLease();
        mockCostHistory(observations, {
          breaches: [
            {
              leaseUuid: lease.uuid,
              sk: `BREACH#${LAST_CHECKED_AT}`,
              triggeredBy: "RATE",
              action: "ALERT",
              thresholdDollars: null,
              thresholdRate: 12,
              thresholdRateBasis: "HOURLY",
              billedCostAtFire: 60,
              predictedCostAtFire: null,
              evaluatedBy: "TOKEN_POLL",
              evaluatedSpendAtFire: 66,
              monitoredBedrockTokenCostAtFire: 26,
              rateAtFire: 14,
              rateSourceAtFire: "HOURLY",
              insight: {
                kind: "COMPOSITION",
                service: "Amazon Bedrock",
                amount: 52.1,
                shareOfComparedSpend: 0.87,
              },
              ttl: futureTtl(),
              meta: { schemaVersion: LeaseCostHistorySchemaVersion },
            },
          ],
        });

        const data = await dataOf("breachHistory", leaseId);

        // The null members are omitted; the insight arrives as it was stored.
        expect(data.result).toEqual([
          {
            timestamp: LAST_CHECKED_AT,
            triggeredBy: "RATE",
            action: "ALERT",
            thresholdRate: 12,
            thresholdRateBasis: "HOURLY",
            billedCostAtFire: 60,
            rateAtFire: 14,
            rateSourceAtFire: "HOURLY",
            evaluatedBy: "TOKEN_POLL",
            evaluatedSpendAtFire: 66,
            monitoredBedrockTokenCostAtFire: 26,
            insight: {
              kind: "COMPOSITION",
              service: "Amazon Bedrock",
              amount: 52.1,
              shareOfComparedSpend: 0.87,
            },
          },
        ]);
      });
    });

    describe.each(historyRoutes)(
      "GET /leases/{leaseId}/%s paging and range",
      (route, read, skPrefix) => {
        it("defaults maxResults to 100 and ignores the pre-Smithy pageSize name", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);

          await getRoute(route, leaseId, { pageSize: "5" });

          expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
            pageSize: 100,
          });
        });

        it("passes maxResults and pageIdentifier through and returns the next cursor", async () => {
          const { leaseId, lease } = monitoredLease();
          const mocks = mockCostHistory(observations, {
            nextPageIdentifier: "cursor-2",
          });
          const cursor = pageCursor(
            lease.uuid,
            "2026-08-11T16:00:00.000Z",
            null,
            skPrefix,
          );

          const data = await dataOf(route, leaseId, {
            maxResults: "50",
            pageIdentifier: cursor,
          });

          expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
            pageSize: 50,
            pageIdentifier: cursor,
          });
          expect(data.nextPageIdentifier).toBe("cursor-2");
        });

        it("includes a reading at afterTimestamp and excludes one at beforeTimestamp", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);

          await getRoute(route, leaseId, {
            afterTimestamp: "2026-08-10T16:00:00.000Z",
            beforeTimestamp: "2026-08-11T08:00:00.000Z",
          });

          // The store's `BETWEEN` includes both ends, so a row at afterTimestamp
          // is read, and the exclusive bound reaches it as the millisecond before,
          // which leaves out a row at beforeTimestamp.
          expect(mocks[read]).toHaveBeenCalledOnce();
          expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
            pageSize: 100,
            window: {
              from: "2026-08-10T16:00:00.000Z",
              to: "2026-08-11T07:59:59.999Z",
            },
          });
        });

        it("keeps the window on a later page that resends the bounds", async () => {
          const { leaseId, lease } = monitoredLease();
          const mocks = mockCostHistory(observations);
          const range = {
            afterTimestamp: "2026-08-10T12:00:00.000Z",
            beforeTimestamp: "2026-08-11T04:00:00.000Z",
          };
          // The window the first page was read against, which its cursor carries.
          const window = {
            from: "2026-08-10T12:00:00.000Z",
            to: "2026-08-11T03:59:59.999Z",
          };
          const cursor = pageCursor(
            lease.uuid,
            "2026-08-11T00:00:00.000Z",
            window,
            skPrefix,
          );

          await getRoute(route, leaseId, range);
          await getRoute(route, leaseId, { ...range, pageIdentifier: cursor });

          expect(mocks[read]).toHaveBeenNthCalledWith(1, expect.any(String), {
            pageSize: 100,
            window,
          });
          // The store rejects a cursor whose window differs from the request's.
          expect(mocks[read]).toHaveBeenNthCalledWith(2, expect.any(String), {
            pageSize: 100,
            pageIdentifier: cursor,
            window,
          });
        });

        it("maps an invalid page identifier to a static 400 response", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);
          mocks[read].mockRejectedValue(
            new InvalidCostHistoryPageIdentifierError(),
          );

          const response = await getRoute(route, leaseId, {
            pageIdentifier: "caller-supplied-cursor",
          });

          expect(response.statusCode).toBe(400);
          expect(response.body).toContain(
            "pageIdentifier is not a valid pagination cursor.",
          );
          expect(response.body).not.toContain("caller-supplied-cursor");
        });

        it("should return 500 rather than the invalid-cursor 400 for any other store failure", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);
          mocks[read].mockRejectedValue(new Error("ddb down"));

          const response = await getRoute(route, leaseId);

          expect(response.statusCode).toBe(500);
          expect(response.body).not.toContain(
            "pageIdentifier is not a valid pagination cursor.",
          );
        });

        it.each(historyRoutes.filter(([other]) => other !== route))(
          "should return 400 for a cursor from %s",
          async (_other, _otherRead, otherPrefix) => {
            const { leaseId, lease } = monitoredLease();
            const mocks = mockCostHistory(observations);
            // The store's own check rather than a stub: a cursor resumes only the
            // row type it was cut from, which the store reads off its sort key.
            mocks[read].mockRestore();

            const response = await getRoute(route, leaseId, {
              pageIdentifier: pageCursor(
                lease.uuid,
                "2026-08-11T00:00:00.000Z",
                null,
                otherPrefix,
              ),
            });

            expect(response.statusCode).toBe(400);
            expect(response.body).toContain(
              "pageIdentifier is not a valid pagination cursor.",
            );
          },
        );

        it.each([
          ["an empty", "2026-08-10T12:00:00.000Z"],
          ["an inverted", "2026-08-11T04:00:00.000Z"],
        ])("should return 400 for %s range", async (_kind, afterTimestamp) => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);

          const response = await getRoute(route, leaseId, {
            afterTimestamp,
            beforeTimestamp: "2026-08-10T12:00:00.000Z",
          });

          expect(response.statusCode).toBe(400);
          expect(response.body).toContain(
            "afterTimestamp must be earlier than beforeTimestamp.",
          );
          expect(mocks[read]).not.toHaveBeenCalled();
        });

        it("reads a one-millisecond range as a single instant", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);

          const response = await getRoute(route, leaseId, {
            afterTimestamp: "2026-08-10T16:00:00.000Z",
            beforeTimestamp: "2026-08-10T16:00:00.001Z",
          });

          expect(response.statusCode).toBe(200);
          expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
            pageSize: 100,
            window: {
              from: "2026-08-10T16:00:00.000Z",
              to: "2026-08-10T16:00:00.000Z",
            },
          });
        });

        // The lease started 2026-08-10T00:00Z.
        it.each([
          ["before", "2026-08-05T00:00:00.000Z", "2026-08-04T23:59:59.999Z"],
          ["at", "2026-08-10T00:00:00.000Z", "2026-08-09T23:59:59.999Z"],
        ])(
          "reads from the epoch for a lone beforeTimestamp %s the lease start",
          async (_position, beforeTimestamp, lastIncluded) => {
            const { leaseId } = monitoredLease();
            const mocks = mockCostHistory(observations);

            const response = await getRoute(route, leaseId, {
              beforeTimestamp,
            });

            expect(response.statusCode).toBe(200);
            expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
              pageSize: 100,
              window: { from: "1970-01-01T00:00:00.000Z", to: lastIncluded },
            });
          },
        );

        it("reads no earlier than a lone beforeTimestamp before the epoch", async () => {
          const { leaseId } = monitoredLease();
          const mocks = mockCostHistory(observations);
          const lastIncluded = "1969-05-31T23:59:59.999Z";

          const response = await getRoute(route, leaseId, {
            beforeTimestamp: "1969-06-01T00:00:00.000Z",
          });

          // The epoch floor as the lower bound would invert the window.
          expect(response.statusCode).toBe(200);
          expect(mocks[read]).toHaveBeenCalledWith(expect.any(String), {
            pageSize: 100,
            window: { from: lastIncluded, to: lastIncluded },
          });
        });

        it("should return 400 when maxResults exceeds the server-enforced maximum", async () => {
          const { leaseId } = monitoredLease();
          mockCostHistory(observations);

          const response = await getRoute(route, leaseId, {
            maxResults: "101",
          });

          expect(response.statusCode).toBe(400);
          expect(response.headers).toEqual(
            responseHeadersWithErrorType("ValidationError"),
          );
        });
      },
    );

    describe.each([
      [
        "costSummary",
        "Active user is not authorized to view the cost summary for this lease.",
      ],
      [
        "costHistory",
        "Active user is not authorized to view cost history for this lease.",
      ],
      [
        "bedrockTokenHistory",
        "Active user is not authorized to view Bedrock token history for this lease.",
      ],
      [
        "breachHistory",
        "Active user is not authorized to view breach history for this lease.",
      ],
    ] as const)(
      "GET /leases/{leaseId}/%s authorization",
      (route, forbiddenMessage) => {
        it("should return 200 when requesting somebody else's lease as 'Admin' or 'Manager'", async () => {
          const { leaseId } = monitoredLease({
            userEmail: `ANOTHER_${isbAuthorizedUser.user.email}`,
          });
          mockCostHistory(observations);

          expect((await getRoute(route, leaseId)).statusCode).toBe(200);
        });

        it("should return 200 when requesting your own lease as 'User'", async () => {
          // The 200 above is an Admin/Manager caller, so the owner path is only
          // exercised by a caller holding none of those roles.
          const { leaseId } = monitoredLease({
            userEmail: isbAuthorizedUserUserRoleOnly.user.email,
            desiredAssignments: undefined,
          });
          mockCostHistory(observations);

          const response = await getRoute(
            route,
            leaseId,
            {},
            isbAuthorizedUserUserRoleOnly.user,
          );

          expect(response.statusCode).toBe(200);
        });

        it("should return 200 when requesting a shared lease as 'User'", async () => {
          const { leaseId } = monitoredLease({
            userEmail: `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`,
            desiredAssignments: [
              {
                principalId: isbAuthorizedUserUserRoleOnly.user.userId,
                principalType: "USER",
                displayName: "Test User",
                email: isbAuthorizedUserUserRoleOnly.user.email,
              },
            ],
          });
          mockCostHistory(observations);

          expect(
            (
              await getRoute(
                route,
                leaseId,
                {},
                isbAuthorizedUserUserRoleOnly.user,
              )
            ).statusCode,
          ).toBe(200);
        });

        it("should return 403 when requesting somebody else's lease as 'User'", async () => {
          const { leaseId } = monitoredLease({
            userEmail: `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`,
            desiredAssignments: undefined,
          });
          mockCostHistory(observations);

          const response = await getRoute(
            route,
            leaseId,
            {},
            isbAuthorizedUserUserRoleOnly.user,
          );

          expect(response).toEqual({
            statusCode: 403,
            body: createFailureResponseBody({ message: forbiddenMessage }),
            headers: responseHeadersWithErrorType("AccessDeniedError"),
          });
        });

        it("should return 403 (not 404) for a non-existent lease when caller is a 'User'", async () => {
          // Existence oracle guard: a missing lease and an inaccessible one must not
          // be distinguishable by status code.
          const leaseId = base64EncodeCompositeKey(
            generateSchemaData(LeaseKeySchema),
          )!;
          vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
            result: undefined,
          });

          const response = await getRoute(
            route,
            leaseId,
            {},
            isbAuthorizedUserUserRoleOnly.user,
          );

          expect(response.statusCode).toBe(403);
        });

        it("should return 404 for a non-existent lease when caller is an 'Admin'", async () => {
          const leaseId = base64EncodeCompositeKey(
            generateSchemaData(LeaseKeySchema),
          )!;
          vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
            result: undefined,
          });

          expect(await getRoute(route, leaseId)).toEqual({
            statusCode: 404,
            body: createFailureResponseBody({ message: "Lease not found." }),
            headers: responseHeaders,
          });
        });
      },
    );
  });

  describe("GET /leases/shared", () => {
    const sharedUserId = randomUUID();
    const otherUserId = randomUUID();

    const sharedLease = generateSchemaData(PersistedLeaseSchema, {
      status: "Active",
    });

    function buildSharedEvent(
      queryStringParameters: Record<string, string>,
      user: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/shared",
        queryStringParameters,
        isbUser: user,
      });
    }

    // Literal-over-label routing precedence: the generated mux binds both
    // `/leases/shared` (ListSharedLeases) and `/leases/{leaseId}` (GetLease).
    // `preferLiteralRoutes` (in the handler) ensures `GET /leases/shared` reaches
    // ListSharedLeases rather than GetLease with `leaseId="shared"` — mirrors the
    // accounts `/accounts/unregistered` literal-routing test. Without it the
    // request would decode "shared" as a composite key and 400/404 via GetLease.
    it("routes GET /leases/shared to ListSharedLeases, not GetLease", async () => {
      const listSharedSpy = vi
        .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });
      const getLeaseSpy = vi.spyOn(DynamoLeaseStore.prototype, "get");

      const response = await handler(
        buildSharedEvent({ userId: sharedUserId, accessType: "direct" }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // Reached the shared-leases path (200 + the ListSharedLeases store call)...
      expect(response.statusCode).toBe(200);
      expect(listSharedSpy).toHaveBeenCalledOnce();
      // ...and never fell through to GetLease's single-lease fetch (which would
      // have tried to decode "shared" as a leaseId composite key).
      expect(getLeaseSpy).not.toHaveBeenCalled();
    });

    it("does not query the agent model catalog", async () => {
      const getAgentModelsSpy = vi.spyOn(
        DynamoConfigStore.prototype,
        "getAgentModels",
      );
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getDirectAssignmentsForUser",
      ).mockResolvedValue({ result: [], nextPageIdentifier: null });

      const response = await handler(
        buildSharedEvent({ userId: sharedUserId, accessType: "direct" }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(getAgentModelsSpy).not.toHaveBeenCalled();
    });

    describe("?accessType=direct", () => {
      it("maps public maxResults to internal pageSize", async () => {
        const pageIdentifier = base64EncodeCompositeKey({
          pk: `user#${sharedUserId}`,
          sk: leaseSk(sharedLease.uuid),
        })!;
        const getDirectAssignmentsSpy = vi
          .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
            pageIdentifier,
            maxResults: "7",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(getDirectAssignmentsSpy).toHaveBeenCalledWith({
          userId: sharedUserId,
          pageIdentifier,
          pageSize: 20,
        });
      });

      it("returns 400 for an invalid direct pagination token", async () => {
        const getDirectAssignmentsSpy = vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        );

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
            pageIdentifier: "not-a-pagination-token",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual(
          expect.objectContaining({
            data: {
              errors: [
                {
                  field: "pageIdentifier",
                  message: "The pagination token is invalid for this request.",
                },
              ],
            },
          }),
        );
        expect(getDirectAssignmentsSpy).not.toHaveBeenCalled();
      });

      it("returns 500 when direct shared-lease discovery fails unexpectedly", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockRejectedValueOnce(
          new Error("Unexpected assignment query failure"),
        );

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(500);
      });

      it("returns 200 with direct-tagged leases", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({
          result: [
            {
              pk: `user#${sharedUserId}`,
              sk: `lease#${sharedLease.uuid}`,
              userId: sharedUserId,
              principalType: "USER" as const,
              leaseId: sharedLease.uuid,
              assigneeEmail: "me@example.com",
              leaseOwnerEmail: sharedLease.userEmail,
              permissionSetArn: userPermissionSetArn,
              addedBy: "admin@example.com",
              addedDate: datetimeAsString(now()),
            },
          ],
          nextPageIdentifier: null,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "batchGet").mockResolvedValue([
          sharedLease,
        ]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data.result).toHaveLength(1);
        expect(body.data.result[0].uuid).toBe(sharedLease.uuid);
        expect(body.data.result[0].accessType).toBe("direct");
        // I19: assert exact base64-encoded leaseId, not just truthiness.
        expect(body.data.result[0].leaseId).toBe(
          base64EncodeCompositeKey({
            userEmail: sharedLease.userEmail,
            uuid: sharedLease.uuid,
          }),
        );
        // Accepted deviation: the restJson1 serializer drops null members, so an
        // absent nextPageIdentifier is undefined on the wire, not null.
        expect(body.data.nextPageIdentifier).toBeUndefined();
      });

      it("returns empty result when user has no direct assignments", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toEqual([]);
        // Accepted deviation: the restJson1 serializer drops null members, so an
        // absent nextPageIdentifier is undefined on the wire, not null.
        expect(body.data.nextPageIdentifier).toBeUndefined();
      });
    });

    describe("?accessType=group", () => {
      it("maps public maxResults to group pagination pageSize", async () => {
        const groupId = randomUUID();
        const secondSharedLease = generateSchemaData(PersistedLeaseSchema, {
          status: "Active",
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [groupId],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([
          {
            groupId,
            leaseId: sharedLease.uuid,
            sk: leaseSk(sharedLease.uuid),
          },
          {
            groupId,
            leaseId: secondSharedLease.uuid,
            sk: leaseSk(secondSharedLease.uuid),
          },
        ]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([
          {
            pk: `group#${groupId}`,
            sk: `lease#${sharedLease.uuid}`,
            leaseId: sharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: sharedLease.userEmail,
            permissionSetArn: userPermissionSetArn,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
          {
            pk: `group#${groupId}`,
            sk: `lease#${secondSharedLease.uuid}`,
            leaseId: secondSharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: secondSharedLease.userEmail,
            permissionSetArn: userPermissionSetArn,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
        ]);
        const batchGetSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "batchGet")
          .mockResolvedValue([sharedLease, secondSharedLease]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
            maxResults: "1",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(batchGetSpy).toHaveBeenCalledOnce();
        expect(batchGetSpy.mock.calls[0]![0]).toHaveLength(1);
        const body = JSON.parse(response.body);
        expect(body.data.result).toHaveLength(1);
        expect(body.data.nextPageIdentifier).toEqual(expect.any(String));
      });

      it("returns 200 with group-tagged leases", async () => {
        const groupId = randomUUID();
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [groupId],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([
          {
            groupId,
            leaseId: sharedLease.uuid,
            sk: leaseSk(sharedLease.uuid),
          },
        ]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([
          {
            pk: `group#${groupId}`,
            sk: `lease#${sharedLease.uuid}`,
            leaseId: sharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: sharedLease.userEmail,
            permissionSetArn: userPermissionSetArn,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
        ]);
        vi.spyOn(DynamoLeaseStore.prototype, "batchGet").mockResolvedValue([
          sharedLease,
        ]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toHaveLength(1);
        expect(body.data.result[0].uuid).toBe(sharedLease.uuid);
        expect(body.data.result[0].accessType).toBe("group");
        expect(body.data.result[0].sourceGroupName).toBe("Engineers");
      });

      it("returns empty result when user belongs to no groups", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toEqual([]);
      });
    });

    describe("pagination defaults", () => {
      it("defaults pageSize to 100 for direct access when maxResults is omitted", async () => {
        // The operation passes `maxResults ?? 100`. The service's OWN default is 50,
        // so observing a downstream pageSize of 100 proves the OPERATION applied the
        // 100 default (not the service's 50) — the pre-Smithy `/leases/shared` cap.
        const getDirectAssignmentsSpy = vi
          .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({ userId: sharedUserId, accessType: "direct" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(getDirectAssignmentsSpy).toHaveBeenCalledWith({
          userId: sharedUserId,
          pageIdentifier: undefined,
          pageSize: 100,
        });
      });

      it("defaults pageSize to 100 for group access when maxResults is omitted", async () => {
        // Group access slices in memory (no store pageSize arg), so assert the
        // service call args directly: the operation must pass pageSize 100.
        const viaGroupsSpy = vi
          .spyOn(leaseAssignment, "getLeasesForUserViaGroups")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({ userId: sharedUserId, accessType: "group" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(viaGroupsSpy.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ pageSize: 100 }),
        );
      });
    });

    describe("validation and authorization", () => {
      // C6: positive-path test for the only narrow auth branch — User role
      // querying their own userId must be allowed.
      it("allows a User-role IDC user to query their own shared leases", async () => {
        const ownUserId = randomUUID();
        const ownUser: IsbUser = {
          type: "user",
          email: "own.user@example.com",
          userId: ownUserId,
          roles: ["User"],
        };
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent(
            { userId: ownUserId, accessType: "direct" },
            ownUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 403 when a non-elevated user queries another user's shared leases", async () => {
        const response = await handler(
          buildSharedEvent(
            {
              userId: otherUserId,
              accessType: "direct",
            },
            isbAuthorizedUserUserRoleOnly.user,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("allows Admin/Manager to query shared leases for another user", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

        const response = await handler(
          buildSharedEvent({
            userId: otherUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      // C7: M2M without elevated roles must be rejected. M2M users have
      // `clientId` (not `userId`), so the predicate must short-circuit on
      // `isM2MUser` before reading `context.user.userId`.
      it("returns 403 for an M2M caller without Admin/Manager role", async () => {
        const response = await handler(
          buildSharedEvent(
            { userId: sharedUserId, accessType: "direct" },
            m2mUserRoleOnlyUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("allows an M2M caller with Admin role", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent(
            { userId: sharedUserId, accessType: "direct" },
            m2mAdminUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 400 when userId query param is missing", async () => {
        const response = await handler(
          buildSharedEvent({ accessType: "direct" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      // I9: userId is now constrained to UUID — non-UUID values are rejected.
      it("returns 400 when userId query param is not a UUID", async () => {
        const response = await handler(
          buildSharedEvent({
            userId: "not-a-uuid",
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 when accessType query param is missing", async () => {
        const response = await handler(
          buildSharedEvent({ userId: sharedUserId }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 when accessType is not direct or group", async () => {
        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "BOTH",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });
    });
  });
});

describe("PATCH /leases/{leaseId} Sandbox Spaces", () => {
  const ENABLED_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const OTHER_ENABLED_MODEL = "amazon.nova-pro-v1:0";
  const DISABLED_MODEL = "anthropic.claude-3-haiku";

  function catalog(): PersistedAgentModelCatalogRow[] {
    // Only modelId/enabled are read by the gate.
    return [
      { modelId: ENABLED_MODEL, enabled: true },
      { modelId: OTHER_ENABLED_MODEL, enabled: true },
      { modelId: DISABLED_MODEL, enabled: false },
    ] as unknown as PersistedAgentModelCatalogRow[];
  }

  function setup(
    leaseOverrides: Record<string, unknown> = {},
    globalSandboxSpacesEnabled = true,
  ) {
    const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
    const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
    const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      ...leaseCompositeKey,
      status: "Active",
      leaseDurationInHours: 48,
      costReportGroup: undefined,
      startDate: new Date().toISOString(),
      budgetThresholds: undefined,
      durationThresholds: undefined,
      // Within the mock global max (50), so global-config validation passes.
      maxSpend: 20,
      sandboxSpacesEnabled: true,
      allowedModelIds: undefined,
      defaultModelId: undefined,
      ...leaseOverrides,
    });
    vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
      result: oldLease,
    });
    const updateSpy = vi
      .spyOn(DynamoLeaseStore.prototype, "update")
      .mockImplementation(async (lease) => ({
        newItem: lease,
        oldItem: oldLease,
      }));
    const getAgentModels = vi
      .spyOn(DynamoConfigStore.prototype, "getAgentModels")
      .mockResolvedValue(catalog());
    mockedGlobalConfig.agent.sandboxSpacesEnabled = globalSandboxSpacesEnabled;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const patch = (body: Record<string, unknown>) =>
      handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

    return { patch, updateSpy, getAgentModels, oldLease };
  }

  it("leaves Sandbox Spaces untouched when a PATCH omits it", async () => {
    // Regression: the persisted schema defaults sandboxSpacesEnabled to false, so a
    // PATCH schema that kept the default would switch it off on every edit.
    const { patch, updateSpy, getAgentModels, oldLease } = setup();

    const response = await patch({ allowOwnerToShareLease: false });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxSpacesEnabled: true }),
      oldLease,
    );
    // Unrelated edits do not read the catalog.
    expect(getAgentModels).not.toHaveBeenCalled();
  });

  it("enables Sandbox Spaces with a subset and default from the enabled catalog", async () => {
    // Monitoring is already on, so the PATCH need not send it.
    const { patch, updateSpy, oldLease } = setup({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: true,
    });

    const response = await patch({
      sandboxSpacesEnabled: true,
      allowedModelIds: [ENABLED_MODEL, OTHER_ENABLED_MODEL],
      defaultModelId: OTHER_ENABLED_MODEL,
    });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSpacesEnabled: true,
        allowedModelIds: [ENABLED_MODEL, OTHER_ENABLED_MODEL],
        defaultModelId: OTHER_ENABLED_MODEL,
      }),
      oldLease,
    );
  });

  it("rejects enabling Sandbox Spaces without Bedrock token monitoring", async () => {
    // Token polling selects leases by their monitoring value, so Sandbox
    // Spaces inference on this lease would go unmonitored.
    const { patch, updateSpy } = setup({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: false,
    });

    const response = await patch({ sandboxSpacesEnabled: true });

    expect(response.statusCode).toBe(400);
    expect(response.headers?.["x-amzn-errortype"]).toBe("ValidationError");
    expect(JSON.parse(response.body).data.errors[0]).toEqual({
      field: "sandboxSpacesEnabled",
      message:
        "Sandbox Spaces requires Bedrock token monitoring. Set bedrockTokenMonitoringEnabled to true to enable Sandbox Spaces.",
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("enables Sandbox Spaces with Bedrock token monitoring on a lease created without it, while the monitoring setting is off", async () => {
    const { patch, updateSpy, oldLease } = setup({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: false,
    });
    mockedGlobalConfig.leases.allowBedrockTokenMonitoring = false;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const response = await patch({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
      }),
      oldLease,
    );
  });

  it("rejects re-sending true on a lease whose monitoring is off", async () => {
    // The edit form always re-sends the current sandboxSpacesEnabled value, so
    // a lease whose Sandbox Spaces and monitoring disagree must send monitoring
    // on to save.
    const { patch, updateSpy } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: false,
    });

    const response = await patch({
      sandboxSpacesEnabled: true,
      allowedModelIds: [ENABLED_MODEL],
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "Sandbox Spaces requires Bedrock token monitoring.",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects turning monitoring off while Sandbox Spaces stays enabled", async () => {
    const { patch, updateSpy } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });

    const response = await patch({ bedrockTokenMonitoringEnabled: false });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "Sandbox Spaces requires Bedrock token monitoring.",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("disables Sandbox Spaces and monitoring together", async () => {
    const { patch, updateSpy, oldLease } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });
    mockedGlobalConfig.leases.allowBedrockTokenMonitoring = false;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const response = await patch({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: false,
    });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      }),
      oldLease,
    );
  });

  it("disables Sandbox Spaces on a lease using it while Sandbox Spaces is off globally", async () => {
    const { patch, updateSpy, oldLease } = setup(
      { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
      false,
    );

    const response = await patch({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: true,
    });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: true,
      }),
      oldLease,
    );
  });

  it("rejects turning Sandbox Spaces on while it is off globally", async () => {
    const { patch, updateSpy } = setup(
      { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: true },
      false,
    );

    const response = await patch({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects keeping monitoring on when Sandbox Spaces is turned off while the monitoring setting is off", async () => {
    // Sandbox Spaces may have been the only reason monitoring was allowed.
    const { patch, updateSpy } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });
    mockedGlobalConfig.leases.allowBedrockTokenMonitoring = false;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const response = await patch({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "Cannot enable bedrockTokenMonitoringEnabled because Bedrock token monitoring is not available.",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("allows disabling Sandbox Spaces on a lease created without token monitoring", async () => {
    // Recovery path for a lease whose Sandbox Spaces and monitoring disagree.
    const { patch, updateSpy, oldLease } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: false,
    });

    const response = await patch({ sandboxSpacesEnabled: false });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      }),
      oldLease,
    );
  });

  it("rejects a subset with a model not enabled in the catalog, without echoing the id", async () => {
    const { patch, updateSpy } = setup();

    const response = await patch({ allowedModelIds: [DISABLED_MODEL] });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "One or more selected models are not enabled in the model catalog.",
    );
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects a default outside the lease's subset, checked against the merged lease", async () => {
    // The PATCH only sets the default; the subset comes from the stored lease.
    const { patch, updateSpy } = setup({ allowedModelIds: [ENABLED_MODEL] });

    const response = await patch({ defaultModelId: OTHER_ENABLED_MODEL });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).data.errors[0]).toEqual({
      field: "defaultModelId",
      message: "Default model must be one of the selected models.",
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects an unchanged default that has since been disabled", async () => {
    const { patch, updateSpy } = setup({
      allowedModelIds: [DISABLED_MODEL, ENABLED_MODEL],
      defaultModelId: DISABLED_MODEL,
    });

    const response = await patch({ defaultModelId: DISABLED_MODEL });

    expect(response.statusCode).toBe(400);
    expect(response.headers?.["x-amzn-errortype"]).toBe("ValidationError");
    expect(JSON.parse(response.body).data.errors[0].field).toBe(
      "defaultModelId",
    );
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("accepts a disabled default while Sandbox Spaces is off globally", async () => {
    const { patch, updateSpy, getAgentModels, oldLease } = setup(
      { defaultModelId: DISABLED_MODEL },
      false,
    );

    const response = await patch({ defaultModelId: DISABLED_MODEL });

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModelId: DISABLED_MODEL }),
      oldLease,
    );
    expect(getAgentModels).not.toHaveBeenCalled();
  });

  it("clears the subset and default with an explicit null", async () => {
    const { patch, updateSpy } = setup({
      allowedModelIds: [ENABLED_MODEL],
      defaultModelId: ENABLED_MODEL,
    });

    const response = await patch({
      allowedModelIds: null,
      defaultModelId: null,
    });

    expect(response.statusCode).toBe(200);
    const stored = updateSpy.mock.calls[0]![0];
    expect(stored.allowedModelIds).toBeUndefined();
    expect(stored.defaultModelId).toBeUndefined();
  });
});

describe("POST /leases Sandbox Spaces template models", () => {
  const ENABLED_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const DISABLED_MODEL = "anthropic.claude-3-haiku";

  function catalog(): PersistedAgentModelCatalogRow[] {
    return [
      { modelId: ENABLED_MODEL, enabled: true },
      { modelId: DISABLED_MODEL, enabled: false },
    ] as unknown as PersistedAgentModelCatalogRow[];
  }

  function setup(
    templateOverrides: Record<string, unknown>,
    globalSandboxSpacesEnabled = true,
  ) {
    const leaseTemplateUuid = randomUUID();
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
      result: generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: leaseTemplateUuid,
        sandboxSpacesEnabled: true,
        allowedModelIds: undefined,
        defaultModelId: undefined,
        defaultPermissionSetArn: undefined,
        allowedPermissionSetArns: undefined,
        ...templateOverrides,
      }),
    });
    vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });
    const getAgentModels = vi
      .spyOn(DynamoConfigStore.prototype, "getAgentModels")
      .mockResolvedValue(catalog());
    const requestLeaseSpy = vi
      .spyOn(InnovationSandbox, "requestLease")
      .mockResolvedValue(
        generateSchemaData(PersistedPendingLeaseSchema, {
          originalLeaseTemplateUuid: leaseTemplateUuid,
        }),
      );
    mockedGlobalConfig.agent.sandboxSpacesEnabled = globalSandboxSpacesEnabled;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const request = () =>
      handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

    return { request, requestLeaseSpy, getAgentModels };
  }

  it("rejects a request when the template's default model is disabled", async () => {
    const { request, requestLeaseSpy } = setup({
      defaultModelId: DISABLED_MODEL,
    });

    const response = await request();

    expect(response.statusCode).toBe(400);
    expect(response.headers?.["x-amzn-errortype"]).toBe("ValidationError");
    expect(JSON.parse(response.body).data.errors[0]).toEqual({
      field: "defaultModelId",
      message:
        "This template's default model is no longer available. Contact an administrator to update the template.",
    });
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(requestLeaseSpy).not.toHaveBeenCalled();
  });

  it("allows a template whose subset still carries a disabled model", async () => {
    const { request, requestLeaseSpy } = setup({
      allowedModelIds: [ENABLED_MODEL, DISABLED_MODEL],
      defaultModelId: ENABLED_MODEL,
    });

    const response = await request();

    expect(response.statusCode).toBe(201);
    expect(requestLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it("does not check the default while Sandbox Spaces is off globally", async () => {
    const { request, requestLeaseSpy, getAgentModels } = setup(
      { defaultModelId: DISABLED_MODEL },
      false,
    );

    const response = await request();

    expect(response.statusCode).toBe(201);
    expect(requestLeaseSpy).toHaveBeenCalledTimes(1);
    expect(getAgentModels).not.toHaveBeenCalled();
  });

  it("does not check the default when the template itself has Sandbox Spaces off", async () => {
    const { request, requestLeaseSpy, getAgentModels } = setup({
      sandboxSpacesEnabled: false,
      defaultModelId: DISABLED_MODEL,
    });

    const response = await request();

    expect(response.statusCode).toBe(201);
    expect(requestLeaseSpy).toHaveBeenCalledTimes(1);
    expect(getAgentModels).not.toHaveBeenCalled();
  });
});

describe("PATCH /leases/{leaseId} predictive budget controls and Bedrock token monitoring", () => {
  const rateLimits = [{ basis: "HOURLY", rate: 10, action: "ALERT" }] as const;
  const predictedFreeze = {
    dollarsSpent: 15,
    action: "FREEZE_ACCOUNT",
    triggerOn: "PREDICTED",
  } as const;

  function setup(
    leaseOverrides: Partial<PersistedMonitoredLease> = {},
    gates: {
      allowPredictiveBudgetControls?: boolean;
      allowBedrockTokenMonitoring?: boolean;
    } = {},
  ) {
    const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
    const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
    const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      ...leaseCompositeKey,
      status: "Active",
      leaseDurationInHours: 48,
      costReportGroup: undefined,
      startDate: now().toISO(),
      budgetThresholds: undefined,
      durationThresholds: undefined,
      maxSpend: 20,
      resourceLock: undefined,
      predictiveBudgetEnabled: false,
      rateLimits: undefined,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: false,
      ...leaseOverrides,
    });
    vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
      result: oldLease,
    });
    const updateSpy = vi
      .spyOn(DynamoLeaseStore.prototype, "update")
      .mockImplementation(async (lease) => ({
        newItem: lease,
        oldItem: oldLease,
      }));
    Object.assign(mockedGlobalConfig.leases, gates);
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

    const patch = async (body: Record<string, unknown>) => {
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      return {
        response,
        persisted: updateSpy.mock.calls[0]?.[0] as
          PersistedMonitoredLease | undefined,
      };
    };
    return { patch, updateSpy };
  }

  it.each<{
    name: string;
    lease: Partial<PersistedMonitoredLease>;
    gates: Parameters<typeof setup>[1];
    body: Record<string, unknown>;
  }>([
    {
      name: "turns predictive budget controls on while they are allowed",
      lease: {},
      gates: { allowPredictiveBudgetControls: true },
      body: { predictiveBudgetEnabled: true, rateLimits },
    },
    {
      name: "turns predictive budget controls off while they are not allowed",
      lease: { predictiveBudgetEnabled: true },
      gates: { allowPredictiveBudgetControls: false },
      body: { predictiveBudgetEnabled: false },
    },
    {
      name: "keeps predictive budget controls on while they are not allowed",
      lease: { predictiveBudgetEnabled: true },
      gates: { allowPredictiveBudgetControls: false },
      body: { predictiveBudgetEnabled: true },
    },
    {
      name: "turns Bedrock token monitoring on while it is allowed",
      lease: {},
      gates: { allowBedrockTokenMonitoring: true },
      body: { bedrockTokenMonitoringEnabled: true },
    },
    {
      name: "turns Bedrock token monitoring off while it is not allowed",
      lease: { bedrockTokenMonitoringEnabled: true },
      gates: { allowBedrockTokenMonitoring: false },
      body: { bedrockTokenMonitoringEnabled: false },
    },
    {
      name: "turns Bedrock token monitoring on while it is not allowed but the lease uses Sandbox Spaces",
      lease: { sandboxSpacesEnabled: true },
      gates: { allowBedrockTokenMonitoring: false },
      body: { bedrockTokenMonitoringEnabled: true },
    },
  ])("$name", async ({ lease, gates, body }) => {
    const { patch } = setup(lease, gates);

    const { response, persisted } = await patch(body);

    expect(response.statusCode).toBe(200);
    expect(persisted).toEqual(expect.objectContaining(body));
  });

  it.each([
    {
      field: "predictiveBudgetEnabled",
      gates: { allowPredictiveBudgetControls: false },
      message:
        "Cannot enable predictiveBudgetEnabled because predictive budget controls is not available.",
    },
    {
      field: "bedrockTokenMonitoringEnabled",
      gates: { allowBedrockTokenMonitoring: false },
      message:
        "Cannot enable bedrockTokenMonitoringEnabled because Bedrock token monitoring is not available.",
    },
  ])(
    "rejects turning $field on while it is not allowed",
    async ({ field, gates, message }) => {
      const { patch, updateSpy } = setup({}, gates);

      const { response } = await patch({ [field]: true });

      expect(response).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({ message }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(updateSpy).not.toHaveBeenCalled();
    },
  );

  describe("turning predictive budget controls off", () => {
    const predictiveLease = {
      predictiveBudgetEnabled: true,
      rateLimits: [...rateLimits],
      budgetThresholds: [predictedFreeze],
    };

    it("clears the stored rate limits and keeps the thresholds as REPORTED ones", async () => {
      const { patch } = setup(predictiveLease);

      const { response, persisted } = await patch({
        predictiveBudgetEnabled: false,
        budgetThresholds: [{ dollarsSpent: 15, action: "FREEZE_ACCOUNT" }],
      });

      expect(response.statusCode).toBe(200);
      expect(persisted?.predictiveBudgetEnabled).toBe(false);
      expect(persisted?.rateLimits).toBeUndefined();
      expect(persisted?.budgetThresholds).toEqual([
        { dollarsSpent: 15, action: "FREEZE_ACCOUNT" },
      ]);
    });

    it.each([
      [
        "still sends a PREDICTED threshold",
        { budgetThresholds: [predictedFreeze] },
        "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.",
      ],
      [
        "leaves a stored PREDICTED threshold in place",
        {},
        "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.",
      ],
      [
        "still sends rate limits",
        { budgetThresholds: [], rateLimits },
        "rateLimits requires a lease with predictive budget controls enabled.",
      ],
    ])("rejects a PATCH that %s", async (_label, extra, message) => {
      const { patch, updateSpy } = setup(predictiveLease);

      const { response } = await patch({
        predictiveBudgetEnabled: false,
        ...extra,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(message);
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  it("keeps the stored rate limits when predictive budget controls are sent as on again", async () => {
    const { patch } = setup({
      predictiveBudgetEnabled: true,
      rateLimits: [...rateLimits],
    });

    const { response, persisted } = await patch({
      predictiveBudgetEnabled: true,
    });

    expect(response.statusCode).toBe(200);
    expect(persisted?.rateLimits).toEqual([...rateLimits]);
  });

  it("does not check the Sandbox Spaces pairing on an edit that sends neither field", async () => {
    const { patch } = setup({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: false,
    });

    const { response, persisted } = await patch({ maxSpend: 25 });

    expect(response.statusCode).toBe(200);
    expect(persisted).toEqual(
      expect.objectContaining({
        maxSpend: 25,
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: false,
      }),
    );
  });

  it("accepts rate limits and a PREDICTED threshold with predictive budget controls turned on in the same PATCH", async () => {
    const { patch } = setup();

    const { response, persisted } = await patch({
      predictiveBudgetEnabled: true,
      rateLimits,
      budgetThresholds: [predictedFreeze],
    });

    expect(response.statusCode).toBe(200);
    expect(persisted).toEqual(
      expect.objectContaining({
        predictiveBudgetEnabled: true,
        rateLimits: [...rateLimits],
        budgetThresholds: [predictedFreeze],
      }),
    );
  });
});
