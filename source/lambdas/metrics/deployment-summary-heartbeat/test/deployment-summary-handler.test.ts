// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DeploymentSummaryLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createEventBridgeEvent,
  mockContext,
  mockGlobalConfig,
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

const testEnv = {
  ...generateSchemaData(DeploymentSummaryLambdaEnvironmentSchema),
  SES_IDENTITY_ARN: "arn:aws:ses:us-east-1:111122223333:identity/example.com",
};
const mockedGlobalConfig = mockGlobalConfig();
mockedGlobalConfig.notification.emailFrom = "sender@example.com";
const mockedReportingConfig = {
  costReportGroups: ["test-group"],
  requireCostReportGroup: false,
};

let handler: any;

// The individual collectors are unit-tested in metrics-collectors.test.ts; here
// they are mocked so the test exercises only the handler's orchestration:
// wiring each collector, degrading on failure, and assembling the log payload.
const mockSummarizeAccountPool = vi.fn();
const mockGetScpMetrics = vi.fn();
const mockSummarizeBlueprints = vi.fn();
const mockSummarizeMultiUserLeases = vi.fn();
const mockSummarizePermissionProfiles = vi.fn();
const mockSummarizePredictiveBudget = vi.fn();
const mockSummarizeBedrockTokenMonitoring = vi.fn();
const mockSummarizeSandboxSpaces = vi.fn();
const mockCountM2mClients = vi.fn();
const mockCollectApiCallsByAuthType = vi.fn();
const mockGetNotificationSnsSubscriptionCount = vi.fn();
const mockSummarizeNotificationFailures = vi.fn();

const mockLeaseTemplateStore = { findAll: vi.fn() };
const mockPrincipalStore = {
  listAllAssignments: vi.fn(),
};
const mockLeaseStore = { findByStatus: vi.fn() };

vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});

beforeAll(async () => {
  bulkStubEnv(testEnv);

  const { DynamoConfigStore } =
    await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      leaseTemplateStore: vi.fn().mockReturnValue(mockLeaseTemplateStore),
      blueprintStore: vi.fn().mockReturnValue({}),
      orgsService: vi.fn().mockReturnValue({}),
      configStore: vi.fn(
        () => new DynamoConfigStore({ client: {} as any, tableName: "test" }),
      ),
      accountPoolStackConfigStore: vi
        .fn()
        .mockReturnValue({ get: vi.fn().mockResolvedValue({}) }),
      principalStore: vi.fn().mockReturnValue(mockPrincipalStore),
      leaseStore: vi.fn().mockReturnValue(mockLeaseStore),
    },
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
    IsbClients: {
      cloudFormation: vi.fn().mockReturnValue({}),
      accessAnalyzer: vi.fn().mockReturnValue({}),
      iam: vi.fn().mockReturnValue({}),
      cloudWatch: vi.fn().mockReturnValue({}),
      sns: vi.fn().mockReturnValue({}),
    },
  }));

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/m2m-client-discovery.js",
    () => ({
      countM2mClients: mockCountM2mClients,
    }),
  );

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/api-call-mix.js",
    () => ({
      collectApiCallsByAuthType: mockCollectApiCallsByAuthType,
    }),
  );

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/metrics-collectors.js",
    () => ({
      summarizeAccountPool: mockSummarizeAccountPool,
      getScpMetrics: mockGetScpMetrics,
      summarizeBlueprints: mockSummarizeBlueprints,
      summarizeMultiUserLeases: mockSummarizeMultiUserLeases,
      summarizePermissionProfiles: mockSummarizePermissionProfiles,
      summarizePredictiveBudget: mockSummarizePredictiveBudget,
      summarizeBedrockTokenMonitoring: mockSummarizeBedrockTokenMonitoring,
      getNotificationSnsSubscriptionCount:
        mockGetNotificationSnsSubscriptionCount,
      summarizeNotificationFailures: mockSummarizeNotificationFailures,
      summarizeSandboxSpaces: mockSummarizeSandboxSpaces,
    }),
  );

  const module =
    await import("@amzn/innovation-sandbox-deployment-summary-heartbeat/deployment-summary-handler.js");
  handler = module.handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
  vi.clearAllMocks();

  mockLeaseTemplateStore.findAll.mockResolvedValue({
    result: [
      { leaseTemplateId: "t1", blueprintId: "bp-1" },
      { leaseTemplateId: "t2", blueprintId: undefined },
    ],
    nextPageIdentifier: null,
  });
  mockLeaseStore.findByStatus.mockResolvedValue({
    result: [],
    nextPageIdentifier: null,
  });
  mockPrincipalStore.listAllAssignments.mockResolvedValue({
    result: [],
    nextPageIdentifier: null,
  });
  mockCountM2mClients.mockResolvedValue(0);
  mockSummarizeAccountPool.mockResolvedValue({
    available: 0,
    active: 0,
    frozen: 0,
    cleanup: 0,
    quarantine: 0,
  });
  mockGetScpMetrics.mockResolvedValue({
    additionalAllowedServicesList: [],
    bedrockInferenceProfilePatternsList: [],
  });
  mockSummarizeBlueprints.mockResolvedValue({
    numBlueprints: 0,
    blueprintServiceCounts: {},
  });
  mockSummarizeMultiUserLeases.mockResolvedValue({
    numTemplatesWithSharing: 0,
    numLeasesWithAssignments: 0,
    totalUserAssignments: 0,
    totalGroupAssignments: 0,
    avgAssignmentsPerLease: 0,
    maxAssignmentsPerLease: 0,
  });
  mockCollectApiCallsByAuthType.mockResolvedValue({ m2m: 0, user: 0 });
  mockSummarizePredictiveBudget.mockResolvedValue({
    enabledTemplates: 0,
    enabledActiveLeases: 0,
    rateLimitTemplates: 0,
    rateLimitActiveLeases: 0,
  });
  mockSummarizeBedrockTokenMonitoring.mockResolvedValue({
    enabledTemplates: 0,
    enabledActiveLeases: 0,
  });
  mockSummarizeSandboxSpaces.mockResolvedValue({ enabledActiveLeases: 0 });
  mockSummarizePermissionProfiles.mockResolvedValue({
    numTaggedPermissionSets: 0,
    numAssignmentsWithCustomPermissionSet: 0,
    numLeasesWithCustomPermissionSet: 0,
    maxUniquePermissionSetsPerLease: 0,
    avgUniquePermissionSetsPerLease: 0,
    maxAllowedPermissionSetsPerTemplate: 0,
    avgAllowedPermissionSetsPerTemplate: 0,
    maxAllowedPermissionSetsPerLease: 0,
    avgAllowedPermissionSetsPerLease: 0,
  });
  mockGetNotificationSnsSubscriptionCount.mockResolvedValue(0);
  mockSummarizeNotificationFailures.mockResolvedValue({
    failuresSes: 0,
    failuresSns: 0,
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

  it("assembles the deployment summary from every collector", async () => {
    mockCountM2mClients.mockResolvedValue(7);
    mockSummarizeBlueprints.mockResolvedValue({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 2 },
    });
    mockSummarizeAccountPool.mockResolvedValue({
      available: 5,
      active: 3,
      frozen: 1,
      cleanup: 0,
      quarantine: 2,
    });
    mockGetScpMetrics.mockResolvedValue({
      additionalAllowedServicesList: ["sts:*"],
      bedrockInferenceProfilePatternsList: ["us.*"],
    });
    mockSummarizeMultiUserLeases.mockResolvedValue({
      numTemplatesWithSharing: 1,
      numLeasesWithAssignments: 2,
      totalUserAssignments: 3,
      totalGroupAssignments: 1,
      avgAssignmentsPerLease: 2,
      maxAssignmentsPerLease: 3,
    });
    mockCollectApiCallsByAuthType.mockResolvedValue({ m2m: 4, user: 12 });
    mockSummarizePredictiveBudget.mockResolvedValue({
      enabledTemplates: 1,
      enabledActiveLeases: 2,
      rateLimitTemplates: 1,
      rateLimitActiveLeases: 1,
    });
    mockSummarizeBedrockTokenMonitoring.mockResolvedValue({
      enabledTemplates: 3,
      enabledActiveLeases: 5,
    });
    mockSummarizeSandboxSpaces.mockResolvedValue({ enabledActiveLeases: 4 });
    mockSummarizePermissionProfiles.mockResolvedValue({
      numTaggedPermissionSets: 6,
      numAssignmentsWithCustomPermissionSet: 8,
      numLeasesWithCustomPermissionSet: 3,
      maxUniquePermissionSetsPerLease: 4,
      avgUniquePermissionSetsPerLease: 2.5,
      maxAllowedPermissionSetsPerTemplate: 5,
      avgAllowedPermissionSetsPerTemplate: 2.75,
      maxAllowedPermissionSetsPerLease: 4,
      avgAllowedPermissionSetsPerLease: 2.25,
    });
    mockGetNotificationSnsSubscriptionCount.mockResolvedValue(2);
    mockSummarizeNotificationFailures.mockResolvedValue({
      failuresSes: 1,
      failuresSns: 3,
    });

    await handler(scheduleEvent, mockedContext);

    expect(mockCountM2mClients).toHaveBeenCalledWith(
      expect.anything(),
      testEnv.ISB_NAMESPACE,
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numM2mClients: 7,
        numLeaseTemplates: 2,
        numLeaseTemplatesWithBlueprint: 1,
        numBlueprints: 1,
        blueprintServiceCounts: { S3: 2 },
        // Full config-block assertion: assembling this from globalConfig /
        // reportingConfig is real handler logic (the collectors are mocked), so
        // every field is pinned to its source value.
        config: {
          numCostReportGroups: mockedReportingConfig.costReportGroups.length,
          requireMaxBudget: mockedGlobalConfig.leases.requireMaxBudget,
          maxBudget: mockedGlobalConfig.leases.maxBudget,
          requireMaxDuration: mockedGlobalConfig.leases.requireMaxDuration,
          maxDurationHours: mockedGlobalConfig.leases.maxDurationHours,
          maxLeasesPerUser: mockedGlobalConfig.leases.maxLeasesPerUser,
          requireCostReportGroup: mockedReportingConfig.requireCostReportGroup,
          numberOfFailedAttemptsToCancelCleanup:
            mockedGlobalConfig.cleanup.numberOfFailedAttemptsToCancelCleanup,
          waitBeforeRetryFailedAttemptSeconds:
            mockedGlobalConfig.cleanup.waitBeforeRetryFailedAttemptSeconds,
          numberOfSuccessfulAttemptsToFinishCleanup:
            mockedGlobalConfig.cleanup
              .numberOfSuccessfulAttemptsToFinishCleanup,
          waitBeforeRerunSuccessfulAttemptSeconds:
            mockedGlobalConfig.cleanup.waitBeforeRerunSuccessfulAttemptSeconds,
          isStableTaggingEnabled: testEnv.IS_STABLE_TAGGING_ENABLED === "Yes",
          isMultiAccountDeployment:
            testEnv.ORG_MGT_ACCOUNT_ID !== testEnv.HUB_ACCOUNT_ID,
          allowUserLeaseTermination:
            mockedGlobalConfig.leases.allowUserLeaseTermination,
          leaseRequestWindowHours:
            mockedGlobalConfig.leases.leaseRequestWindowHours,
          maxLeaseRequestsPerWindow:
            mockedGlobalConfig.leases.maxLeaseRequestsPerWindow,
          leaseSharingEnabled: mockedGlobalConfig.leases.leaseSharingEnabled,
          enablePrincipalSearch:
            mockedGlobalConfig.leases.enablePrincipalSearch,
          allowPredictiveBudgetControls:
            mockedGlobalConfig.leases.allowPredictiveBudgetControls,
          serviceBreakdownEnabled:
            mockedGlobalConfig.leases.serviceBreakdownEnabled,
          allowBedrockTokenMonitoring:
            mockedGlobalConfig.leases.allowBedrockTokenMonitoring,
          sandboxSpacesEnabled: mockedGlobalConfig.agent.sandboxSpacesEnabled,
        },
        accountPool: {
          available: 5,
          active: 3,
          frozen: 1,
          cleanup: 0,
          quarantine: 2,
        },
        additionalAllowedServicesList: ["sts:*"],
        bedrockInferenceProfilePatternsList: ["us.*"],
        numTemplatesWithSharing: 1,
        numLeasesWithAssignments: 2,
        totalUserAssignments: 3,
        totalGroupAssignments: 1,
        avgAssignmentsPerLease: 2,
        maxAssignmentsPerLease: 3,
        dailyApiCallsByAuthType: { m2m: 4, user: 12 },
        predictiveBudget: {
          enabledTemplates: 1,
          enabledActiveLeases: 2,
          rateLimitTemplates: 1,
          rateLimitActiveLeases: 1,
        },
        bedrockTokenMonitoring: { enabledTemplates: 3, enabledActiveLeases: 5 },
        sandboxSpaces: { enabledActiveLeases: 4 },
        permissionProfiles: {
          numTaggedPermissionSets: 6,
          numAssignmentsWithCustomPermissionSet: 8,
          numLeasesWithCustomPermissionSet: 3,
          maxUniquePermissionSetsPerLease: 4,
          avgUniquePermissionSetsPerLease: 2.5,
          maxAllowedPermissionSetsPerTemplate: 5,
          avgAllowedPermissionSetsPerTemplate: 2.75,
          maxAllowedPermissionSetsPerLease: 4,
          avgAllowedPermissionSetsPerLease: 2.25,
        },
        notificationSesEnabled: true,
        notificationSnsEnabled:
          mockedGlobalConfig.notification.snsIntegrationTopicEnabled,
        notificationUsingDelegatedSesIdentity: true,
        notificationSnsSubscriptionCount: 2,
        notificationFailuresSes: 1,
        notificationFailuresSns: 3,
      }),
    );
    expect(mockGetNotificationSnsSubscriptionCount).toHaveBeenCalledWith(
      expect.anything(),
      testEnv.NOTIFICATION_TOPIC_ARN,
    );
    expect(mockSummarizeNotificationFailures).toHaveBeenCalledWith(
      expect.anything(),
      testEnv.ISB_NAMESPACE,
    );
    expect(mockSummarizePredictiveBudget).toHaveBeenCalledWith(
      [
        { leaseTemplateId: "t1", blueprintId: "bp-1" },
        { leaseTemplateId: "t2", blueprintId: undefined },
      ],
      expect.anything(),
    );
  });

  it("degrades permission profile metrics to zero counts without sinking the heartbeat", async () => {
    mockSummarizePermissionProfiles.mockRejectedValue(
      new Error("permission profile scan blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        permissionProfiles: {
          numTaggedPermissionSets: 0,
          numAssignmentsWithCustomPermissionSet: 0,
          numLeasesWithCustomPermissionSet: 0,
          maxUniquePermissionSetsPerLease: 0,
          avgUniquePermissionSetsPerLease: 0,
          maxAllowedPermissionSetsPerTemplate: 0,
          avgAllowedPermissionSetsPerTemplate: 0,
          maxAllowedPermissionSetsPerLease: 0,
          avgAllowedPermissionSetsPerLease: 0,
        },
      }),
    );
  });

  it("degrades the predictive budget collector to zero counts without sinking the heartbeat", async () => {
    mockSummarizePredictiveBudget.mockRejectedValue(
      new Error("lease scan blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        predictiveBudget: {
          enabledTemplates: 0,
          enabledActiveLeases: 0,
          rateLimitTemplates: 0,
          rateLimitActiveLeases: 0,
        },
      }),
    );
  });

  it("degrades the Bedrock token monitoring collector to zero counts without sinking the heartbeat", async () => {
    mockSummarizeBedrockTokenMonitoring.mockRejectedValue(
      new Error("lease scan blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        bedrockTokenMonitoring: { enabledTemplates: 0, enabledActiveLeases: 0 },
      }),
    );
  });

  it("reports hub-account SES sending when the delegated identity ARN is empty", async () => {
    bulkStubEnv({ ...testEnv, SES_IDENTITY_ARN: "" });

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        notificationUsingDelegatedSesIdentity: false,
      }),
    );
  });

  it("reports SES disabled when emailFrom is empty", async () => {
    mockAppConfigMiddleware(
      {
        ...mockedGlobalConfig,
        notification: {
          ...mockedGlobalConfig.notification,
          emailFrom: "",
          sesEnabled: true,
        },
      },
      mockedReportingConfig,
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({ notificationSesEnabled: false }),
    );
  });

  it("keeps failure counts when the SNS subscription count fails", async () => {
    mockGetNotificationSnsSubscriptionCount.mockRejectedValue(
      new Error("GetTopicAttributes blew up"),
    );
    mockSummarizeNotificationFailures.mockResolvedValue({
      failuresSes: 2,
      failuresSns: 3,
    });

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("notificationSnsSubscriptionCount"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        notificationSesEnabled: true,
        notificationSnsEnabled:
          mockedGlobalConfig.notification.snsIntegrationTopicEnabled,
        notificationSnsSubscriptionCount: 0,
        notificationFailuresSes: 2,
        notificationFailuresSns: 3,
      }),
    );
  });

  it("keeps the SNS subscription count when failure collection fails", async () => {
    mockGetNotificationSnsSubscriptionCount.mockResolvedValue(4);
    mockSummarizeNotificationFailures.mockRejectedValue(
      new Error("GetMetricData blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("notificationFailures"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        notificationSnsSubscriptionCount: 4,
        notificationFailuresSes: 0,
        notificationFailuresSns: 0,
      }),
    );
  });

  it("degrades the Sandbox Spaces collector to zero counts without sinking the heartbeat", async () => {
    mockSummarizeSandboxSpaces.mockRejectedValue(
      new Error("lease scan blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        sandboxSpaces: { enabledActiveLeases: 0 },
      }),
    );
  });

  it("degrades the api call-mix collector to zero counts without sinking the heartbeat", async () => {
    mockCollectApiCallsByAuthType.mockRejectedValue(
      new Error("GetMetricData blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("dailyApiCallsByAuthType"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        dailyApiCallsByAuthType: { m2m: 0, user: 0 },
      }),
    );
  });

  it("fans out each preloaded table scan to its dependent collectors", async () => {
    const assignments = [
      {
        principalId: "user-1",
        principalType: "USER",
        leaseId: "lease-1",
      },
    ];
    mockPrincipalStore.listAllAssignments.mockResolvedValue({
      result: assignments,
      nextPageIdentifier: null,
    });
    const activeLeases = [{ uuid: "lease-1", sandboxSpacesEnabled: true }];
    mockLeaseStore.findByStatus.mockResolvedValue({
      result: activeLeases,
      nextPageIdentifier: null,
    });

    await handler(scheduleEvent, mockedContext);

    expect(mockSummarizeMultiUserLeases).toHaveBeenCalledWith(
      [
        { leaseTemplateId: "t1", blueprintId: "bp-1" },
        { leaseTemplateId: "t2", blueprintId: undefined },
      ],
      assignments,
    );
    expect(mockSummarizePermissionProfiles).toHaveBeenCalledWith(
      [
        { leaseTemplateId: "t1", blueprintId: "bp-1" },
        { leaseTemplateId: "t2", blueprintId: undefined },
      ],
      assignments,
      activeLeases,
      mockLeaseStore,
      mockPrincipalStore,
      testEnv.USER_PERMISSION_SET_ARN,
    );
    expect(mockSummarizePredictiveBudget).toHaveBeenCalledWith(
      expect.anything(),
      activeLeases,
    );
    expect(mockSummarizeSandboxSpaces).toHaveBeenCalledWith(activeLeases);
    expect(mockPrincipalStore.listAllAssignments).toHaveBeenCalledOnce();
    // One Active-lease scan shared by every collector that needs it.
    expect(mockLeaseStore.findByStatus).toHaveBeenCalledOnce();
    expect(mockLeaseStore.findByStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Active" }),
    );
  });

  it("starts unrelated collectors without waiting for the assignment scan", async () => {
    let resolveAssignments!: (value: {
      result: never[];
      nextPageIdentifier: null;
    }) => void;
    mockPrincipalStore.listAllAssignments.mockReturnValue(
      new Promise((resolve) => {
        resolveAssignments = resolve;
      }),
    );

    const handlerPromise = handler(scheduleEvent, mockedContext);

    await vi.waitFor(() => {
      expect(mockCountM2mClients).toHaveBeenCalledOnce();
      expect(mockSummarizeAccountPool).toHaveBeenCalledOnce();
    });
    expect(mockSummarizeMultiUserLeases).not.toHaveBeenCalled();
    expect(mockSummarizePermissionProfiles).not.toHaveBeenCalled();

    resolveAssignments({ result: [], nextPageIdentifier: null });
    await handlerPromise;

    expect(mockSummarizeMultiUserLeases).toHaveBeenCalledOnce();
    expect(mockSummarizePermissionProfiles).toHaveBeenCalledOnce();
  });

  it("degrades a failing collector to its fallback without sinking the heartbeat", async () => {
    mockSummarizeMultiUserLeases.mockRejectedValue(
      new Error("principals scan blew up"),
    );
    mockCountM2mClients.mockResolvedValue(3);

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("multiUserLeases"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numM2mClients: 3,
        numLeasesWithAssignments: 0,
        totalUserAssignments: 0,
        maxAssignmentsPerLease: 0,
      }),
    );
  });

  it("degrades leaseTemplates and blueprints to zero counts and still emits when they fail", async () => {
    mockLeaseTemplateStore.findAll.mockRejectedValue(
      new Error("lease template table unavailable"),
    );
    mockSummarizeBlueprints.mockRejectedValue(
      new Error("blueprint table unavailable"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("leaseTemplates"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("blueprints"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numLeaseTemplates: 0,
        numLeaseTemplatesWithBlueprint: 0,
        numBlueprints: 0,
      }),
    );
  });
});
