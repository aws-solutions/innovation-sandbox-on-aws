// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfigSchema } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DeploymentSummaryLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createEventBridgeEvent,
  mockContext,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const testEnv = generateSchemaData(DeploymentSummaryLambdaEnvironmentSchema);
const mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);
const mockedReportingConfig = {
  costReportGroups: ["test-group"],
  requireCostReportGroup: false,
};

let handler: any;

const mockLeaseTemplateStore = {
  findAll: vi.fn(),
};

const mockBlueprintStore = {
  listBlueprints: vi.fn(),
  get: vi.fn(),
};

const mockOrgsService = {
  listAllAccountsInOU: vi.fn(),
};

const mockCfnClient = {
  send: vi.fn(),
};

// Mock the logger to avoid console output during tests
vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});

beforeAll(async () => {
  bulkStubEnv(testEnv);

  // Mock IsbServices before importing handler
  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      leaseTemplateStore: vi.fn().mockReturnValue(mockLeaseTemplateStore),
      blueprintStore: vi.fn().mockReturnValue(mockBlueprintStore),
      orgsService: vi.fn().mockReturnValue(mockOrgsService),
    },
  }));

  // Mock IsbClients before importing handler
  vi.doMock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
    IsbClients: {
      cloudFormation: vi.fn().mockReturnValue(mockCfnClient),
    },
  }));

  // Import handler after mocking dependencies
  const module = await import(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/deployment-summary-handler.js"
  );
  handler = module.handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

  // Reset and setup mocks
  vi.clearAllMocks();

  // Setup default mock responses
  mockLeaseTemplateStore.findAll.mockResolvedValue({
    result: [{ leaseTemplateId: "template-1", name: "Test Template" }],
    nextPageIdentifier: null,
  });

  mockBlueprintStore.listBlueprints.mockResolvedValue({
    result: [
      {
        blueprint: {
          blueprintId: "blueprint-1",
          name: "Test Blueprint",
        },
        stackSets: [],
        deploymentHistory: [],
      },
    ],
    nextPageIdentifier: null,
  });

  mockBlueprintStore.get.mockResolvedValue({
    result: {
      blueprint: {
        blueprintId: "blueprint-1",
        name: "Test Blueprint",
      },
      stackSets: [{ stackSetId: "stack-set-1" }],
      deploymentHistory: [],
    },
  });

  mockOrgsService.listAllAccountsInOU.mockResolvedValue([]);

  mockCfnClient.send.mockResolvedValue({
    ResourceTypes: ["AWS::S3::Bucket", "AWS::Lambda::Function"],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("deployment-summary-handler", () => {
  const mockedContext = mockContext(testEnv);
  const scheduleEvent = createEventBridgeEvent("Scheduled Event", {});

  it("should successfully execute summarizeDeployment", async () => {
    await handler(scheduleEvent, mockedContext);

    expect(mockLeaseTemplateStore.findAll).toHaveBeenCalled();
    expect(mockBlueprintStore.listBlueprints).toHaveBeenCalled();
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numLeaseTemplates: expect.any(Number),
        numBlueprints: expect.any(Number),
      }),
    );
  });

  it("should correctly call summarizeAccountPool", async () => {
    mockOrgsService.listAllAccountsInOU
      .mockResolvedValueOnce([{ accountId: "111111111111" }] as any)
      .mockResolvedValueOnce([{ accountId: "222222222222" }] as any)
      .mockResolvedValueOnce([{ accountId: "333333333333" }] as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await handler(scheduleEvent, mockedContext);

    expect(mockOrgsService.listAllAccountsInOU).toHaveBeenCalledWith(
      "Available",
    );
    expect(mockOrgsService.listAllAccountsInOU).toHaveBeenCalledWith("Active");
    expect(mockOrgsService.listAllAccountsInOU).toHaveBeenCalledWith("Frozen");
    expect(mockOrgsService.listAllAccountsInOU).toHaveBeenCalledWith("CleanUp");
    expect(mockOrgsService.listAllAccountsInOU).toHaveBeenCalledWith(
      "Quarantine",
    );
  });

  it("should correctly count services in getBlueprintServiceCounts", async () => {
    mockCfnClient.send.mockResolvedValue({
      ResourceTypes: [
        "AWS::S3::Bucket",
        "AWS::S3::Bucket",
        "AWS::Lambda::Function",
      ],
    });

    await handler(scheduleEvent, mockedContext);

    expect(mockBlueprintStore.get).toHaveBeenCalledWith("blueprint-1");
    expect(mockCfnClient.send).toHaveBeenCalled();
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        blueprintServiceCounts: expect.objectContaining({
          S3: 2,
          Lambda: 1,
        }),
      }),
    );
  });

  it("should return empty object when there are no blueprints", async () => {
    mockBlueprintStore.listBlueprints.mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        numBlueprints: 0,
        blueprintServiceCounts: {},
      }),
    );
  });

  it("should include all expected fields in deployment summary", async () => {
    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numLeaseTemplates: 1,
        numLeaseTemplatesWithBlueprint: 0,
        numBlueprints: 1,
        blueprintServiceCounts: expect.any(Object),
        config: expect.objectContaining({
          numCostReportGroups: 1,
          requireMaxBudget: expect.any(Boolean),
          maxBudget: expect.any(Number),
          requireMaxDuration: expect.any(Boolean),
          maxDurationHours: expect.any(Number),
          maxLeasesPerUser: expect.any(Number),
          requireCostReportGroup: false,
          numberOfFailedAttemptsToCancelCleanup: expect.any(Number),
          waitBeforeRetryFailedAttemptSeconds: expect.any(Number),
          numberOfSuccessfulAttemptsToFinishCleanup: expect.any(Number),
          waitBeforeRerunSuccessfulAttemptSeconds: expect.any(Number),
          isStableTaggingEnabled: expect.any(Boolean),
          isMultiAccountDeployment: expect.any(Boolean),
        }),
        accountPool: expect.objectContaining({
          available: 0,
          active: 0,
          frozen: 0,
          cleanup: 0,
          quarantine: 0,
        }),
      }),
    );
  });
});
