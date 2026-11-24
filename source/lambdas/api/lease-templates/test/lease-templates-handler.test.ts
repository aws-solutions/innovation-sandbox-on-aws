// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
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

import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import {
  ConcurrentDataModificationException,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { SsmIdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  PersistedLeaseTemplate,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { PersistedPermissionSetCacheItemSchema } from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  serializedBodyLike as baseSerializedBodyLike,
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  jsendFailBodyLike,
  mockAuthorizedContext,
  mockGlobalConfig,
  responseHeaders,
  responseHeadersWithErrorType,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { permissionSetIdFromArn } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import { randomUUID } from "crypto";

const mockUuid = "00000000-0000-0000-0000-000000000000";
// Owned by the shared validatePredictiveBudgetFields, not the handler.
const PREDICTED_REQUIRES_PREDICTIVE_MESSAGE =
  "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.";
// Owned by the shared validateBudgetThresholdsBelowMaxSpend, not the handler.
const THRESHOLD_AT_MAX_SPEND_MESSAGE =
  "Every budget threshold dollarsSpent must be less than maxSpend (50).";
const userPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-user123456789012";
const adminPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-admin12345678901";
const managerPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-manager123456789";
const customPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-custom1234567890";
const missingPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-missing123456789";

function permissionSetCacheItem(permissionSetArn: string, name: string) {
  const permissionSetId = permissionSetIdFromArn(permissionSetArn)!;
  return generateSchemaData(PersistedPermissionSetCacheItemSchema, {
    pk: "permissionSetCache",
    sk: `ps#${permissionSetId}`,
    permissionSetArn,
    permissionSetId,
    name,
    description: `${name} description`,
    sessionDuration: "PT1H",
  });
}

function generateLeaseTemplateData<T extends z.ZodTypeAny>(
  schema: T,
  overrides?: Partial<z.infer<T>>,
): z.infer<T> {
  const data = generateSchemaData(schema, {
    defaultPermissionSetArn: undefined,
    allowedPermissionSetArns: undefined,
    allowedModelIds: undefined,
    defaultModelId: undefined,
    // Random rows would trip the predictive-controls gate on rateLimits.
    rateLimits: undefined,
    // Random Sandbox Spaces would trip its token-monitoring requirement.
    sandboxSpacesEnabled: false,
    ...overrides,
  } as unknown as Partial<z.infer<T>>);
  // Random thresholds would likewise trip the gate on PREDICTED triggers and
  // the rule that each is below maxSpend.
  const generated = data as {
    maxSpend?: number;
    budgetThresholds?: { dollarsSpent: number; triggerOn?: string }[];
  };
  const sent = overrides as { budgetThresholds?: unknown } | undefined;
  if (sent?.budgetThresholds === undefined && generated.budgetThresholds) {
    const maxSpend = generated.maxSpend;
    generated.budgetThresholds = generated.budgetThresholds
      .filter(
        (threshold) =>
          maxSpend === undefined || threshold.dollarsSpent < maxSpend,
      )
      .map((threshold) =>
        threshold.triggerOn === "PREDICTED"
          ? { ...threshold, triggerOn: "REPORTED" }
          : threshold,
      );
  }
  return data;
}
function rateLimitedTemplateBody(overrides: Record<string, unknown>) {
  return generateLeaseTemplateData(
    PersistedLeaseTemplateSchema.omit({
      uuid: true,
      createdBy: true,
      blueprintName: true,
      meta: true,
      allowedModelIds: true,
      defaultModelId: true,
    }),
    {
      predictiveBudgetEnabled: true,
      bedrockTokenMonitoringEnabled: false,
      budgetThresholds: [],
      maxSpend: 50,
      leaseDurationInHours: 24,
      costReportGroup: undefined,
      blueprintId: undefined,
      allowOwnerToShareLease: false,
      ...overrides,
    },
  );
}

function expectedPermissionSetReference(permissionSetArn: string) {
  const permissionSetId = permissionSetIdFromArn(permissionSetArn);
  if (permissionSetArn === userPermissionSetArn) {
    return {
      permissionSetArn,
      permissionSetId,
      name: "BuiltInUser",
      description: "BuiltInUser description",
      sessionDuration: "PT1H",
      availability: "AVAILABLE",
    };
  }
  return {
    permissionSetArn,
    permissionSetId,
    availability: "UNAVAILABLE",
  };
}

function addExpectedPermissionSets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(addExpectedPermissionSets);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const object = Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      addExpectedPermissionSets(member),
    ]),
  );
  if (
    typeof object.uuid === "string" &&
    typeof object.createdBy === "string" &&
    typeof object.requiresApproval === "boolean"
  ) {
    const defaultPermissionSetArn =
      typeof object.defaultPermissionSetArn === "string"
        ? object.defaultPermissionSetArn
        : userPermissionSetArn;
    const allowedPermissionSetArns = Array.isArray(
      object.allowedPermissionSetArns,
    )
      ? object.allowedPermissionSetArns.filter(
          (arn): arn is string => typeof arn === "string",
        )
      : [];
    const effectiveAllowedArns = [
      ...new Set([defaultPermissionSetArn, ...allowedPermissionSetArns]),
    ];
    object.defaultPermissionSet = expectedPermissionSetReference(
      defaultPermissionSetArn,
    );
    object.allowedPermissionSets = effectiveAllowedArns.map(
      expectedPermissionSetReference,
    );
  }
  return object;
}

function serializedBodyLike(body: unknown) {
  return baseSerializedBodyLike(addExpectedPermissionSets(body));
}
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue(mockUuid),
}));

const testEnv = generateSchemaData(LeaseTemplateLambdaEnvironmentSchema);
const mockedGlobalConfig = mockGlobalConfig();
mockedGlobalConfig.leases.maxBudget = 100;
mockedGlobalConfig.leases.maxDurationHours = 100;
mockedGlobalConfig.leases.leaseSharingEnabled = true;
const mockedReportingConfig = {
  costReportGroups: [],
  requireCostReportGroup: false,
};
const testReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: false,
};
const testReportingConfigRequired = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: true,
};

let handler: typeof import("@amzn/innovation-sandbox-lease-templates/lease-templates-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-lease-templates/lease-templates-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
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
  ).mockResolvedValue([
    permissionSetCacheItem(userPermissionSetArn, "BuiltInUser"),
  ]);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/leasesTemplates",
      headers: {
        "Content-Type": "application/json",
      },
      isbUser: isbAuthorizedUser.user,
    });
    expect(
      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: expect.objectContaining(
        responseHeadersWithErrorType("InternalServerError"),
      ),
    });
  });

  describe("GET /leaseTemplates", () => {
    it("should return 200 response with all lease templates", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
      ];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 200 without leaking the validation error to the caller", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
      ];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
        error: "Some validation error",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with first page of lease template when pagination query parameters are passed in", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
      ];

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockReturnValue(
          Promise.resolve({
            result: leaseTemplates,
            nextPageIdentifier: null,
          }),
        );

      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod.mock.calls).toHaveLength(1);
      expect(findAllVisibleMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier: pageIdentifier,
          pageSize: Number(maxResults),
          includePrivate: true,
        },
      ]);
    });
    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
      ];

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockReturnValue(
          Promise.resolve({
            result: leaseTemplates,
            nextPageIdentifier: null,
          }),
        );

      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
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
        // `maxResults` is a model-validated Integer, so a non-numeric value is
        // rejected by generated deserialization with the generic restJson1
        // "invalid JSON body" message rather than the pre-Smithy per-field Zod
        // error — an accepted deviation of the Smithy migration.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
      expect(findAllVisibleMethod.mock.calls).toHaveLength(0);
    });
    it("rejects a repeated query key rather than taking the last value", async () => {
      // API Gateway's single-value map holds the last value, but `convertEvent`
      // reads the multi-value map, and a single-valued model query member is
      // rejected as a multi-element array by generated deserialization — a
      // restJson1 400 rather than the pre-Smithy last-wins 200. Accepted deviation.
      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leaseTemplates",
          // API Gateway: single-value map holds the last value; multi-value map
          // holds every value for a repeated key.
          queryStringParameters: { maxResults: "2" },
          multiValueQueryStringParameters: { maxResults: ["1", "2"] },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(findAllVisibleMethod.mock.calls).toHaveLength(0);
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockImplementation(() => {
        throw new Error();
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should return 200 with all templates (PUBLIC and PRIVATE) for Admin/Manager users", async () => {
      const publicTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PUBLIC",
        },
      );
      const privateTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PRIVATE",
        },
      );
      const leaseTemplates = [publicTemplate, privateTemplate];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should request only visible templates (includePrivate false) for User-only role", async () => {
      // Visibility filtering now happens in the store (findAllVisible), so the
      // handler must ask for the non-privileged view. The store's own tests
      // verify PRIVATE templates never appear in the result or the token.
      const publicTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PUBLIC",
        },
      );

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({
          result: [publicTemplate],
          nextPageIdentifier: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      // Create context with User-only role
      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: [publicTemplate],
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod).toHaveBeenCalledWith(
        expect.objectContaining({ includePrivate: false }),
      );
    });

    it("should request all templates (includePrivate true) for Admin/Manager role", async () => {
      const publicTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PUBLIC",
        },
      );
      const privateTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PRIVATE",
        },
      );

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({
          result: [publicTemplate, privateTemplate],
          nextPageIdentifier: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: [publicTemplate, privateTemplate],
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod).toHaveBeenCalledWith(
        expect.objectContaining({ includePrivate: true }),
      );
    });

    it("should return exactly the JSend success envelope keys", async () => {
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: [generateLeaseTemplateData(PersistedLeaseTemplateSchema)],
        // Non-null so the member survives serialization; the null case is the
        // next test.
        nextPageIdentifier: "next-token",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      const parsed = JSON.parse(response.body);
      expect(Object.keys(parsed).sort()).toEqual(["data", "status"]);
      // data carries the page wrapper, unlike POST which returns the entity.
      expect(Object.keys(parsed.data).sort()).toEqual([
        "nextPageIdentifier",
        "result",
      ]);
    });

    it("omits nextPageIdentifier on the last page rather than returning null", async () => {
      // The generated serializer drops null members. The pre-Smithy API returned
      // `nextPageIdentifier: null`; the frontend adapter canonicalizes absent and
      // null to the same value, so dropping it is an accepted deviation.
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      const { data } = JSON.parse(response.body);
      expect(data).not.toHaveProperty("nextPageIdentifier");
      expect(data.result).toEqual([]);
    });

    it("batch-hydrates available and unavailable permission sets without exposing raw ARNs", async () => {
      const templates = [
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [
            customPermissionSetArn,
            missingPermissionSetArn,
          ],
        }),
        generateLeaseTemplateData(PersistedLeaseTemplateSchema),
      ];
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: templates,
        nextPageIdentifier: null,
      });
      const cacheRead = vi
        .spyOn(DynamoPrincipalStore.prototype, "getPermissionSetCacheItems")
        .mockResolvedValue([
          permissionSetCacheItem(userPermissionSetArn, "BuiltInUser"),
          permissionSetCacheItem(customPermissionSetArn, "Custom"),
        ]);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leaseTemplates",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const [customTemplate, legacyTemplate] = JSON.parse(response.body).data
        .result;
      expect(customTemplate).not.toHaveProperty("defaultPermissionSetArn");
      expect(customTemplate).not.toHaveProperty("allowedPermissionSetArns");
      expect(customTemplate.defaultPermissionSet).toEqual(
        expect.objectContaining({
          permissionSetArn: customPermissionSetArn,
          name: "Custom",
          availability: "AVAILABLE",
        }),
      );
      expect(customTemplate.allowedPermissionSets).toEqual([
        customTemplate.defaultPermissionSet,
        {
          permissionSetArn: missingPermissionSetArn,
          permissionSetId: permissionSetIdFromArn(missingPermissionSetArn),
          availability: "UNAVAILABLE",
        },
      ]);
      expect(legacyTemplate.allowedPermissionSets).toEqual([
        legacyTemplate.defaultPermissionSet,
      ]);
      expect(cacheRead).toHaveBeenCalledExactlyOnceWith({});
    });
  });

  describe("POST /leaseTemplates", () => {
    it("persists an eager default and returns generated hydrated references", async () => {
      const request = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const create = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockImplementation(async (item) => item);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(request),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).toHaveBeenCalledExactlyOnceWith({ consistentRead: true });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPermissionSetArn: userPermissionSetArn,
          allowedPermissionSetArns: undefined,
        }),
      );
      const data = JSON.parse(response.body).data;
      expect(data).not.toHaveProperty("defaultPermissionSetArn");
      expect(data.defaultPermissionSet).toEqual(
        expect.objectContaining({
          permissionSetArn: userPermissionSetArn,
          availability: "AVAILABLE",
        }),
      );
      expect(data.allowedPermissionSets).toEqual([data.defaultPermissionSet]);
    });

    it.each([
      {
        name: "system role",
        defaultPermissionSetArn: adminPermissionSetArn,
        message: `Permission set ${adminPermissionSetArn} is a system role and cannot be assigned to lease users.`,
      },
      {
        name: "uncached permission set",
        defaultPermissionSetArn: missingPermissionSetArn,
        message: `Permission set ${missingPermissionSetArn} is not registered in this deployment's catalog.`,
      },
    ])(
      "rejects a $name through the generated request path",
      async ({ defaultPermissionSetArn, message }) => {
        const request = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            defaultPermissionSetArn,
          },
        );

        const response = await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leaseTemplates",
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(request),
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({ message }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it("should return 201 response when leaseTemplate is created successfully", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const uuid = randomUUID();

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: {
            ...leaseTemplate,
            uuid,
            createdBy: isbAuthorizedUser.user.email,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 201 echoing rateLimits and both opt-ins when the gates are open", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          rateLimits: [
            { basis: "HOURLY", rate: 2.5, action: "ALERT" },
            { basis: "DAILY", rate: 40, action: "FREEZE_ACCOUNT" },
          ],
          predictiveBudgetEnabled: true,
          bedrockTokenMonitoringEnabled: true,
          budgetThresholds: [
            { dollarsSpent: 25, action: "ALERT", triggerOn: "PREDICTED" },
          ],
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: false,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const uuid = randomUUID();

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({
          ...leaseTemplate,
          uuid,
          createdBy: isbAuthorizedUser.user.email,
        });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(201);
      expect(response.body).toEqual(
        serializedBodyLike({
          status: "success",
          data: {
            ...leaseTemplate,
            uuid,
            createdBy: isbAuthorizedUser.user.email,
          },
        }),
      );
      expect(response.headers).toEqual(
        expect.objectContaining(responseHeaders),
      );
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimits: [
            { basis: "HOURLY", rate: 2.5, action: "ALERT" },
            { basis: "DAILY", rate: 40, action: "FREEZE_ACCOUNT" },
          ],
          predictiveBudgetEnabled: true,
          bedrockTokenMonitoringEnabled: true,
          budgetThresholds: [
            { dollarsSpent: 25, action: "ALERT", triggerOn: "PREDICTED" },
          ],
        }),
      );
    });

    describe("rateLimits", () => {
      const rateLimits = [
        { basis: "HOURLY", rate: 10, action: "ALERT" },
        { basis: "HOURLY", rate: 15, action: "FREEZE_ACCOUNT" },
        { basis: "DAILY", rate: 200, action: "FREEZE_ACCOUNT" },
      ] as const;
      const post = (body: unknown) =>
        handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leaseTemplates",
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(body),
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

      it.each([
        ["a list", { rateLimits }],
        ["an empty list", { rateLimits: [] }],
        [
          "an empty list with predictive controls off",
          { rateLimits: [], predictiveBudgetEnabled: false },
        ],
      ])("stores and returns %s", async (_label, overrides) => {
        const createSpy = vi
          .spyOn(DynamoLeaseTemplateStore.prototype, "create")
          .mockImplementation(async (item) => item);

        const response = await post(rateLimitedTemplateBody(overrides));

        expect(response.statusCode).toBe(201);
        const stored = createSpy.mock.calls[0]![0];
        expect(stored).toMatchObject(overrides);
        expect(stored).not.toHaveProperty("rateLimit");
        const data = JSON.parse(response.body as string).data;
        expect(data.rateLimits).toEqual(overrides.rateLimits);
        expect(data).not.toHaveProperty("rateLimit");
      });

      it.each([
        ["without rateLimits", {}],
        ["beside rateLimits", { rateLimits }],
      ])(
        "rejects a singular rateLimit member %s as an unknown key",
        async (_label, extra) => {
          const createSpy = vi.spyOn(
            DynamoLeaseTemplateStore.prototype,
            "create",
          );

          const response = await post({
            ...rateLimitedTemplateBody(extra),
            rateLimit: { maxHourlyRate: 5 },
          });

          expect(response).toEqual({
            statusCode: 400,
            body: createFailureResponseBody({
              field: "input",
              message: 'Unrecognized key: "rateLimit"',
            }),
            headers: expect.objectContaining(
              responseHeadersWithErrorType("ValidationError"),
            ),
          });
          expect(createSpy).not.toHaveBeenCalled();
        },
      );

      const limit = (overrides: Record<string, unknown>) => ({
        basis: "HOURLY",
        rate: 5,
        action: "ALERT",
        ...overrides,
      });

      it.each([
        [
          "eleven entries",
          {
            rateLimits: Array.from({ length: 11 }, (_, i) =>
              limit({ rate: i + 1 }),
            ),
          },
          "less than or equal to 10",
        ],
        [
          "a repeated (basis, rate) pair",
          { rateLimits: [limit({}), limit({ action: "FREEZE_ACCOUNT" })] },
          "duplicate rate limit",
        ],
        [
          "a zero rate",
          { rateLimits: [limit({ rate: 0 })] },
          "rateLimits.0.rate",
        ],
        [
          "an unknown basis",
          { rateLimits: [limit({ basis: "WEEKLY" })] },
          "rateLimits.0.basis",
        ],
        [
          "an unknown action",
          { rateLimits: [limit({ action: "DELETE" })] },
          "rateLimits.0.action",
        ],
        ["an unknown member", { rateLimits: [limit({ note: "x" })] }, "note"],
        [
          "a non-empty list with predictive controls off",
          { rateLimits, predictiveBudgetEnabled: false },
          "rateLimits requires predictiveBudgetEnabled",
        ],
      ])("rejects %s with a 400", async (_label, overrides, message) => {
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );

        const response = await post(rateLimitedTemplateBody(overrides));

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain(message);
        expect(createSpy).not.toHaveBeenCalled();
      });
    });

    describe("PREDICTED budget thresholds", () => {
      const predicted = {
        dollarsSpent: 25,
        action: "ALERT",
        triggerOn: "PREDICTED",
      } as const;
      const post = (body: Record<string, unknown>) =>
        handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leaseTemplates",
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(body),
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

      it.each([
        ["predictive controls off", { predictiveBudgetEnabled: false }],
        ["the flag omitted (defaults off)", {}],
      ])("rejects a PREDICTED threshold with %s", async (_label, flag) => {
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );
        const { predictiveBudgetEnabled: _omitted, ...body } =
          rateLimitedTemplateBody({ budgetThresholds: [predicted] });

        const response = await post({ ...body, ...flag });

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message: PREDICTED_REQUIRES_PREDICTIVE_MESSAGE,
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
        expect(createSpy).not.toHaveBeenCalled();
      });

      it.each([
        ["REPORTED", { triggerOn: "REPORTED" }],
        ["unset triggerOn", {}],
      ])(
        "accepts a %s threshold with predictive controls off",
        async (_label, trigger) => {
          const createSpy = vi
            .spyOn(DynamoLeaseTemplateStore.prototype, "create")
            .mockImplementation(async (item) => item);
          const threshold = { dollarsSpent: 25, action: "ALERT", ...trigger };

          const response = await post(
            rateLimitedTemplateBody({
              predictiveBudgetEnabled: false,
              budgetThresholds: [threshold],
            }),
          );

          expect(response.statusCode).toBe(201);
          expect(createSpy.mock.calls[0]![0].budgetThresholds).toEqual([
            threshold,
          ]);
        },
      );
    });

    describe("budget thresholds at maxSpend", () => {
      const post = (body: Record<string, unknown>) =>
        handler(
          createAPIGatewayProxyEvent({
            httpMethod: "POST",
            path: "/leaseTemplates",
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(body),
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

      it("rejects a threshold equal to maxSpend", async () => {
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );

        const response = await post(
          rateLimitedTemplateBody({
            maxSpend: 50,
            budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
          }),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message: THRESHOLD_AT_MAX_SPEND_MESSAGE,
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
        expect(createSpy).not.toHaveBeenCalled();
      });
    });

    it("should reject a client-supplied meta field (server-owned)", async () => {
      // meta (createdTime/lastEditTime/schemaVersion) is server-owned. A client
      // must not be able to forge it, so meta is omitted from the accepted
      // schema and a body containing it is rejected outright.
      const body = {
        name: "forged-template",
        requiresApproval: false,
        visibility: "PUBLIC",
        allowOwnerToShareLease: false,
        maxSpend: 50,
        leaseDurationInHours: 24,
        meta: { createdTime: "2019-01-01T00:00:00.000Z", schemaVersion: 4 },
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(body),
      });

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({ ...body, uuid: mockUuid } as never);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(createSpy).not.toHaveBeenCalled();
    });
    it("should return 400 response when body is missing", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
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
        // A missing body no longer produces the pre-Smithy "Body not provided."
        // message: required-member-ness is expressible by the model, so Smithy
        // renders the per-field 400 before the operation runs. (Modeled
        // ValidationError → alphabetized envelope, so compare structurally.)
        body: jsendFailBodyLike(
          {
            field: "name",
            message:
              "Value at '/name' failed to satisfy constraint: Member must not be null",
          },
          {
            field: "requiresApproval",
            message:
              "Value at '/requiresApproval' failed to satisfy constraint: Member must not be null",
          },
        ),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body fails to parse", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: "not-a-json",
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
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body is malformed", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: undefined,
          name: undefined,
          blueprintName: undefined,
          meta: undefined,
          maxSpend: 50,
          leaseDurationInHours: 24,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: mockUuid,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // `name` is a required member the model expresses, so Smithy renders the
        // 400 and short-circuits before the operation's Zod parse runs — so the
        // unknown-key ("createdBy") report Zod would have added does not appear.
        // The unknown-key path is still covered where the body is otherwise
        // valid (see the strict-key PUT cases below). Modeled ValidationError →
        // alphabetized envelope, so compare structurally.
        body: jsendFailBodyLike({
          field: "name",
          message:
            "Value at '/name' failed to satisfy constraint: Member must not be null",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it.each([
      {
        maxSpend: 200, // exceeded max
        leaseDurationInHours: 50,
        expectedErrorMessage: createFailureResponseBody({
          message: `Max budget cannot be greater than the global max budget (${mockedGlobalConfig.leases.maxBudget}).`,
        }),
      },
      {
        maxSpend: 50,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `Duration cannot be greater than the global max duration (${mockedGlobalConfig.leases.maxDurationHours}).`,
        }),
      },
    ])(
      `should return 400 when lease template values exceed global configuration: $expectedErrorMessage`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
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
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        costReportGroup: "invalid-group",
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        costReportGroup: undefined,
        blueprintId: undefined,
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when lease template violates cost reporting constraints",
      async ({ costReportGroup, reportingConfig, expectedError }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
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
          body: createFailureResponseBody({ message: expectedError }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        maxSpend: 200,
        leaseDurationInHours: undefined,
        expectedErrorMessage: createFailureResponseBody({
          message: `A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.`,
        }),
      },
      {
        maxSpend: undefined,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.`,
        }),
      },
    ])(
      `should return 400 when unlimited budget/spend is provided when not enabled in AppConfig`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const mockedGlobalConfig = mockGlobalConfig();
        mockedGlobalConfig.leases.maxBudget = 500;
        mockedGlobalConfig.leases.maxDurationHours = 500;
        mockedGlobalConfig.leases.requireMaxBudget = true;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.leaseSharingEnabled = true;

        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
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
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it("should return 200 and create lease template with PUBLIC visibility", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PUBLIC",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should create lease template with PRIVATE visibility", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PRIVATE",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should default to PUBLIC visibility when not specified", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          visibility: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
        visibility: "PUBLIC" as const, // Should default to PUBLIC
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 response when db call throws unexpected error", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new Error();
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should resolve blueprintName when blueprintId is provided", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId,
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint: { name: "Resolved-Blueprint" },
          stackSets: [],
        },
      } as any);

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({
          ...leaseTemplate,
          uuid: mockUuid,
          createdBy: isbAuthorizedUser.user.email,
          blueprintName: "Resolved-Blueprint",
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId,
          blueprintName: "Resolved-Blueprint",
        }),
      );
    });

    it("should return 400 when blueprintId references non-existent blueprint", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: undefined,
      } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Referenced blueprint not found.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("should set blueprintName to null when no blueprintId is provided", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({
          ...leaseTemplate,
          uuid: mockUuid,
          createdBy: isbAuthorizedUser.user.email,
          blueprintName: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintName: null,
        }),
      );
      expect(DynamoBlueprintStore.prototype.get).not.toHaveBeenCalled();
    });

    it("should return 400 when allowOwnerToShareLease is true and leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: true,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
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
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it.each([
      [
        "predictiveBudgetEnabled",
        "allowPredictiveBudgetControls",
        "predictive budget controls",
      ],
      [
        "bedrockTokenMonitoringEnabled",
        "allowBedrockTokenMonitoring",
        "Bedrock token monitoring",
      ],
    ] as const)(
      "should return 400 when %s is true and %s is false",
      async (templateField, gateField, featureName) => {
        const gateOffConfig = {
          ...mockedGlobalConfig,
          leases: {
            ...mockedGlobalConfig.leases,
            [gateField]: false,
          },
        };
        mockAppConfigMiddleware(gateOffConfig, mockedReportingConfig);

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            allowOwnerToShareLease: false,
            [templateField]: true,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        });

        expect(
          await handler(event, mockAuthorizedContext(testEnv, gateOffConfig)),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: `Cannot enable ${templateField} because ${featureName} is not available.`,
          }),
          // The generated pipeline adds `x-amzn-errortype` to error responses.
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    describe("Sandbox Spaces token monitoring requirement", () => {
      // The requirement is checked while Sandbox Spaces is on globally.
      const sandboxSpacesOnConfig = {
        ...mockedGlobalConfig,
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: true,
        },
      };
      // Both global gates off, for the tests that check the global gate.
      const globalGatesOffConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowBedrockTokenMonitoring: false,
        },
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: false,
        },
      };
      beforeEach(() => {
        mockAppConfigMiddleware(sandboxSpacesOnConfig, mockedReportingConfig);
      });
      function createEvent(fields: Record<string, unknown>) {
        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: false,
            ...fields,
          },
        );
        return createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        });
      }

      it("rejects Sandbox Spaces without Bedrock token monitoring", async () => {
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );

        const response = await handler(
          createEvent({
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: false,
          }),
          mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(response.headers?.["x-amzn-errortype"]).toBe("ValidationError");
        expect(JSON.parse(response.body).data.errors).toEqual([
          {
            field: "sandboxSpacesEnabled",
            message:
              "Sandbox Spaces requires Bedrock token monitoring. Set bedrockTokenMonitoringEnabled to true to enable Sandbox Spaces.",
          },
        ]);
        expect(createSpy).not.toHaveBeenCalled();
      });

      it("rejects Sandbox Spaces when bedrockTokenMonitoringEnabled is omitted", async () => {
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );
        const event = createEvent({ sandboxSpacesEnabled: true });
        const body = JSON.parse(event.body!);
        delete body.bedrockTokenMonitoringEnabled;
        event.body = JSON.stringify(body);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].field).toBe(
          "sandboxSpacesEnabled",
        );
        expect(createSpy).not.toHaveBeenCalled();
      });

      it.each([
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: false },
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: true },
      ] as const)(
        "creates a template with sandboxSpacesEnabled $sandboxSpacesEnabled and monitoring $bedrockTokenMonitoringEnabled",
        async (fields) => {
          const createSpy = vi
            .spyOn(DynamoLeaseTemplateStore.prototype, "create")
            .mockImplementation(async (item) => item);

          const response = await handler(
            createEvent(fields),
            mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
          );

          expect(response.statusCode).toBe(201);
          expect(createSpy).toHaveBeenCalledWith(
            expect.objectContaining(fields),
          );
        },
      );

      it("rejects a new template enabling Sandbox Spaces while Sandbox Spaces and Bedrock token monitoring are off globally", async () => {
        mockAppConfigMiddleware(globalGatesOffConfig, mockedReportingConfig);
        const createSpy = vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "create",
        );

        const response = await handler(
          createEvent({
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: true,
          }),
          mockAuthorizedContext(testEnv, globalGatesOffConfig),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message:
              "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
        expect(createSpy).not.toHaveBeenCalled();
      });
    });

    // The body parser returns 415 for three conditions; only a non-JSON
    // Content-Type is genuinely a media-type problem.
    it("should return 415 when Content-Type is not JSON", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "text/plain",
        },
        isbUser: isbAuthorizedUser.user,
        body: "name=test",
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message: "Unsupported Media Type.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("UnsupportedMediaTypeError"),
        ),
      });
    });

    it("rejects a Content-Type carrying parameters (e.g. charset)", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const uuid = randomUUID();
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // restJson1 requires an exact `application/json` Content-Type; a `charset`
      // parameter is a 415. The pre-Smithy `httpJsonBodyParser` accepted it — an
      // accepted deviation of the Smithy migration.
      expect(response).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message: "Unsupported Media Type.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("UnsupportedMediaTypeError"),
        ),
      });
    });

    it("should return exactly the JSend success envelope keys", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: randomUUID(),
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // The exact key set is part of the contract: no top-level "message".
      expect(Object.keys(JSON.parse(response.body)).sort()).toEqual([
        "data",
        "status",
      ]);
    });

    it("should return the bare entity in data, not a result wrapper", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // POST returns the entity directly; GET returns
      // { result, nextPageIdentifier }. The shapes differ inside data.
      const { data } = JSON.parse(response.body);
      expect(data.uuid).toBe(mockUuid);
      expect(data).not.toHaveProperty("result");
      expect(data).not.toHaveProperty("nextPageIdentifier");
    });
  });

  describe("GET /leaseTemplates/{leaseTemplateId}", () => {
    it("extracts the id from the request path, not from pathParameters", async () => {
      // The generated mux binds the {leaseTemplateId} label from `event.path`.
      // The pre-Smithy CDK resource is `{leaseTemplateName}`, and the removed Middy
      // router used to repopulate `pathParameters.leaseTemplateId` from its route
      // pattern — so this asserts the id now comes from the path segment and that
      // an empty `pathParameters` does not break routing.
      const pathId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const getSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "get")
        .mockResolvedValue({
          result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
            uuid: pathId,
            visibility: "PUBLIC",
          }),
        });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leaseTemplates/${pathId}`,
          pathParameters: {},
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(getSpy).toHaveBeenCalledWith(pathId);
    });

    it("should return 200 response with a single lease template", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {},
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: leaseTemplate,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: leaseTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 and allow Admin/Manager to access PRIVATE templates", async () => {
      const privateTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PRIVATE",
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: privateTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: privateTemplate.uuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: privateTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 and deny User role access to PRIVATE templates", async () => {
      const privateTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PRIVATE",
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: privateTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: privateTemplate.uuid,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(SsmIdcStackConfigStore.prototype.get).not.toHaveBeenCalled();
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });

    it("should return 200 allow User role to access PUBLIC templates", async () => {
      const publicTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PUBLIC",
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: publicTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: publicTemplate.uuid,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: publicTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 response when lease template is not found", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
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
          message: `Lease template not found.`,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(SsmIdcStackConfigStore.prototype.get).not.toHaveBeenCalled();
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockImplementation(
        () => {
          throw new Error();
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });
  });

  describe("PUT /leaseTemplates/{leaseTemplateId}", () => {
    beforeEach(() => {
      // The PUT handler fetches the existing template to make config-compliance
      // validation change-aware (cost report group, max budget, duration, and
      // the two feature opt-ins). Default to an existing template with no cost
      // report group and both opt-ins off, so a test that enables one is a
      // change; individual tests override as needed.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          costReportGroup: undefined,
          allowOwnerToShareLease: false,
          predictiveBudgetEnabled: false,
          bedrockTokenMonitoringEnabled: false,
        }),
      });
    });

    it("accepts both permission-set ARN fields and returns hydrated references", async () => {
      const existingTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existingTemplate,
      });
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getPermissionSetCacheItems",
      ).mockResolvedValue([
        permissionSetCacheItem(userPermissionSetArn, "BuiltInUser"),
        permissionSetCacheItem(customPermissionSetArn, "Custom"),
      ]);

      const request = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [
            customPermissionSetArn,
            userPermissionSetArn,
          ],
        },
      );
      const update = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockImplementation(async (item) => ({
          oldItem: existingTemplate,
          newItem: item,
        }));

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(request),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(
        DynamoPrincipalStore.prototype.getPermissionSetCacheItems,
      ).toHaveBeenCalledExactlyOnceWith({ consistentRead: true });

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [
            customPermissionSetArn,
            userPermissionSetArn,
          ],
        }),
        expect.anything(),
      );
      const data = JSON.parse(response.body).data;
      expect(data).not.toHaveProperty("defaultPermissionSetArn");
      expect(data).not.toHaveProperty("allowedPermissionSetArns");
      expect(data.defaultPermissionSet).toEqual(
        expect.objectContaining({
          permissionSetArn: customPermissionSetArn,
          name: "Custom",
          availability: "AVAILABLE",
        }),
      );
      expect(data.allowedPermissionSets).toEqual([
        data.defaultPermissionSet,
        expect.objectContaining({
          permissionSetArn: userPermissionSetArn,
          name: "BuiltInUser",
          availability: "AVAILABLE",
        }),
      ]);
    });

    it("should return 200 for a PREDICTED threshold while switching predictive budget controls on", async () => {
      const fields = {
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          {
            dollarsSpent: 25,
            action: "ALERT" as const,
            triggerOn: "PREDICTED" as const,
          },
        ],
      };
      const existingTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
          costReportGroup: undefined,
          predictiveBudgetEnabled: false,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existingTemplate,
      });
      const request = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          ...fields,
        },
      );
      const update = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockImplementation(async (item) => ({
          oldItem: existingTemplate,
          newItem: item,
        }));

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(request),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining(fields),
        existingTemplate,
      );
    });

    it("allows unrelated updates to preserve explicitly echoed unavailable permission sets", async () => {
      const existingTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
          maxSpend: 25,
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [missingPermissionSetArn],
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existingTemplate,
      });
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getPermissionSetCacheItems",
      ).mockResolvedValue([
        permissionSetCacheItem(userPermissionSetArn, "BuiltInUser"),
      ]);

      const request = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [missingPermissionSetArn],
        },
      );
      const update = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockImplementation(async (item) => ({
          oldItem: existingTemplate,
          newItem: item,
        }));

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(request),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          maxSpend: 50,
          defaultPermissionSetArn: customPermissionSetArn,
          allowedPermissionSetArns: [missingPermissionSetArn],
        }),
        expect.anything(),
      );
      const data = JSON.parse(response.body).data;
      expect(data.defaultPermissionSet).toEqual({
        permissionSetArn: customPermissionSetArn,
        permissionSetId: permissionSetIdFromArn(customPermissionSetArn),
        availability: "UNAVAILABLE",
      });
      expect(data.allowedPermissionSets).toEqual([
        data.defaultPermissionSet,
        {
          permissionSetArn: missingPermissionSetArn,
          permissionSetId: permissionSetIdFromArn(missingPermissionSetArn),
          availability: "UNAVAILABLE",
        },
      ]);
    });

    it("should return 200 response with updated data", async () => {
      const oldLeaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
        },
      );
      const newLeaseTemplateJsonBody = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const updatedItem = {
        ...newLeaseTemplateJsonBody,
        uuid: oldLeaseTemplate.uuid,
        createdBy: oldLeaseTemplate.createdBy,
      };
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: updatedItem,
          oldItem: oldLeaseTemplate,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: updatedItem,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("rejects an invalid date-time in meta with the generic 400 (deviation)", async () => {
      // `meta.createdTime` is modeled `@timestampFormat("date-time")`, so an
      // invalid date-time fails generated deserialization before the operation's
      // Zod parse — the generic restJson1 400, not the pre-Smithy field-specific
      // message. Accepted deviation of the Smithy migration.
      const validBody = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          meta: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify({
          ...validBody,
          meta: { createdTime: "not-a-date", schemaVersion: 1 },
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
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("allows updating other fields when a required cost report group is already missing", async () => {
      // Existing template has no cost report group and one is now required.
      // Editing an unrelated field (maxSpend) must still succeed.
      mockAppConfigMiddleware(mockedGlobalConfig, testReportingConfigRequired);
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          costReportGroup: undefined,
        }),
      });

      const newLeaseTemplateJsonBody = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 75,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: {
          ...newLeaseTemplateJsonBody,
          uuid: mockUuid,
          createdBy: "original.author@example.com",
        },
        oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
        }),
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
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

    it("allows updating other fields when a required duration/budget is already missing", async () => {
      // Existing template predates the requirement: no maxSpend / duration.
      // Budget and duration are now required. Editing an unrelated field
      // (costReportGroup) must still succeed, leaving the missing fields as-is.
      const requiredConfig = mockGlobalConfig();
      requiredConfig.leases.maxBudget = 500;
      requiredConfig.leases.maxDurationHours = 500;
      requiredConfig.leases.requireMaxBudget = true;
      requiredConfig.leases.requireMaxDuration = true;
      requiredConfig.leases.leaseSharingEnabled = true;
      mockAppConfigMiddleware(requiredConfig, testReportingConfig);

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          maxSpend: undefined,
          leaseDurationInHours: undefined,
          costReportGroup: undefined,
        }),
      });

      const newLeaseTemplateJsonBody = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: undefined,
          leaseDurationInHours: undefined,
          costReportGroup: "valid-group-1",
          allowOwnerToShareLease: false,
          blueprintId: undefined,
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: {
          ...newLeaseTemplateJsonBody,
          uuid: mockUuid,
          createdBy: "original.author@example.com",
        },
        oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
        }),
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, requiredConfig),
      );

      expect(response.statusCode).toEqual(200);
    });

    it("should return 400 response when body is missing", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
          oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // A missing body no longer produces the pre-Smithy "Body not provided."
        // message: required-member-ness is expressible by the model, so Smithy
        // renders the per-field 400 before the operation runs. (Modeled
        // ValidationError → alphabetized envelope, so compare structurally.)
        body: jsendFailBodyLike(
          {
            field: "name",
            message:
              "Value at '/name' failed to satisfy constraint: Member must not be null",
          },
          {
            field: "requiresApproval",
            message:
              "Value at '/requiresApproval' failed to satisfy constraint: Member must not be null",
          },
        ),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body fails to parse", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: "not-a-json",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
          oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        }),
      );

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
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body is malformed", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          blueprintName: undefined,
          maxSpend: 50,
          leaseDurationInHours: 24,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: leaseTemplate.uuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
          oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized keys: "uuid", "createdBy"',
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it.each([
      {
        maxSpend: 200, // exceeded max
        leaseDurationInHours: 50,
        expectedErrorMessage: createFailureResponseBody({
          message: `Max budget cannot be greater than the global max budget (${mockedGlobalConfig.leases.maxBudget}).`,
        }),
      },
      {
        maxSpend: 50,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `Duration cannot be greater than the global max duration (${mockedGlobalConfig.leases.maxDurationHours}).`,
        }),
      },
    ])(
      `should return 400 when lease template values exceed global configuration: $expectedErrorMessage`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
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
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        costReportGroup: "invalid-group",
        previousCostReportGroup: undefined,
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        // Clearing a previously-set group when one is required is still blocked.
        costReportGroup: undefined,
        previousCostReportGroup: "valid-group-1",
        blueprintId: undefined,
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when lease template update violates cost reporting constraints",
      async ({
        costReportGroup,
        previousCostReportGroup,
        reportingConfig,
        expectedError,
      }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            costReportGroup: previousCostReportGroup,
          }),
        });

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
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
          body: createFailureResponseBody({ message: expectedError }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        maxSpend: 200,
        leaseDurationInHours: undefined,
        expectedErrorMessage: createFailureResponseBody({
          message: `A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.`,
        }),
      },
      {
        maxSpend: undefined,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.`,
        }),
      },
    ])(
      `should return 400 when unlimited budget/spend is provided when not enabled in AppConfig`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const mockedGlobalConfig = mockGlobalConfig();
        mockedGlobalConfig.leases.maxBudget = 500;
        mockedGlobalConfig.leases.maxDurationHours = 500;
        mockedGlobalConfig.leases.requireMaxBudget = true;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.leaseSharingEnabled = true;

        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        // Existing template HAS budget + duration set, so submitting an
        // unlimited (missing) value is a genuine change and must be rejected —
        // not treated as an unchanged pre-existing gap. (Pin both so the
        // change-aware validation is deterministic.)
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            maxSpend: 100,
            leaseDurationInHours: 50,
            costReportGroup: undefined,
          }),
        });

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
            // Pin so the (randomly generated) group can't trip the cost-report
            // validation before the budget/duration check under test.
            costReportGroup: undefined,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
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
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it("should return 500 response when db call throws unexpected error", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new Error();
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should return 200 and update lease template visibility from PUBLIC to PRIVATE", async () => {
      const oldTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PUBLIC",
        },
      );

      const updatedTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PRIVATE",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const resultTemplate = {
        ...updatedTemplate,
        uuid: oldTemplate.uuid,
        createdBy: oldTemplate.createdBy,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: resultTemplate,
        oldItem: oldTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: oldTemplate.uuid,
        },
        body: JSON.stringify(updatedTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: resultTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("rejects a request body that tries to set createdBy", async () => {
      // createdBy is server-owned and immutable after create, so the strict
      // schema rejects it outright rather than silently ignoring it.
      const body = {
        ...generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
          },
        ),
        createdBy: "attacker@example.com",
      };

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
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
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "createdBy"',
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("persists the original createdBy from the existing record", async () => {
      // Even though the body can no longer carry createdBy, the handler must
      // still put the ORIGINAL creator on the updated record (not drop it, and
      // not substitute the caller's identity).
      const originalCreatedBy = "original.author@example.com";
      const persisted = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
          createdBy: originalCreatedBy,
          costReportGroup: undefined,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: persisted,
      });

      const body = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      // Echo back exactly what the handler handed the store, so the assertion
      // reflects the handler's own output rather than the DAO's safety net.
      const updateSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockImplementation(async (template) => ({
          newItem: template,
          oldItem: persisted,
        }));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]![0].createdBy).toBe(originalCreatedBy);
      expect(JSON.parse(response.body).data.createdBy).toBe(originalCreatedBy);
    });

    it("returns 404 for a missing template even when the body would also fail validation", async () => {
      // The existence check must run before blueprint resolution and config
      // validation, otherwise a bad blueprintId masks the real 404 with a
      // "Referenced blueprint not found." 400.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      const blueprintGet = vi
        .spyOn(DynamoBlueprintStore.prototype, "get")
        .mockResolvedValue({ result: undefined } as any);

      const body = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Bailing early also avoids the needless blueprint lookup.
      expect(blueprintGet).not.toHaveBeenCalled();
    });

    it("returns 404 when updating a template that does not exist", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const body = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 and update lease template visibility from PRIVATE to PUBLIC", async () => {
      const oldTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          visibility: "PRIVATE",
        },
      );

      const updatedTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PUBLIC",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const resultTemplate = {
        ...updatedTemplate,
        uuid: oldTemplate.uuid,
        createdBy: oldTemplate.createdBy,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: resultTemplate,
        oldItem: oldTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: oldTemplate.uuid,
        },
        body: JSON.stringify(updatedTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: resultTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 response when the item is deleted between read and write", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      // Existence is already checked before this point, so this covers the
      // residual race: the row is deleted between that read and the write, and
      // update() surfaces UnknownItem, which maps to a 404.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new UnknownItem("Lease template not found.");
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should resolve blueprintName when blueprintId is provided on update", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId,
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint: { name: "Resolved-Blueprint" },
          stackSets: [],
        },
      } as any);

      const updateSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockResolvedValue({
          oldItem: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
          newItem: {
            ...leaseTemplate,
            uuid: mockUuid,
            createdBy: "original.author@example.com",
            blueprintName: "Resolved-Blueprint",
          },
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId,
          blueprintName: "Resolved-Blueprint",
        }),
        expect.anything(),
      );
    });

    it("should return 400 when blueprintId references non-existent blueprint on update", async () => {
      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: undefined,
      } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Referenced blueprint not found.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("should return 400 when allowOwnerToShareLease is true and leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: true,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
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
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it.each([
      [
        "predictiveBudgetEnabled",
        "allowPredictiveBudgetControls",
        "predictive budget controls",
      ],
      [
        "bedrockTokenMonitoringEnabled",
        "allowBedrockTokenMonitoring",
        "Bedrock token monitoring",
      ],
    ] as const)(
      "should return 400 when enabling %s while %s is false",
      async (templateField, gateField, featureName) => {
        const gateOffConfig = {
          ...mockedGlobalConfig,
          leases: {
            ...mockedGlobalConfig.leases,
            [gateField]: false,
          },
        };
        mockAppConfigMiddleware(gateOffConfig, mockedReportingConfig);

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            allowOwnerToShareLease: false,
            [templateField]: true,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        });

        expect(
          await handler(event, mockAuthorizedContext(testEnv, gateOffConfig)),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: `Cannot enable ${templateField} because ${featureName} is not available.`,
          }),
          // The generated pipeline adds `x-amzn-errortype` to error responses.
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([
      ["predictiveBudgetEnabled", "allowPredictiveBudgetControls", true],
      ["predictiveBudgetEnabled", "allowPredictiveBudgetControls", false],
      ["bedrockTokenMonitoringEnabled", "allowBedrockTokenMonitoring", true],
      ["bedrockTokenMonitoringEnabled", "allowBedrockTokenMonitoring", false],
    ] as const)(
      "still saves a template with %s already on while %s is off (kept on: %s)",
      async (templateField, gateField, keepEnabled) => {
        const gateOffConfig = {
          ...mockedGlobalConfig,
          leases: {
            ...mockedGlobalConfig.leases,
            [gateField]: false,
          },
        };
        mockAppConfigMiddleware(gateOffConfig, mockedReportingConfig);

        const existingTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema,
          {
            uuid: mockUuid,
            costReportGroup: undefined,
            [templateField]: true,
          },
        );
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: existingTemplate,
        });

        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            allowOwnerToShareLease: false,
            [templateField]: keepEnabled,
          },
        );
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
          Promise.resolve({
            newItem: {
              ...leaseTemplate,
              uuid: existingTemplate.uuid,
              createdBy: existingTemplate.createdBy,
            },
            oldItem: existingTemplate,
          }),
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, gateOffConfig),
        );
        expect(response.statusCode).toBe(200);
      },
    );

    it("saves a template turning Bedrock token monitoring on with Sandbox Spaces while allowBedrockTokenMonitoring is off", async () => {
      const gateOffConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowBedrockTokenMonitoring: false,
        },
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: true,
        },
      };
      mockAppConfigMiddleware(gateOffConfig, mockedReportingConfig);

      const existingTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
          costReportGroup: undefined,
          bedrockTokenMonitoringEnabled: false,
          sandboxSpacesEnabled: false,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existingTemplate,
      });

      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: false,
          bedrockTokenMonitoringEnabled: true,
          sandboxSpacesEnabled: true,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: {
            ...leaseTemplate,
            uuid: existingTemplate.uuid,
            createdBy: existingTemplate.createdBy,
          },
          oldItem: existingTemplate,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, gateOffConfig),
      );
      expect(response.statusCode).toBe(200);
    });

    it("rejects keeping Bedrock token monitoring on when Sandbox Spaces is turned off while allowBedrockTokenMonitoring is off", async () => {
      const gateOffConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowBedrockTokenMonitoring: false,
        },
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: true,
        },
      };
      mockAppConfigMiddleware(gateOffConfig, mockedReportingConfig);

      const existingTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
          costReportGroup: undefined,
          bedrockTokenMonitoringEnabled: true,
          sandboxSpacesEnabled: true,
        },
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existingTemplate,
      });

      const leaseTemplate = generateLeaseTemplateData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          allowedModelIds: true,
          defaultModelId: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: false,
          bedrockTokenMonitoringEnabled: true,
          sandboxSpacesEnabled: false,
        },
      );
      const updateSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockReturnValue(
          Promise.resolve({
            newItem: {
              ...leaseTemplate,
              uuid: existingTemplate.uuid,
              createdBy: existingTemplate.createdBy,
            },
            oldItem: existingTemplate,
          }),
        );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, gateOffConfig),
      );
      expect(response.statusCode).toBe(400);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    describe("Sandbox Spaces token monitoring requirement", () => {
      // The requirement is checked while Sandbox Spaces is on globally.
      const sandboxSpacesOnConfig = {
        ...mockedGlobalConfig,
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: true,
        },
      };
      // Both global gates off, for the tests that check the global gate.
      const globalGatesOffConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowBedrockTokenMonitoring: false,
        },
        agent: {
          ...mockedGlobalConfig.agent,
          sandboxSpacesEnabled: false,
        },
      };
      beforeEach(() => {
        mockAppConfigMiddleware(sandboxSpacesOnConfig, mockedReportingConfig);
      });
      function mockExistingTemplate(fields: Record<string, unknown>) {
        const existingTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema,
          {
            uuid: mockUuid,
            costReportGroup: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: false,
            ...fields,
          },
        );
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: existingTemplate,
        });
        return vi
          .spyOn(DynamoLeaseTemplateStore.prototype, "update")
          .mockImplementation(async (template) => ({
            newItem: template as PersistedLeaseTemplate,
            oldItem: existingTemplate,
          }));
      }

      function updateEvent(fields: Record<string, unknown>) {
        const leaseTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            allowedModelIds: true,
            defaultModelId: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: false,
            ...fields,
          },
        );
        return createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: { leaseTemplateId: mockUuid },
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        });
      }

      // The second row is a template stored before the requirement: re-saving
      // it unchanged is rejected too, so no update can store the pair.
      it.each([
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: false },
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: false },
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
      ] as const)(
        "rejects Sandbox Spaces without Bedrock token monitoring (stored sandboxSpacesEnabled $sandboxSpacesEnabled, monitoring $bedrockTokenMonitoringEnabled)",
        async (stored) => {
          const updateSpy = mockExistingTemplate(stored);

          const response = await handler(
            updateEvent({
              sandboxSpacesEnabled: true,
              bedrockTokenMonitoringEnabled: false,
            }),
            mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
          );

          expect(response.statusCode).toBe(400);
          expect(response.headers?.["x-amzn-errortype"]).toBe(
            "ValidationError",
          );
          expect(JSON.parse(response.body).data.errors).toEqual([
            {
              field: "sandboxSpacesEnabled",
              message:
                "Sandbox Spaces requires Bedrock token monitoring. Set bedrockTokenMonitoringEnabled to true to enable Sandbox Spaces.",
            },
          ]);
          expect(updateSpy).not.toHaveBeenCalled();
        },
      );

      it("rejects Sandbox Spaces when bedrockTokenMonitoringEnabled is omitted", async () => {
        const updateSpy = mockExistingTemplate({
          sandboxSpacesEnabled: true,
          bedrockTokenMonitoringEnabled: true,
        });
        const event = updateEvent({ sandboxSpacesEnabled: true });
        const body = JSON.parse(event.body!);
        delete body.bedrockTokenMonitoringEnabled;
        event.body = JSON.stringify(body);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).data.errors[0].field).toBe(
          "sandboxSpacesEnabled",
        );
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it.each([
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: false },
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: true },
      ] as const)(
        "saves sandboxSpacesEnabled $sandboxSpacesEnabled with monitoring $bedrockTokenMonitoringEnabled",
        async (fields) => {
          const updateSpy = mockExistingTemplate({
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: true,
          });

          const response = await handler(
            updateEvent(fields),
            mockAuthorizedContext(testEnv, sandboxSpacesOnConfig),
          );

          expect(response.statusCode).toBe(200);
          expect(updateSpy).toHaveBeenCalledWith(
            expect.objectContaining(fields),
            expect.anything(),
          );
        },
      );

      it("rejects turning Sandbox Spaces on while Sandbox Spaces and Bedrock token monitoring are off globally", async () => {
        mockAppConfigMiddleware(globalGatesOffConfig, mockedReportingConfig);
        const updateSpy = mockExistingTemplate({
          sandboxSpacesEnabled: false,
          bedrockTokenMonitoringEnabled: true,
        });

        const response = await handler(
          updateEvent({
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: true,
          }),
          mockAuthorizedContext(testEnv, globalGatesOffConfig),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message:
              "Cannot enable sandboxSpacesEnabled because Sandbox Spaces is not available.",
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
        expect(updateSpy).not.toHaveBeenCalled();
      });
    });

    describe("rateLimits on update", () => {
      const storedRateLimits = [
        { basis: "HOURLY", rate: 10, action: "ALERT" },
        { basis: "DAILY", rate: 200, action: "FREEZE_ACCOUNT" },
      ] as const;
      const replacement = [
        { basis: "HOURLY", rate: 12, action: "FREEZE_ACCOUNT" },
      ];
      const gateOffConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowPredictiveBudgetControls: false,
        },
      };

      beforeEach(() => {
        const existingTemplate = generateLeaseTemplateData(
          PersistedLeaseTemplateSchema,
          {
            uuid: mockUuid,
            costReportGroup: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: true,
            bedrockTokenMonitoringEnabled: false,
            rateLimits: [...storedRateLimits],
          },
        );
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: existingTemplate,
        });
        vi.spyOn(
          DynamoLeaseTemplateStore.prototype,
          "update",
        ).mockImplementation(async (item) => ({
          oldItem: existingTemplate,
          newItem: item,
        }));
      });

      const put = (
        body: unknown,
        globalConfig: typeof mockedGlobalConfig = mockedGlobalConfig,
      ) => {
        mockAppConfigMiddleware(globalConfig, mockedReportingConfig);
        return handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PUT",
            path: "/leaseTemplates/{leaseTemplateId}",
            pathParameters: { leaseTemplateId: mockUuid },
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(body),
          }),
          mockAuthorizedContext(testEnv, globalConfig),
        );
      };

      const stored = () => {
        const update = vi.mocked(DynamoLeaseTemplateStore.prototype.update);
        expect(update).toHaveBeenCalledOnce();
        return update.mock.calls[0]![0];
      };

      it.each<{
        name: string;
        body: Record<string, unknown>;
        omitFlag?: boolean;
        gateClosed?: boolean;
        expected: unknown;
      }>([
        {
          name: "keeps the stored list when the body omits it",
          body: { maxSpend: 75 },
          expected: storedRateLimits,
        },
        {
          name: "replaces the stored list",
          body: { rateLimits: replacement },
          expected: replacement,
        },
        {
          name: "replaces limits on an opted-in template after the global gate closes",
          body: { rateLimits: replacement },
          gateClosed: true,
          expected: replacement,
        },
        {
          name: "clears the limits with an explicit empty list",
          body: { rateLimits: [] },
          expected: [],
        },
        {
          name: "clears the stored list when predictive controls are turned off",
          body: { predictiveBudgetEnabled: false },
          expected: undefined,
        },
        {
          name: "stores an explicit empty list when predictive controls are turned off",
          body: { predictiveBudgetEnabled: false, rateLimits: [] },
          expected: [],
        },
        {
          name: "keeps predictive controls and the stored list when the flag is omitted",
          body: { maxSpend: 75 },
          omitFlag: true,
          expected: storedRateLimits,
        },
        {
          name: "accepts a list when the flag is omitted on a predictive template",
          body: { rateLimits: replacement },
          omitFlag: true,
          expected: replacement,
        },
      ])("$name", async ({ body, omitFlag, gateClosed, expected }) => {
        const request = rateLimitedTemplateBody(body);
        const { predictiveBudgetEnabled: _omitted, ...withoutFlag } = request;

        const response = await put(
          omitFlag ? withoutFlag : request,
          gateClosed ? gateOffConfig : undefined,
        );

        expect(response.statusCode).toBe(200);
        expect(stored().predictiveBudgetEnabled).toBe(
          body.predictiveBudgetEnabled ?? true,
        );
        expect(stored().maxSpend).toBe(body.maxSpend ?? 50);
        expect(stored().rateLimits).toEqual(expected);
        expect(stored()).not.toHaveProperty("rateLimit");
        const data = JSON.parse(response.body as string).data;
        expect(data.rateLimits).toEqual(expected);
        expect(data).not.toHaveProperty("rateLimit");
      });

      it.each([
        ["without rateLimits", {}],
        ["beside rateLimits", { rateLimits: replacement }],
      ])(
        "rejects a singular rateLimit member %s as an unknown key",
        async (_label, extra) => {
          const response = await put({
            ...rateLimitedTemplateBody(extra),
            rateLimit: { maxHourlyRate: 5 },
          });

          expect(response).toEqual({
            statusCode: 400,
            body: createFailureResponseBody({
              field: "input",
              message: 'Unrecognized key: "rateLimit"',
            }),
            headers: expect.objectContaining(
              responseHeadersWithErrorType("ValidationError"),
            ),
          });
          expect(
            DynamoLeaseTemplateStore.prototype.update,
          ).not.toHaveBeenCalled();
        },
      );

      it("rejects a non-empty list sent beside an explicit off switch", async () => {
        const response = await put(
          rateLimitedTemplateBody({
            predictiveBudgetEnabled: false,
            rateLimits: replacement,
          }),
        );

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain(
          "rateLimits requires predictiveBudgetEnabled",
        );
        expect(
          DynamoLeaseTemplateStore.prototype.update,
        ).not.toHaveBeenCalled();
      });

      const predictedThreshold = {
        dollarsSpent: 25,
        action: "ALERT",
        triggerOn: "PREDICTED",
      } as const;

      it("rejects a PREDICTED threshold sent beside an explicit off switch", async () => {
        const response = await put(
          rateLimitedTemplateBody({
            predictiveBudgetEnabled: false,
            budgetThresholds: [predictedThreshold],
          }),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message: PREDICTED_REQUIRES_PREDICTIVE_MESSAGE,
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
        expect(
          DynamoLeaseTemplateStore.prototype.update,
        ).not.toHaveBeenCalled();
      });

      it("accepts a PREDICTED threshold when the flag is omitted on a predictive template", async () => {
        const { predictiveBudgetEnabled: _omitted, ...body } =
          rateLimitedTemplateBody({ budgetThresholds: [predictedThreshold] });

        const response = await put(body);

        expect(response.statusCode).toBe(200);
        expect(stored().predictiveBudgetEnabled).toBe(true);
        expect(stored().budgetThresholds).toEqual([predictedThreshold]);
      });

      it("rejects a PREDICTED threshold when the flag is omitted on a non-predictive template", async () => {
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            costReportGroup: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: false,
            bedrockTokenMonitoringEnabled: false,
          }),
        });
        const { predictiveBudgetEnabled: _omitted, ...body } =
          rateLimitedTemplateBody({ budgetThresholds: [predictedThreshold] });

        const response = await put(body);

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message: PREDICTED_REQUIRES_PREDICTIVE_MESSAGE,
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
        expect(
          DynamoLeaseTemplateStore.prototype.update,
        ).not.toHaveBeenCalled();
      });

      it("accepts a REPORTED threshold when predictive controls are turned off", async () => {
        const reported = { ...predictedThreshold, triggerOn: "REPORTED" };

        const response = await put(
          rateLimitedTemplateBody({
            predictiveBudgetEnabled: false,
            budgetThresholds: [reported],
          }),
        );

        expect(response.statusCode).toBe(200);
        expect(stored().budgetThresholds).toEqual([reported]);
      });

      it("rejects a threshold equal to maxSpend", async () => {
        const response = await put(
          rateLimitedTemplateBody({
            maxSpend: 50,
            budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
          }),
        );

        expect(response).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            field: "budgetThresholds",
            message: THRESHOLD_AT_MAX_SPEND_MESSAGE,
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
        expect(
          DynamoLeaseTemplateStore.prototype.update,
        ).not.toHaveBeenCalled();
      });

      it("accepts an unrelated edit on a stored template whose threshold equals maxSpend", async () => {
        const atMax = [{ dollarsSpent: 50, action: "ALERT" as const }];
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            costReportGroup: undefined,
            allowOwnerToShareLease: false,
            predictiveBudgetEnabled: true,
            bedrockTokenMonitoringEnabled: false,
            maxSpend: 50,
            budgetThresholds: atMax,
          }),
        });

        const response = await put(
          rateLimitedTemplateBody({
            name: "renamed",
            maxSpend: 50,
            budgetThresholds: atMax,
          }),
        );

        expect(response.statusCode).toBe(200);
        expect(stored().budgetThresholds).toEqual(atMax);
      });
    });

    describe("optimistic concurrency", () => {
      const existingTemplate = () =>
        generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          costReportGroup: undefined,
          allowOwnerToShareLease: false,
          predictiveBudgetEnabled: false,
          bedrockTokenMonitoringEnabled: false,
        });

      const put = () =>
        handler(
          createAPIGatewayProxyEvent({
            httpMethod: "PUT",
            path: "/leaseTemplates/{leaseTemplateId}",
            pathParameters: { leaseTemplateId: mockUuid },
            headers: { "Content-Type": "application/json" },
            isbUser: isbAuthorizedUser.user,
            body: JSON.stringify(
              rateLimitedTemplateBody({ predictiveBudgetEnabled: false }),
            ),
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

      it("conditions the write on the template read for validation", async () => {
        const existing = existingTemplate();
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: existing,
        });
        const update = vi
          .spyOn(DynamoLeaseTemplateStore.prototype, "update")
          .mockImplementation(async (item) => ({
            oldItem: existing,
            newItem: item,
          }));

        const response = await put();

        expect(response.statusCode).toBe(200);
        expect(update).toHaveBeenCalledOnce();
        expect(update.mock.calls[0]![1]).toBe(existing);
      });

      it("returns 409 without retrying when the template changed after it was read", async () => {
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: existingTemplate(),
        });
        const update = vi
          .spyOn(DynamoLeaseTemplateStore.prototype, "update")
          .mockRejectedValue(
            new ConcurrentDataModificationException(
              "The lease template has been modified from the expected value.",
            ),
          );

        const response = await put();

        expect(response).toEqual({
          statusCode: 409,
          body: createFailureResponseBody({
            message:
              "The lease template changed while this update was being processed. Refresh the template and retry.",
          }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ConflictError"),
          ),
        });
        expect(update).toHaveBeenCalledOnce();
      });
    });
  });

  describe("DELETE /leaseTemplates/{leaseTemplateId}", () => {
    it("should return 200 response with no data", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "delete").mockReturnValue(
        Promise.resolve(
          Promise.resolve(
            generateLeaseTemplateData(PersistedLeaseTemplateSchema, {}),
          ),
        ),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "delete").mockImplementation(
        () => {
          throw new Error();
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/leaseTemplates/{leaseTemplateId}",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });
  });
});

describe("catalog model allowlist (allowedModelIds)", () => {
  const ENABLED_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const DISABLED_MODEL = "anthropic.claude-3-haiku";
  // The default check only runs while Sandbox Spaces is on globally.
  const baselineSandboxSpacesEnabled =
    mockedGlobalConfig.agent.sandboxSpacesEnabled;
  beforeEach(() => {
    mockedGlobalConfig.agent.sandboxSpacesEnabled = true;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
  });
  afterEach(() => {
    mockedGlobalConfig.agent.sandboxSpacesEnabled =
      baselineSandboxSpacesEnabled;
  });

  function catalog(): PersistedAgentModelCatalogRow[] {
    // Only modelId/enabled are read by the gate; the rest of the row is irrelevant.
    return [
      { modelId: ENABLED_MODEL, enabled: true },
      { modelId: DISABLED_MODEL, enabled: false },
    ] as unknown as PersistedAgentModelCatalogRow[];
  }

  // Feature-gated opt-ins and the predictive-only fields pinned off, and token
  // monitoring on as Sandbox Spaces requires, so validation never rejects
  // before the allowlist check runs; the catalog gate is what these tests
  // assert.
  function body(overrides: Record<string, unknown>) {
    return generateSchemaData(
      PersistedLeaseTemplateSchema.omit({
        uuid: true,
        createdBy: true,
        blueprintName: true,
        meta: true,
        allowedModelIds: true,
        defaultModelId: true,
      }),
      {
        rateLimits: undefined,
        // Random PREDICTED thresholds would trip the predictive gate.
        budgetThresholds: [],
        maxSpend: 50,
        leaseDurationInHours: 24,
        costReportGroup: undefined,
        blueprintId: undefined,
        allowOwnerToShareLease: false,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: true,
        sandboxSpacesEnabled: true,
        defaultPermissionSetArn: undefined,
        allowedPermissionSetArns: undefined,
        ...overrides,
      },
    );
  }

  it("creates a template when every selected model is enabled", async () => {
    const getAgentModels = vi
      .spyOn(DynamoConfigStore.prototype, "getAgentModels")
      .mockResolvedValue(catalog());
    const requestBody = body({ allowedModelIds: [ENABLED_MODEL] });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
      ...requestBody,
      uuid: randomUUID(),
      createdBy: isbAuthorizedUser.user.email,
    });

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(requestBody),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(201);
    expect(getAgentModels).toHaveBeenCalledTimes(1);
  });

  it("rejects creation when a selected model is not enabled, without echoing the id", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const createSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "create");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ allowedModelIds: [DISABLED_MODEL] })),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    // The rejected model id must not leak into the client-facing message.
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("does not read the catalog when no model subset is provided (inherits global set)", async () => {
    const getAgentModels = vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModels",
    );
    const requestBody = body({}); // allowedModelIds omitted
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
      ...requestBody,
      uuid: randomUUID(),
      createdBy: isbAuthorizedUser.user.email,
    });

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(requestBody),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(201);
    expect(getAgentModels).not.toHaveBeenCalled();
  });

  it("grandfathers a previously-permitted model that is now disabled on update", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const existing = generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
      uuid: mockUuid,
      costReportGroup: undefined,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      allowedModelIds: [DISABLED_MODEL],
    });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
      result: existing,
    });
    const updateSpy = vi
      .spyOn(DynamoLeaseTemplateStore.prototype, "update")
      .mockImplementation(async (template) => ({
        newItem: template,
        oldItem: existing,
      }));

    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/leaseTemplates/{leaseTemplateId}",
      pathParameters: { leaseTemplateId: mockUuid },
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ allowedModelIds: [DISABLED_MODEL] })),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a newly-added disabled model on update", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const existing = generateSchemaData(PersistedLeaseTemplateSchema, {
      uuid: mockUuid,
      costReportGroup: undefined,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      allowedModelIds: [],
    });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
      result: existing,
    });
    const updateSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "update");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/leaseTemplates/{leaseTemplateId}",
      pathParameters: { leaseTemplateId: mockUuid },
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ allowedModelIds: [DISABLED_MODEL] })),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("creates a template when the default is one of the enabled selected models", async () => {
    const getAgentModels = vi
      .spyOn(DynamoConfigStore.prototype, "getAgentModels")
      .mockResolvedValue(catalog());
    const requestBody = body({
      allowedModelIds: [ENABLED_MODEL],
      defaultModelId: ENABLED_MODEL,
    });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
      ...requestBody,
      uuid: randomUUID(),
      createdBy: isbAuthorizedUser.user.email,
    });

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(requestBody),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(201);
    expect(getAgentModels).toHaveBeenCalledTimes(1);
  });

  it("rejects creation when the default is outside the selected subset, without echoing the id", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const createSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "create");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(
        body({
          allowedModelIds: [ENABLED_MODEL],
          defaultModelId: DISABLED_MODEL,
        }),
      ),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects a disabled default when no subset is provided (inherits global set)", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const createSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "create");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ defaultModelId: DISABLED_MODEL })),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("attributes a disabled default to the defaultModelId field", async () => {
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );

    const event = createAPIGatewayProxyEvent({
      httpMethod: "POST",
      path: "/leaseTemplates",
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ defaultModelId: DISABLED_MODEL })),
    });

    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers?.["x-amzn-errortype"]).toBe("ValidationError");
    expect(JSON.parse(response.body)).toMatchObject({
      status: "fail",
      data: { errors: [{ field: "defaultModelId" }] },
    });
  });

  it.each([
    {
      case: "inside a grandfathered subset",
      allowedModelIds: [DISABLED_MODEL],
    },
    { case: "with no subset", allowedModelIds: undefined },
  ])(
    "rejects an unchanged disabled default on update $case",
    async ({ allowedModelIds }) => {
      vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
        catalog(),
      );
      const existing = generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
        uuid: mockUuid,
        costReportGroup: undefined,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: false,
        allowedModelIds,
        defaultModelId: DISABLED_MODEL,
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: existing,
      });
      const updateSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "update");

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(
          body({ allowedModelIds, defaultModelId: DISABLED_MODEL }),
        ),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(DISABLED_MODEL);
      expect(JSON.parse(response.body).data.errors[0].field).toBe(
        "defaultModelId",
      );
      expect(updateSpy).not.toHaveBeenCalled();
    },
  );
  it("saves an unrelated edit carrying a disabled default while Sandbox Spaces is off globally", async () => {
    mockedGlobalConfig.agent.sandboxSpacesEnabled = false;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
    const getAgentModels = vi
      .spyOn(DynamoConfigStore.prototype, "getAgentModels")
      .mockResolvedValue(catalog());
    const existing = generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
      uuid: mockUuid,
      costReportGroup: undefined,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: true,
      allowedModelIds: undefined,
      defaultModelId: DISABLED_MODEL,
    });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
      result: existing,
    });
    const updateSpy = vi
      .spyOn(DynamoLeaseTemplateStore.prototype, "update")
      .mockImplementation(async (template) => ({
        newItem: template,
        oldItem: existing,
      }));
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/leaseTemplates/{leaseTemplateId}",
      pathParameters: { leaseTemplateId: mockUuid },
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(body({ defaultModelId: DISABLED_MODEL })),
    });
    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModelId: DISABLED_MODEL }),
      expect.anything(),
    );
    expect(getAgentModels).not.toHaveBeenCalled();
  });
  it("still rejects a newly added disabled model while Sandbox Spaces is off globally", async () => {
    mockedGlobalConfig.agent.sandboxSpacesEnabled = false;
    mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue(
      catalog(),
    );
    const existing = generateLeaseTemplateData(PersistedLeaseTemplateSchema, {
      uuid: mockUuid,
      costReportGroup: undefined,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: true,
      allowedModelIds: [ENABLED_MODEL],
      defaultModelId: undefined,
    });
    vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
      result: existing,
    });
    const updateSpy = vi.spyOn(DynamoLeaseTemplateStore.prototype, "update");
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/leaseTemplates/{leaseTemplateId}",
      pathParameters: { leaseTemplateId: mockUuid },
      headers: { "Content-Type": "application/json" },
      isbUser: isbAuthorizedUser.user,
      body: JSON.stringify(
        body({ allowedModelIds: [ENABLED_MODEL, DISABLED_MODEL] }),
      ),
    });
    const response = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      "One or more selected models are not enabled in the model catalog.",
    );
    expect(response.body).not.toContain(DISABLED_MODEL);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
