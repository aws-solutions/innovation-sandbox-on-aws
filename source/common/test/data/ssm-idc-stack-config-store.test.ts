// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SsmIdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

const mockSsmClient = mockClient(SSMClient);

describe("SsmIdcStackConfigStore", () => {
  let store: SsmIdcStackConfigStore;
  let ssmProvider: SSMProvider;

  beforeEach(() => {
    mockSsmClient.reset();
    ssmProvider = new SSMProvider({
      awsSdkV3Client: mockSsmClient as any,
    });
    store = new SsmIdcStackConfigStore({
      parameterArn:
        "arn:aws:ssm:us-east-1:123456789012:parameter/test-idc-config",
      ssmProvider,
    });
  });

  describe("get()", () => {
    it("should fetch and parse IDC config from SSM", async () => {
      const mockConfig = {
        identityStoreId: "d-1234567890",
        ssoInstanceArn: "arn:aws:sso:::instance/ssoins-123456789012",
        adminGroupId: "admin-group-id",
        managerGroupId: "manager-group-id",
        userGroupId: "user-group-id",
        adminPermissionSetArn:
          "arn:aws:sso:::permissionSet/ssoins-123/ps-admin",
        managerPermissionSetArn:
          "arn:aws:sso:::permissionSet/ssoins-123/ps-manager",
        userPermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-user",
        solutionVersion: "1.0.0",
        supportedSchemas: "1",
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
        identityStoreId: "d-1234567890",
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
