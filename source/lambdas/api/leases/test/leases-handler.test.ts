// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AccountNotFoundException,
  ConcurrentModificationException,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
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

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  GlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  BudgetConfigSchema,
  DurationConfigSchema,
  LeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  Lease,
  LeaseKeySchema,
  LeaseSchema,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import {
  AccountNotInActiveError,
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
  NoAccountsAvailableError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  mockAuthorizedContext,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUserSchema } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import {
  datetimeAsString,
  now,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { randomUUID } from "crypto";
import { DateTime } from "luxon";

const secretsManagerMock = mockClient(SecretsManagerClient);
let mockedGlobalConfig: GlobalConfig;
let mockedReportingConfig: ReportingConfig;
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
  mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);
  mockedGlobalConfig.leases.maxLeasesPerUser = 3;
  mockedGlobalConfig.leases.maxBudget = 50;
  mockedGlobalConfig.leases.maxDurationHours = 999;
  mockedGlobalConfig.leases.requireMaxBudget = true;
  mockedGlobalConfig.leases.requireMaxDuration = false;

  mockedReportingConfig = {
    costReportGroups: [],
    requireCostReportGroup: false,
  };

  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

  // Mock Secrets Manager to return JWT secret
  secretsManagerMock.on(GetSecretValueCommand).resolves({
    SecretString: "testSecret",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  secretsManagerMock.reset();
});

describe("Leases Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/leases",
    });
    expect(
      await handler(
        event,
        mockAuthorizedContext(
          testEnv,
          mockedGlobalConfig,
          mockedReportingConfig,
        ),
      ),
    ).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  describe("GET /leases", () => {
    const allLeases: Lease[] = [
      generateSchemaData(LeaseSchema),
      generateSchemaData(LeaseSchema),
    ];
    const allLeasesWithRefId = allLeases.map((lease) => {
      return {
        ...lease,
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
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 with all leases even when error is set", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
            error: "Zod Validation Error",
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 with first page of leases when pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const pageSize = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          pageSize,
        },
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: "BBB",
          },
        }),
        headers: responseHeaders,
      });
      expect(findAllMethod.mock.calls).toHaveLength(1);
      expect(findAllMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier,
          pageSize: Number(pageSize),
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
          generateSchemaData(LeaseSchema, { userEmail }),
          generateSchemaData(LeaseSchema, { userEmail }),
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
          },
          headers: {
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
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
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: 200,
          body: JSON.stringify({
            status: "success",
            data: {
              result: leases,
              nextPageIdentifier: null,
            },
          }),
          headers: responseHeaders,
        });
        expect(findByUserEmailSpy.mock.calls[0]).toMatchObject([
          {
            userEmail,
          },
        ]);
      },
    );

    it("should return 400 with first page when invalid query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const pageSize = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          pageSize,
        },
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "pageSize",
          message: "Expected number, received nan",
        }),
        headers: responseHeaders,
      });
      expect(findAllMethod.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });

    it("should return 403 for findAllLeases when the user has only 'User' role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        headers: {
          Authorization: `Bearer ${isbAuthorizedUserUserRoleOnly.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get all leases.`,
        }),
        headers: responseHeaders,
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
        headers: {
          Authorization: `Bearer ${isbAuthorizedUserUserRoleOnly.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get the requested leases.`,
        }),
        headers: responseHeaders,
      });
    });
  });

  describe("POST /leases", () => {
    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({ message: "Body not provided." }),
        headers: responseHeaders,
      });
    });

    it("should return 415 when the body is malformed json string", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: "just string",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeaders,
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody(
          { field: "leaseTemplateUuid", message: "Required" },
          { field: "input", message: "Unrecognized key(s) in object: 'abc'" },
        ),
        headers: responseHeaders,
      });
    });

    it("should return 409 when user has exceeded the max number of active leases allowed", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
          }),
        }),
      );
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
            generateSchemaData(PendingLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "PendingApproval",
            }),
            generateSchemaData(MonitoredLeaseSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "You have reached the maximum number of active/pending leases allowed (3).",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when the lease template reference doesn't exist", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "No accounts are available to lease.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 201 for manual approval lease request with valid inputs", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockResolvedValue(
        storedLease,
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(LeaseTemplateSchema, {
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
            generateSchemaData(MonitoredLeaseSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 201,
        body: JSON.stringify({
          status: "success",
          data: storedLease,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const leaseRequest = generateSchemaData(
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
        PendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.string().uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const storedLease = generateSchemaData(PendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(MonitoredLeaseSchema, {
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
          result: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockReturnValue(
        Promise.resolve(storedLease),
      );
      const approvedLease: Lease = {
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 201,
        body: JSON.stringify({
          status: "success",
          data: approvedLease,
        }),
        headers: responseHeaders,
      });
    });

    describe("Lease Assignment Flow", () => {
      const targetUserEmail = "target.user@example.com";
      const targetUser = generateSchemaData(IsbUserSchema, {
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
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });

        const leaseTemplate = generateSchemaData(LeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          visibility: "PRIVATE",
        });

        const resultLease = generateSchemaData(MonitoredLeaseSchema, {
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
          getUserFromEmail: vi.fn().mockResolvedValue(targetUser),
        } as any);

        // Mock the requestLease call
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 201,
          body: JSON.stringify({
            status: "success",
            data: resultLease,
          }),
          headers: responseHeaders,
        });

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          {
            leaseTemplate,
            targetUser,
            createdBy: isbAuthorizedUser.user.email,
            comments: leaseRequest.comments,
          },
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
            Authorization: `Bearer ${isbAuthorizedUserUserRoleOnly.token}`, // Not authorized
          },
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(LeaseTemplateSchema, {
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
          headers: responseHeaders,
        });

        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 404 when target user does not exist in Identity Center", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: "nonexistent@example.com",
          comments: "User does not exist",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(LeaseTemplateSchema, {
              visibility: "PUBLIC",
            }),
          }),
        );

        // Mock user lookup failure in IDC
        vi.spyOn(IsbServices, "idcService").mockReturnValue({
          getUserFromEmail: vi.fn().mockResolvedValue(null),
        } as any);

        // Spy on requestLease call
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 404,
          body: createFailureResponseBody({
            message: `User not found in Identity Center`,
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

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUserUserRoleOnly.token}`,
          },
        });

        // Mock private template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(LeaseTemplateSchema, {
              visibility: "PRIVATE",
            }),
          }),
        );

        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

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
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });

        const leaseTemplate = generateSchemaData(LeaseTemplateSchema, {
          visibility: "PRIVATE",
          requiresApproval: true,
        });

        const resultLease = generateSchemaData(PendingLeaseSchema, {
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
          {
            leaseTemplate,
            targetUser: isbAuthorizedUser.user,
            comments: leaseRequest.comments,
          },
          expect.any(Object),
        );
      });
    });
  });

  describe("GET /leases/{leaseId}", () => {
    it("should return 400 when leaseId is not a valid encoded composite key", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/INVALID_LEASE_ID",
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "leaseId",
          message: "Invalid base64",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when lease does not exist", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }), // record does not exist
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 with lease", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const lease = generateSchemaData(LeaseSchema, { ...leaseKey });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: { ...lease, leaseId: leaseId },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 when requesting somebody else's lease as 'Admin' or 'Manager'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUser.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(LeaseSchema, { ...leaseKey });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: { ...lease, leaseId: leaseId },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 403 when requesting somebody else's lease as 'User'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(LeaseSchema, { ...leaseKey });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        headers: {
          Authorization: `Bearer ${isbAuthorizedUserUserRoleOnly.token}`,
        },
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 when data store call fails", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({ message: "Body not provided." }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when the body doesn't contain any valid keys to update", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(
        MonitoredLeaseSchema,
        leaseCompositeKey,
      );

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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: "Unrecognized key(s) in object: 'abc'",
        }),
        headers: responseHeaders,
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: "Unrecognized key(s) in object: 'userEmail', 'leaseTerms'",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when patching a pending lease", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PendingLeaseSchema, {
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Can only update an active lease",
        }),
        headers: responseHeaders,
      });
    });

    it.each([
      { name: "expired", leaseType: ExpiredLeaseSchema },
      { name: "pending", leaseType: PendingLeaseSchema },
      { name: "denied", leaseType: ApprovalDeniedLeaseSchema },
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
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: "Can only update an active lease",
          }),
          headers: responseHeaders,
        });
      },
    );

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
        const oldLease = generateSchemaData(MonitoredLeaseSchema, {
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
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeaders,
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
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when the patch would violate cost reporting constraints",
      async ({ costReportGroup, reportingConfig, expectedError }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(MonitoredLeaseSchema, {
          ...leaseCompositeKey,
          costReportGroup: costReportGroup,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          maxSpend: 20,
          costReportGroup,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig, reportingConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeaders,
        });
      },
    );

    it.each([{ status: "Active" }, { status: "Frozen" }])(
      "should return 200 for a valid patch request on a(n) $status lease",
      async ({ status }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(MonitoredLeaseSchema, {
          ...leaseCompositeKey,
          status: <"Active" | "Frozen">status,
          leaseDurationInHours: 48,
          costReportGroup: undefined,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          expirationDate: new Date().toISOString(),
          ...generateSchemaData(BudgetConfigSchema, {
            maxSpend: 20, //mockGlobalConfig.maxSpend is 50
          }),
          ...generateSchemaData(
            DurationConfigSchema.omit({ leaseDurationInHours: true }),
          ),
          costReportGroup: undefined,
        };

        const updatedLease = generateSchemaData(MonitoredLeaseSchema, {
          ...oldLease,
          ...requestJsonBody,
        });

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
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
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: 200,
          body: JSON.stringify({
            status: "success",
            data: updatedLease,
          }),
          headers: responseHeaders,
        });
        expect(spyPut).toHaveBeenCalledOnce();
        expect(spyPut).toHaveBeenCalledWith({
          ...updatedLease,
          ...requestJsonBody,
        });
      },
    );

    it("should return 200 when nullable values are used to clear data", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(MonitoredLeaseSchema, {
        ...leaseCompositeKey,
        costReportGroup: undefined,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const requestJsonBody = {
        ...generateSchemaData(BudgetConfigSchema),
        ...generateSchemaData(
          DurationConfigSchema.omit({ leaseDurationInHours: true }),
        ),
        expirationDate: null,
        maxSpend: 20, //no max budget is disallowed in mock global config
      };

      const updatedLease = generateSchemaData(MonitoredLeaseSchema, {
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: updatedLease,
        }),
        headers: responseHeaders,
      });
      expect(spyPut).toHaveBeenCalledOnce();
      expect(spyPut).toHaveBeenCalledWith({
        ...updatedLease,
      });
    });
  });

  describe("POST /leases/{leaseId}/review", () => {
    it("should return 200 and invoke the approveLease action", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: null,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 200 and invoke the denyLease action", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: null,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(denyLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "leaseId",
          message: "Invalid base64",
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 400 and when the request body is invalid", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: "Unrecognized key(s) in object: 'invalidField'",
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only leases in a pending state can be approved/denied.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PendingLeaseSchema);
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/freeze", () => {
    it("should return 200 and invoke the freezeLease action", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: null,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "leaseId",
          message: "Invalid base64",
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
      const mockedLease = generateSchemaData(PendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only active leases can be frozen.`,
        }),
        headers: responseHeaders,
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
        const mockedLease = generateSchemaData(MonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/freeze`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
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
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers: responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(freezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/terminate", () => {
    it("should return 200 and invoke the lease termination process", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: null,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 404 when lease is not found", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
      const mockedLease = generateSchemaData(ExpiredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only [Active, Frozen, Provisioning] leases can be terminated.`,
        }),
        headers: responseHeaders,
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
        const mockedLease = generateSchemaData(MonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/terminate`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
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
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
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
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/unfreeze", () => {
    it("should return 200 and invoke the unfreezeLease action", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema, {
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            ...mockedLease,
            leaseId: mockedLeaseId,
          },
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "leaseId",
          message: "Invalid base64",
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).not.toHaveBeenCalled();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 404 when the lease does not exist", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
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
      const mockedLease = generateSchemaData(PendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only frozen leases can be unfrozen.`,
        }),
        headers: responseHeaders,
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
        const mockedLease = generateSchemaData(MonitoredLeaseSchema, {
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
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
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
            mockAuthorizedContext(
              testEnv,
              mockedGlobalConfig,
              mockedReportingConfig,
            ),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers: responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(MonitoredLeaseSchema, {
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
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
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
          mockAuthorizedContext(
            testEnv,
            mockedGlobalConfig,
            mockedReportingConfig,
          ),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });
});
