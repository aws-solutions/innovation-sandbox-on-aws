// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SsmDataStackConfigStore } from "@amzn/innovation-sandbox-commons/data/data-stack-config/ssm-data-stack-config-store.js";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

const mockSsmClient = mockClient(SSMClient);

describe("SsmDataStackConfigStore", () => {
  let store: SsmDataStackConfigStore;
  let ssmProvider: SSMProvider;

  beforeEach(() => {
    mockSsmClient.reset();
    ssmProvider = new SSMProvider({
      awsSdkV3Client: mockSsmClient as any,
    });
    store = new SsmDataStackConfigStore({
      parameterArn:
        "arn:aws:ssm:us-east-1:123456789012:parameter/test-data-config",
      ssmProvider,
    });
  });

  describe("get()", () => {
    it("should fetch and parse data stack config from SSM", async () => {
      const mockConfig = {
        configApplicationId: "app-123",
        configEnvironmentId: "env-123",
        configTableName: "ConfigTable-123",
        nukeConfigConfigurationProfileId: "profile-nuke-123",
        validatorExclusionConfigConfigurationProfileId:
          "profile-validator-exclusion-123",
        accountTable: "AccountTable",
        leaseTemplateTable: "LeaseTemplateTable",
        leaseTable: "LeaseTable",
        blueprintTable: "BlueprintTable",
        principalTable: "PrincipalTable",
        cleanupReportTable: "CleanupReportTable",
        sandboxSpacesUsageTable: "SandboxSpacesUsageTable",
        leaseCostHistoryTable: "LeaseCostHistoryTable",
        tableKmsKeyId: "key-123",
        solutionVersion: "1.0.0",
        supportedSchemas: "1",
        cognitoUserPoolId: "us-east-1_abc123",
        cognitoUserPoolArn:
          "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123",
        cognitoAppClientId: "1234567890abcdef",
        cognitoMcpClientId: "fedcba0987654321",
        cognitoIdentityPoolId: "us-east-1:00000000-0000-0000-0000-000000000000",
        cognitoDomain: "test-isb",
        awsAccessPortalUrl: "https://d-0000000000.awsapps.com/start",
        identityPoolAdminRoleName: "test-isb-admin-role",
        identityPoolManagerRoleName: "test-isb-manager-role",
        identityPoolUserRoleName: "test-isb-user-role",
      };

      mockSsmClient.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify(mockConfig),
        },
      });

      const result = await store.get();

      expect(result).toEqual(mockConfig);
    });

    it("should throw error when SSM parameter is not found", async () => {
      mockSsmClient.on(GetParameterCommand).rejects({
        name: "ParameterNotFound",
        message: "Parameter not found",
      });

      await expect(store.get()).rejects.toThrow();
    });

    it("should throw error when config is invalid", async () => {
      mockSsmClient.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify({ invalid: "config" }),
        },
      });

      await expect(store.get()).rejects.toThrow();
    });

    it("should throw error when required fields are missing", async () => {
      const incompleteConfig = {
        configApplicationId: "app-123",
        // Missing other required fields
      };

      mockSsmClient.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify(incompleteConfig),
        },
      });

      await expect(store.get()).rejects.toThrow();
    });
  });
});
