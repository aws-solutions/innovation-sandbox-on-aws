// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SharedJsonParamEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-shared-json-param-parser/shared-json-param-parser-handler.js";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";

const testEnv = generateSchemaData(SharedJsonParamEnvironmentSchema);
const ssmMock = mockClient(SSMClient);

vi.spyOn(IsbClients, "ssmProvider").mockImplementation((env) => {
  return new SSMProvider({
    awsSdkV3Client: ssmMock as any,
    clientConfig: {
      customUserAgent: env.USER_AGENT_EXTRA,
    },
  });
});

beforeEach(() => {
  bulkStubEnv(testEnv);
});

afterEach(() => {
  vi.unstubAllEnvs();
  ssmMock.reset();
});

describe("lambda handler", () => {
  // Test fixture objects grouped by stack
  const testIdcConfig = {
    identityStoreId: "d-0000000000",
    ssoInstanceArn: "arn:aws:sso:::instance/ssoins-123",
    adminGroupId: "admin-group",
    managerGroupId: "manager-group",
    userGroupId: "user-group",
    adminPermissionSetArn:
      "arn:aws:sso:::permissionSet/ssoins-123/ps-0000000000",
    managerPermissionSetArn:
      "arn:aws:sso:::permissionSet/ssoins-123/ps-1111111111",
    userPermissionSetArn:
      "arn:aws:sso:::permissionSet/ssoins-123/ps-2222222222",
    solutionVersion: "v1.0.0",
    supportedSchemas: ["1"],
  };

  const testAccountPoolConfig = {
    sandboxOuId: "ou-00000000",
    availableOuId: "ou-11111111",
    activeOuId: "ou-22222222",
    frozenOuId: "ou-33333333",
    cleanupOuId: "ou-44444444",
    quarantineOuId: "ou-55555555",
    entryOuId: "ou-66666666",
    exitOuId: "ou-77777777",
    solutionVersion: "v2.0.0",
    supportedSchemas: ["1"],
    isbManagedRegions: ["us-east-1", "us-west-2"],
  };

  const testDataConfig = {
    configApplicationId: "App111",
    configEnvironmentId: "Env111",
    globalConfigConfigurationProfileId: "Profile111",
    nukeConfigConfigurationProfileId: "NukeProfile111",
    reportingConfigConfigurationProfileId: "ReportingProfile111",
    accountTable: "AccountTable",
    leaseTemplateTable: "LeaseTemplateTable",
    leaseTable: "LeaseTable",
    blueprintTable: "test-blueprint-table",
    tableKmsKeyId: "KmsKeyId",
    solutionVersion: "v3.0.0",
    supportedSchemas: ["1"],
  };

  const eventCreate: CdkCustomResourceEvent = {
    RequestType: "Create",
    ServiceToken:
      "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider1",
    ResponseURL: "https://example.com",
    StackId: "Stack1",
    RequestId: "Request1",
    LogicalResourceId: "Logical",
    ResourceType: "Custom::ParseJsonConfigurationr",
    ResourceProperties: {
      ServiceToken:
        "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider1",
      idcConfigParamArn: "arn:IdcConfigParam",
      accountPoolConfigParamArn: "arn:AccountConfigParam",
      dataConfigParamArn: "arn:DataConfigParam",
    },
  };
  const idcConfigValue = JSON.stringify({
    ...testIdcConfig,
    supportedSchemas: JSON.stringify(testIdcConfig.supportedSchemas),
  });
  const accountPoolConfigValue = JSON.stringify({
    ...testAccountPoolConfig,
    supportedSchemas: JSON.stringify(testAccountPoolConfig.supportedSchemas),
    isbManagedRegions: testAccountPoolConfig.isbManagedRegions.join(","),
  });
  const dataConfigValue = JSON.stringify({
    ...testDataConfig,
    supportedSchemas: JSON.stringify(testDataConfig.supportedSchemas),
  });
  const testPhysicalResourceId = "Resource111";
  const eventUpdate = {
    ...eventCreate,
    RequestType: "Update",
    PhysicalResourceId: testPhysicalResourceId,
  };

  const responseData = {
    // IDC config with prefixed keys
    identityStoreId: testIdcConfig.identityStoreId,
    ssoInstanceArn: testIdcConfig.ssoInstanceArn,
    adminGroupId: testIdcConfig.adminGroupId,
    managerGroupId: testIdcConfig.managerGroupId,
    userGroupId: testIdcConfig.userGroupId,
    adminPermissionSetArn: testIdcConfig.adminPermissionSetArn,
    managerPermissionSetArn: testIdcConfig.managerPermissionSetArn,
    userPermissionSetArn: testIdcConfig.userPermissionSetArn,
    idcSolutionVersion: testIdcConfig.solutionVersion,
    idcSupportedSchemas: JSON.stringify(testIdcConfig.supportedSchemas),
    // Account Pool config with prefixed keys
    sandboxOuId: testAccountPoolConfig.sandboxOuId,
    availableOuId: testAccountPoolConfig.availableOuId,
    activeOuId: testAccountPoolConfig.activeOuId,
    frozenOuId: testAccountPoolConfig.frozenOuId,
    cleanupOuId: testAccountPoolConfig.cleanupOuId,
    quarantineOuId: testAccountPoolConfig.quarantineOuId,
    entryOuId: testAccountPoolConfig.entryOuId,
    exitOuId: testAccountPoolConfig.exitOuId,
    accountPoolSolutionVersion: testAccountPoolConfig.solutionVersion,
    accountPoolSupportedSchemas: JSON.stringify(
      testAccountPoolConfig.supportedSchemas,
    ),
    isbManagedRegions: testAccountPoolConfig.isbManagedRegions,
    // Data config with prefixed keys
    configApplicationId: testDataConfig.configApplicationId,
    configEnvironmentId: testDataConfig.configEnvironmentId,
    globalConfigConfigurationProfileId:
      testDataConfig.globalConfigConfigurationProfileId,
    nukeConfigConfigurationProfileId:
      testDataConfig.nukeConfigConfigurationProfileId,
    reportingConfigConfigurationProfileId:
      testDataConfig.reportingConfigConfigurationProfileId,
    accountTable: testDataConfig.accountTable,
    leaseTemplateTable: testDataConfig.leaseTemplateTable,
    leaseTable: testDataConfig.leaseTable,
    blueprintTable: testDataConfig.blueprintTable,
    tableKmsKeyId: testDataConfig.tableKmsKeyId,
    dataSolutionVersion: testDataConfig.solutionVersion,
    dataSupportedSchemas: JSON.stringify(testDataConfig.supportedSchemas),
  };

  it("should return the parsed configs on create", async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolvesOnce({
        Parameter: {
          Value: idcConfigValue,
        },
      })
      .resolvesOnce({
        Parameter: {
          Value: accountPoolConfigValue,
        },
      })
      .resolvesOnce({
        Parameter: {
          Value: dataConfigValue,
        },
      });
    await expect(handler(eventCreate, mockContext(testEnv))).resolves.toEqual({
      Data: responseData,
      PhysicalResourceId: "SharedJsonParamParser",
    });
  });

  it("should return the parsed configs on update", async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolvesOnce({
        Parameter: {
          Value: idcConfigValue,
        },
      })
      .resolvesOnce({
        Parameter: {
          Value: accountPoolConfigValue,
        },
      })
      .resolvesOnce({
        Parameter: {
          Value: dataConfigValue,
        },
      });
    await expect(handler(eventUpdate, mockContext(testEnv))).resolves.toEqual({
      Data: responseData,
      PhysicalResourceId: testPhysicalResourceId,
    });
  });

  describe("should error on invalid configurations", () => {
    it("should error on invalid Idc configurations", async () => {
      // Mock returns invalid config for IDC parameter
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:IdcConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: "invalidConfigValue",
          },
        });
      // Zod validation will throw an error when parsing invalid config
      await expect(
        handler(eventCreate, mockContext(testEnv)),
      ).rejects.toThrow();
    });
    it("should error on invalid Account Pool configurations", async () => {
      // Mock returns valid IDC config, then invalid Account Pool config
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:IdcConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: idcConfigValue,
          },
        });
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:AccountConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: "invalidConfigValue",
          },
        });
      // Zod validation will throw an error when parsing invalid config
      await expect(
        handler(eventCreate, mockContext(testEnv)),
      ).rejects.toThrow();
    });
    it("should error on invalid Data configurations", async () => {
      // Mock returns valid IDC and Account Pool configs, then invalid Data config
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:IdcConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: idcConfigValue,
          },
        });
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:AccountConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: accountPoolConfigValue,
          },
        });
      ssmMock
        .on(GetParameterCommand, {
          Name: "arn:DataConfigParam",
        })
        .resolvesOnce({
          Parameter: {
            Value: "invalidConfigValue",
          },
        });
      // Zod validation will throw an error when parsing invalid config
      await expect(
        handler(eventCreate, mockContext(testEnv)),
      ).rejects.toThrow();
    });
  });
});
