// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SsmAccountPoolStackConfigStore } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

const mockSsmClient = mockClient(SSMClient);

describe("SsmAccountPoolStackConfigStore", () => {
  let store: SsmAccountPoolStackConfigStore;
  let ssmProvider: SSMProvider;

  beforeEach(() => {
    mockSsmClient.reset();
    ssmProvider = new SSMProvider({
      awsSdkV3Client: mockSsmClient as any,
    });
    store = new SsmAccountPoolStackConfigStore({
      parameterArn:
        "arn:aws:ssm:us-east-1:123456789012:parameter/test-account-pool-config",
      ssmProvider,
    });
  });

  describe("get()", () => {
    it("should fetch and parse account pool config from SSM", async () => {
      const mockConfig = {
        sandboxOuId: "ou-sandbox-123",
        availableOuId: "ou-available-123",
        activeOuId: "ou-active-123",
        frozenOuId: "ou-frozen-123",
        cleanupOuId: "ou-cleanup-123",
        quarantineOuId: "ou-quarantine-123",
        entryOuId: "ou-entry-123",
        exitOuId: "ou-exit-123",
        solutionVersion: "1.0.0",
        supportedSchemas: "1",
        isbManagedRegions: "us-east-1,us-west-2",
      };

      mockSsmClient.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify(mockConfig),
        },
      });

      const result = await store.get();

      expect(result).toEqual({
        sandboxOuId: "ou-sandbox-123",
        availableOuId: "ou-available-123",
        activeOuId: "ou-active-123",
        frozenOuId: "ou-frozen-123",
        cleanupOuId: "ou-cleanup-123",
        quarantineOuId: "ou-quarantine-123",
        entryOuId: "ou-entry-123",
        exitOuId: "ou-exit-123",
        solutionVersion: "1.0.0",
        supportedSchemas: "1",
        isbManagedRegions: ["us-east-1", "us-west-2"], // Transformed to array
      });
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
        sandboxOuId: "ou-sandbox-123",
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
