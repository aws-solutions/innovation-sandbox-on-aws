// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CloudFormationClient,
  ListStackSetsCommand,
} from "@aws-sdk/client-cloudformation";
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

import {
  BlueprintItem,
  BlueprintWithStackSets,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { GlobalConfigSchema } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  BlueprintDeploymentService,
  StackSetNotFoundError,
  UnsupportedPermissionModelError,
} from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import { createTestBlueprintItem } from "@amzn/innovation-sandbox-commons/test/fixtures/blueprint-fixtures.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  mockAuthorizedContext,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const mockCloudFormationClient = mockClient(CloudFormationClient);
const secretsManagerMock = mockClient(SecretsManagerClient);

const testEnv = generateSchemaData(BlueprintLambdaEnvironmentSchema, {
  BLUEPRINT_TABLE_NAME: "test-blueprint-table",
  LEASE_TEMPLATE_TABLE_NAME: "test-lease-template-table",
  INTERMEDIATE_ROLE_ARN: "arn:aws:iam::123456789012:role/IntermediateRole",
  SANDBOX_ACCOUNT_ROLE_NAME: "SandboxAccountRole",
  ORG_MGT_ACCOUNT_ID: "111111111111",
  HUB_ACCOUNT_ID: "222222222222",
});

const mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);

let handler: typeof import("../src/blueprints-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (await import("../src/blueprints-handler.js")).handler;
});

describe("Blueprint API Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationClient.reset();
    secretsManagerMock.reset();
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockedGlobalConfig);

    // Mock Secrets Manager to return JWT secret
    secretsManagerMock.on(GetSecretValueCommand).resolves({
      SecretString: "testSecret",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    secretsManagerMock.reset();
  });

  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/blueprints",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${isbAuthorizedUser.token}`,
      },
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  describe("GET /blueprints/stacksets", () => {
    it("should list SELF_MANAGED StackSets only", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "self-managed-stackset",
            StackSetId: "self-managed-stackset:ss-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
            Description: "Test StackSet",
          },
          {
            StackSetName: "service-managed-stackset",
            StackSetId: "service-managed-stackset:ss-456",
            PermissionModel: "SERVICE_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "self-managed-stackset",
                stackSetId: "self-managed-stackset:ss-123",
                description: "Test StackSet",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
              {
                stackSetName: "service-managed-stackset",
                stackSetId: "service-managed-stackset:ss-456",
                status: "ACTIVE",
                permissionModel: "SERVICE_MANAGED",
              },
            ],
            nextPageIdentifier: undefined,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should handle empty StackSets list", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: [],
            nextPageIdentifier: undefined,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return nextPageIdentifier when more results available", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "self-managed-stackset",
            StackSetId: "self-managed-stackset:ss-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
            Description: "Test StackSet",
          },
        ],
        NextToken: "next-page-token",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "self-managed-stackset",
                stackSetId: "self-managed-stackset:ss-123",
                description: "Test StackSet",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
            ],
            nextPageIdentifier: "next-page-token",
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 for invalid pagination parameters", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        queryStringParameters: { pageSize: "999" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "pageSize",
          message: "Number must be less than or equal to 100",
        }),
        headers: responseHeaders,
      });
    });

    it("should filter AWSControlTower StackSets in org management account", async () => {
      // Test with ORG_MGT_ACCOUNT_ID === HUB_ACCOUNT_ID (org mgmt account)
      const orgMgmtEnv = {
        ...testEnv,
        ORG_MGT_ACCOUNT_ID: "111111111111",
        HUB_ACCOUNT_ID: "111111111111", // Same as org mgmt
      };

      // Stub the environment for this test
      bulkStubEnv(orgMgmtEnv);

      mockCloudFormationClient.reset();
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "AWSControlTowerBP-BASELINE-CLOUDWATCH",
            StackSetId: "AWSControlTowerBP-BASELINE-CLOUDWATCH:ss-ct-123",
            Status: "ACTIVE",
          },
          {
            StackSetName: "AWSControlTowerGuardrailAWS-GR-AUDIT",
            StackSetId: "AWSControlTowerGuardrailAWS-GR-AUDIT:ss-ct-456",
            Status: "ACTIVE",
          },
          {
            StackSetName: "my-custom-stackset",
            StackSetId: "my-custom-stackset:ss-789",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const result = await handler(event, mockAuthorizedContext(orgMgmtEnv));
      const body = JSON.parse(result.body);

      // Should only return the custom StackSet, not Control Tower ones
      expect(body.data.result).toHaveLength(1);
      expect(body.data.result[0].stackSetName).toBe("my-custom-stackset");
      expect(result.statusCode).toBe(200);
    });

    it("should NOT filter AWSControlTower StackSets in member account", async () => {
      // Test with ORG_MGT_ACCOUNT_ID !== HUB_ACCOUNT_ID (member account)
      const memberAccountEnv = {
        ...testEnv,
        ORG_MGT_ACCOUNT_ID: "111111111111",
        HUB_ACCOUNT_ID: "222222222222", // Different from org mgmt
      };

      // Stub the environment for this test
      bulkStubEnv(memberAccountEnv);

      mockCloudFormationClient.reset();
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "AWSControlTowerBP-CUSTOM-USER-CREATED",
            StackSetId: "AWSControlTowerBP-CUSTOM-USER-CREATED:ss-user-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
          {
            StackSetName: "my-custom-stackset",
            StackSetId: "my-custom-stackset:ss-789",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const result = await handler(
        event,
        mockAuthorizedContext(memberAccountEnv),
      );
      const body = JSON.parse(result.body);

      // Should return both StackSets (no filtering in member account)
      expect(body.data.result).toHaveLength(2);
      expect(body.data.result[0].stackSetName).toBe(
        "AWSControlTowerBP-CUSTOM-USER-CREATED",
      );
      expect(body.data.result[1].stackSetName).toBe("my-custom-stackset");
      expect(result.statusCode).toBe(200);
    });
  });

  describe("GET /blueprints", () => {
    it("should list all blueprints", async () => {
      const mockBlueprints: BlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: mockBlueprints,
          nextPageIdentifier: null,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            blueprints: mockBlueprints,
            nextPageIdentifier: null,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should handle empty blueprints list", async () => {
      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: [],
          nextPageIdentifier: null,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            blueprints: [],
            nextPageIdentifier: null,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return nextPageIdentifier when pagination needed", async () => {
      const mockBlueprints: BlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: mockBlueprints,
          nextPageIdentifier: "next-token",
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            blueprints: mockBlueprints,
            nextPageIdentifier: "next-token",
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should support pagination with pageIdentifier and pageSize", async () => {
      const mockBlueprints: BlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      const listBlueprintsSpy = vi
        .spyOn(DynamoBlueprintStore.prototype, "listBlueprints")
        .mockReturnValue(
          Promise.resolve({
            result: mockBlueprints,
            nextPageIdentifier: "next-token",
          }),
        );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        queryStringParameters: {
          pageIdentifier: "previous-token",
          pageSize: "50",
        },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      await handler(event, mockAuthorizedContext(testEnv));

      expect(listBlueprintsSpy).toHaveBeenCalledWith({
        pageIdentifier: "previous-token",
        pageSize: 50,
      });
    });

    it("should return 400 for invalid pagination parameters", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        queryStringParameters: {
          pageSize: "999",
        },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "pageSize",
          message: "Number must be less than or equal to 100",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 when data store call fails", async () => {
      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockImplementation(() => {
        throw new Error();
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });
  });

  describe("POST /blueprints", () => {
    it("should register blueprint successfully", async () => {
      const mockBlueprint: BlueprintItem = {
        PK: "bp#123",
        SK: "blueprint",
        itemType: "BLUEPRINT",
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
        tags: {},
        createdBy: "admin@example.com",
        deploymentTimeoutMinutes: 60,
        regionConcurrencyType: "SEQUENTIAL",
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
        meta: {
          schemaVersion: 1,
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
        },
      };

      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockResolvedValue(mockBlueprint);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 201,
        body: JSON.stringify({
          status: "success",
          data: mockBlueprint,
        }),
        headers: responseHeaders,
      });
      expect(
        BlueprintDeploymentService.prototype.registerBlueprint,
      ).toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      // Multi-line assertion to verify all 2 missing fields are reported by Zod
      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors).toHaveLength(2);
      expect(body.data.errors[0].field).toBe("stackSetId");
    });

    it("should return 400 for invalid request body", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: [],
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "regions",
          message: "Array must contain at least 1 element(s)",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when StackSet not found", async () => {
      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockRejectedValue(
        new StackSetNotFoundError("StackSet 'test-stackset:ss-123' not found"),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "StackSet not found.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when StackSet is SERVICE_MANAGED", async () => {
      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockRejectedValue(
        new UnsupportedPermissionModelError(
          "StackSet ID 'test-stackset:ss-123' uses SERVICE_MANAGED permission model. Only SELF_MANAGED StackSets are supported.",
        ),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "StackSet uses unsupported permission model.",
        }),
        headers: responseHeaders,
      });
    });
  });

  describe("GET /blueprints/{blueprintId}", () => {
    it("should get blueprint details", async () => {
      const mockBlueprintWithStackSets = {
        blueprint: createTestBlueprintItem({
          blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          name: "TestBlueprint",
        }),
        stackSets: [],
      };

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: mockBlueprintWithStackSets,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: mockBlueprintWithStackSets,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: responseHeaders,
      });
    });
  });

  describe("PUT /blueprints/{blueprintId}", () => {
    it("should update mutable fields successfully", async () => {
      const oldBlueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "OldName",
        tags: {},
      });

      const updatedBlueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "NewName",
        tags: { updated: "true" },
      });

      vi.spyOn(DynamoBlueprintStore.prototype, "get")
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: oldBlueprint,
              stackSets: [],
            },
          }),
        )
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: updatedBlueprint,
              stackSets: [],
            },
          }),
        );

      vi.spyOn(DynamoBlueprintStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          oldItem: oldBlueprint,
          newItem: updatedBlueprint,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
          tags: { updated: "true" },
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      expect(response.headers).toEqual(responseHeaders);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.blueprint.name).toBe("NewName");
      expect(body.data.blueprint.tags).toEqual({ updated: "true" });
    });

    it("should remove all tags when tags is undefined", async () => {
      const blueprintWithoutTags = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
        tags: {},
      });

      vi.spyOn(DynamoBlueprintStore.prototype, "get")
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: createTestBlueprintItem({
                blueprintId: "650e8400-e29b-41d4-a716-446655440001",
                name: "TestBlueprint",
                tags: { Cost: "$2", Description: "testing-123" },
              }),
              stackSets: [],
            },
          }),
        )
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: blueprintWithoutTags,
              stackSets: [],
            },
          }),
        );

      vi.spyOn(DynamoBlueprintStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: blueprintWithoutTags,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          tags: {},
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.blueprint.tags).toEqual({});

      // Verify update was called with empty tags object
      expect(DynamoBlueprintStore.prototype.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: {},
        }),
      );
    });

    it("should reject updates to immutable fields", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
          regions: ["us-west-2"],
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: "Unrecognized key(s) in object: 'regions'",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: responseHeaders,
      });
    });
  });

  describe("DELETE /blueprints/{blueprintId}", () => {
    it("should delete blueprint when not in use", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: {
            blueprint: createTestBlueprintItem({
              blueprintId: "650e8400-e29b-41d4-a716-446655440001",
              name: "TestBlueprint",
            }),
            stackSets: [],
          },
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(Promise.resolve([]));

      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "unregisterBlueprint",
      ).mockResolvedValue(undefined);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            message: "Blueprint unregistered successfully",
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          },
        }),
        headers: responseHeaders,
      });
      expect(
        BlueprintDeploymentService.prototype.unregisterBlueprint,
      ).toHaveBeenCalled();
    });

    it("should return 409 when blueprint is in use", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: {
            blueprint: createTestBlueprintItem({
              blueprintId: "650e8400-e29b-41d4-a716-446655440001",
              name: "TestBlueprint",
            }),
            stackSets: [],
          },
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(
        Promise.resolve([
          {
            uuid: "template-1",
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          },
        ]),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Cannot delete blueprint - currently in use by lease templates.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(Promise.resolve([]));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: responseHeaders,
      });
    });
  });
});
