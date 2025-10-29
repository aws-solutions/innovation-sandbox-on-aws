// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SharedJsonParamEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-shared-json-param-parser/shared-json-param-parser-handler.js";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";

const testEnv = generateSchemaData(SharedJsonParamEnvironmentSchema);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  bulkStubEnv(testEnv);
});

afterEach(() => {
  vi.unstubAllEnvs();
  ssmMock.reset();
});

describe("lambda handler", () => {
  //Idc
  const testIdentityStoreId = "d-0000000000";
  const testSsoInstanceArn = "arn:aws:sso:::instance/ssoins-123";
  const testAdminGroupId = "admin-group";
  const testManagerGroupId = "manager-group";
  const testUserGroupId = "user-group";
  const testAdminPermissionSetArn =
    "arn:aws:sso:::permissionSet/ssoins-123/ps-0000000000";
  const testManagerPermissionSetArn =
    "arn:aws:sso:::permissionSet/ssoins-123/ps-1111111111";
  const testUserPermissionSetArn =
    "arn:aws:sso:::permissionSet/ssoins-123/ps-2222222222";
  const testIdcSolutionVersion = "v1.0.0";
  const testIdcSupportedSchemas = ["1"];
  //AccountPool
  const testSandboxOuId = "ou-00000000";
  const testAccountPoolSolutionVersion = "v2.0.0";
  const testAccountPoolSupportedSchemas = ["1", "2"];
  const testIsbManagedRegions = "us-east-1,us-west-2";
  //Data
  const testConfigApplicationId = "App111";
  const testConfigEnvironmentId = "Env111";
  const testGlobalConfigConfigurationProfileId = "Profile111";
  const testNukeConfigConfigurationProfileId = "NukeProfile111";
  const testReportingConfigConfigurationProfileId = "ReportingProfile111";
  const testAccountTable = "AccountTable";
  const testLeaseTemplateTable = "LeaseTemplateTable";
  const testLeaseTable = "LeaseTable";
  const testKmsKeyId = "KmsKeyId";
  const testDataSolutionVersion = "v3.0.0";
  const testDataSupportedSchemas = ["1", "2", "3"];

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
    identityStoreId: testIdentityStoreId,
    ssoInstanceArn: testSsoInstanceArn,
    adminGroupId: testAdminGroupId,
    managerGroupId: testManagerGroupId,
    userGroupId: testUserGroupId,
    adminPermissionSetArn: testAdminPermissionSetArn,
    managerPermissionSetArn: testManagerPermissionSetArn,
    userPermissionSetArn: testUserPermissionSetArn,
    solutionVersion: testIdcSolutionVersion,
    supportedSchemas: JSON.stringify(testIdcSupportedSchemas),
  });
  const accountPoolConfigValue = JSON.stringify({
    sandboxOuId: testSandboxOuId,
    solutionVersion: testAccountPoolSolutionVersion,
    supportedSchemas: JSON.stringify(testAccountPoolSupportedSchemas),
    isbManagedRegions: testIsbManagedRegions,
  });
  const dataConfigValue = JSON.stringify({
    configApplicationId: testConfigApplicationId,
    configEnvironmentId: testConfigEnvironmentId,
    globalConfigConfigurationProfileId: testGlobalConfigConfigurationProfileId,
    nukeConfigConfigurationProfileId: testNukeConfigConfigurationProfileId,
    reportingConfigConfigurationProfileId:
      testReportingConfigConfigurationProfileId,
    accountTable: testAccountTable,
    leaseTemplateTable: testLeaseTemplateTable,
    leaseTable: testLeaseTable,
    tableKmsKeyId: testKmsKeyId,
    solutionVersion: testDataSolutionVersion,
    supportedSchemas: JSON.stringify(testDataSupportedSchemas),
  });
  const invalidConfigValue = JSON.stringify({
    invalidId: testIdentityStoreId,
  });
  const testPhysicalResourceId = "Resource111";
  const eventUpdate = {
    ...eventCreate,
    RequestType: "Update",
    PhysicalResourceId: testPhysicalResourceId,
  };

  const responseData = {
    //Idc
    identityStoreId: testIdentityStoreId,
    ssoInstanceArn: testSsoInstanceArn,
    adminGroupId: testAdminGroupId,
    managerGroupId: testManagerGroupId,
    userGroupId: testUserGroupId,
    adminPermissionSetArn: testAdminPermissionSetArn,
    managerPermissionSetArn: testManagerPermissionSetArn,
    userPermissionSetArn: testUserPermissionSetArn,
    idcSolutionVersion: testIdcSolutionVersion,
    idcSupportedSchemas: JSON.stringify(testIdcSupportedSchemas),
    //AccountPool
    sandboxOuId: testSandboxOuId,
    accountPoolSolutionVersion: testAccountPoolSolutionVersion,
    accountPoolSupportedSchemas: JSON.stringify(
      testAccountPoolSupportedSchemas,
    ),
    isbManagedRegions: testIsbManagedRegions,
    //Data
    configApplicationId: testConfigApplicationId,
    configEnvironmentId: testConfigEnvironmentId,
    globalConfigConfigurationProfileId: testGlobalConfigConfigurationProfileId,
    nukeConfigConfigurationProfileId: testNukeConfigConfigurationProfileId,
    reportingConfigConfigurationProfileId:
      testReportingConfigConfigurationProfileId,
    accountTable: testAccountTable,
    leaseTemplateTable: testLeaseTemplateTable,
    leaseTable: testLeaseTable,
    tableKmsKeyId: testKmsKeyId,
    dataSolutionVersion: testDataSolutionVersion,
    dataSupportedSchemas: JSON.stringify(testDataSupportedSchemas),
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

  describe("should error on invalid configurations", async () => {
    it("should error on invalid Idc configurations", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolvesOnce({
          Parameter: {
            Value: invalidConfigValue,
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
      await expect(handler(eventCreate, mockContext(testEnv))).rejects.toThrow(
        "Invalid configuration from Idc stack provided",
      );
    });
    it("should error on invalid Account Pool configurations", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolvesOnce({
          Parameter: {
            Value: idcConfigValue,
          },
        })
        .resolvesOnce({
          Parameter: {
            Value: invalidConfigValue,
          },
        })
        .resolvesOnce({
          Parameter: {
            Value: dataConfigValue,
          },
        });
      await expect(handler(eventCreate, mockContext(testEnv))).rejects.toThrow(
        "Invalid configuration from AccountPool stack provided",
      );
    });
    it("should error on invalid Data configurations", async () => {
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
            Value: invalidConfigValue,
          },
        });
      await expect(handler(eventCreate, mockContext(testEnv))).rejects.toThrow(
        "Invalid configuration from Data stack provided",
      );
    });
  });
});
