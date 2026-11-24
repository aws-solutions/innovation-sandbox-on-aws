// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccessAnalyzerClient,
  ValidatePolicyCommand,
} from "@aws-sdk/client-accessanalyzer";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getNotificationSnsSubscriptionCount,
  getScpMetrics,
  summarizeAccountPool,
  summarizeBedrockTokenMonitoring,
  summarizeBlueprints,
  summarizeMultiUserLeases,
  summarizeNotificationFailures,
  summarizePermissionProfiles,
  summarizePredictiveBudget,
  summarizeSandboxSpaces,
} from "@amzn/innovation-sandbox-deployment-summary-heartbeat/metrics-collectors.js";

function fakeLogger() {
  return { warn: vi.fn() } as unknown as Logger;
}

const accountPoolConfig = {
  additionalAllowedServices: undefined,
  bedrockInferenceProfilePatterns: undefined,
} as any;

describe("summarizeAccountPool", () => {
  it("counts accounts in each OU status", async () => {
    const listAllAccountsInOU = vi
      .fn()
      .mockResolvedValueOnce([{ id: "1" }]) // Available
      .mockResolvedValueOnce([{ id: "2" }, { id: "3" }]) // Active
      .mockResolvedValueOnce([]) // Frozen
      .mockResolvedValueOnce([{ id: "4" }]) // CleanUp
      .mockResolvedValueOnce([]); // Quarantine

    await expect(
      summarizeAccountPool({ listAllAccountsInOU } as any),
    ).resolves.toEqual({
      available: 1,
      active: 2,
      frozen: 0,
      cleanup: 1,
      quarantine: 0,
    });
  });
});

describe("getScpMetrics", () => {
  const accessAnalyzerMock = mockClient(AccessAnalyzerClient);

  beforeEach(() => {
    accessAnalyzerMock.reset();
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({ findings: [] });
  });

  it("returns validated services and parsed bedrock patterns", async () => {
    const result = await getScpMetrics(
      fakeLogger(),
      {
        additionalAllowedServices: "sts:*,support:*,tag:*",
        bedrockInferenceProfilePatterns:
          "arn:aws:bedrock:*:*:inference-profile/*,arn:aws:bedrock:*:*:inference-profile/us.*",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result).toEqual({
      additionalAllowedServicesList: ["sts:*", "support:*", "tag:*"],
      bedrockInferenceProfilePatternsList: ["*", "us.*"],
    });
  });

  it("returns empty lists when config fields are absent", async () => {
    await expect(
      getScpMetrics(
        fakeLogger(),
        accountPoolConfig,
        accessAnalyzerMock as unknown as AccessAnalyzerClient,
      ),
    ).resolves.toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("filters out actions AccessAnalyzer reports as invalid", async () => {
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({
      findings: [
        {
          issueCode: "INVALID_SERVICE_IN_ACTION",
          findingType: "ERROR" as const,
          findingDetails:
            "The service fakesvc:fakeAction specified in the action does not exist.",
          learnMoreLink: undefined,
          locations: [
            {
              path: [
                { value: "Statement" },
                { index: 0 },
                { value: "Action" },
                { index: 1 },
              ],
              span: {
                start: { line: 0, column: 0, offset: 0 },
                end: { line: 0, column: 0, offset: 0 },
              },
            },
          ],
        },
      ],
    });

    const result = await getScpMetrics(
      fakeLogger(),
      { additionalAllowedServices: "sts:*,fakesvc:fakeAction" } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result.additionalAllowedServicesList).toEqual(["sts:*"]);
  });

  it("filters out actions reported as INVALID_ACTION", async () => {
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({
      findings: [
        {
          issueCode: "INVALID_ACTION",
          findingType: "ERROR" as const,
          findingDetails: "The action s3:DoSomething does not exist.",
          learnMoreLink: undefined,
          locations: [
            {
              path: [
                { value: "Statement" },
                { index: 0 },
                { value: "Action" },
                { index: 1 },
              ],
              span: {
                start: { line: 0, column: 0, offset: 0 },
                end: { line: 0, column: 0, offset: 0 },
              },
            },
          ],
        },
      ],
    });

    const result = await getScpMetrics(
      fakeLogger(),
      { additionalAllowedServices: "sts:*,s3:DoSomething" } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result.additionalAllowedServicesList).toEqual(["sts:*"]);
  });

  it("returns empty lists when config fields are empty strings", async () => {
    await expect(
      getScpMetrics(
        fakeLogger(),
        {
          additionalAllowedServices: "",
          bedrockInferenceProfilePatterns: "",
        } as any,
        accessAnalyzerMock as unknown as AccessAnalyzerClient,
      ),
    ).resolves.toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("handles a mix of populated and empty config fields", async () => {
    const result = await getScpMetrics(
      fakeLogger(),
      {
        additionalAllowedServices: "bedrock:*",
        bedrockInferenceProfilePatterns: "",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result).toEqual({
      additionalAllowedServicesList: ["bedrock:*"],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("falls back to an empty allowed-services list and warns when AccessAnalyzer fails", async () => {
    accessAnalyzerMock
      .on(ValidatePolicyCommand)
      .rejects(new Error("AccessDenied: User is not authorized"));
    const logger = fakeLogger();

    const result = await getScpMetrics(
      logger,
      {
        additionalAllowedServices: "sts:*,support:*",
        bedrockInferenceProfilePatterns:
          "arn:aws:bedrock:*:*:inference-profile/us.*",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    // additionalAllowedServicesList drops to [], but the bedrock patterns
    // (which make no API call) survive — the failure is isolated.
    expect(result).toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: ["us.*"],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to validate IAM actions, skipping additionalAllowedServicesList metric",
      expect.objectContaining({
        error: "AccessDenied: User is not authorized",
      }),
    );
  });
});

describe("summarizeBlueprints", () => {
  // blueprintStore.listBlueprints is consumed via collect(stream(...)); it
  // returns one page of blueprints and no next page.
  function listBlueprintsOnce(blueprints: unknown[]) {
    return vi
      .fn()
      .mockResolvedValue({ result: blueprints, nextPageIdentifier: null });
  }

  it("counts blueprints and aggregates resource-type counts across stack sets", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([
        { blueprint: { blueprintId: "bp-1" } },
      ]),
      get: vi.fn().mockResolvedValue({
        result: { stackSets: [{ stackSetId: "ss-1" }] },
      }),
    } as any;
    const cfnClient = {
      send: vi.fn().mockResolvedValue({
        ResourceTypes: [
          "AWS::S3::Bucket",
          "AWS::S3::Bucket",
          "AWS::Lambda::Function",
        ],
      }),
    } as any;

    await expect(
      summarizeBlueprints(fakeLogger(), blueprintStore, cfnClient),
    ).resolves.toEqual({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 2, Lambda: 1 },
    });
  });

  it("returns zero counts when there are no blueprints", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([]),
      get: vi.fn(),
    } as any;

    await expect(
      summarizeBlueprints(fakeLogger(), blueprintStore, {
        send: vi.fn(),
      } as any),
    ).resolves.toEqual({ numBlueprints: 0, blueprintServiceCounts: {} });
  });

  it("skips a StackSet that fails to describe and warns, keeping the rest", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([
        { blueprint: { blueprintId: "bp-1" } },
      ]),
      get: vi.fn().mockResolvedValue({
        result: {
          stackSets: [{ stackSetId: "ss-ok" }, { stackSetId: "ss-bad" }],
        },
      }),
    } as any;
    const cfnClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ ResourceTypes: ["AWS::S3::Bucket"] })
        .mockRejectedValueOnce(new Error("AccessDenied")),
    } as any;
    const logger = fakeLogger();

    await expect(
      summarizeBlueprints(logger, blueprintStore, cfnClient),
    ).resolves.toEqual({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 1 },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to analyze StackSet",
      expect.objectContaining({ stackSetId: "ss-bad" }),
    );
  });
});

describe("summarizeMultiUserLeases", () => {
  it("computes sharing-template, assignment, and per-lease metrics", async () => {
    const leaseTemplates = [
      { allowOwnerToShareLease: true },
      { allowOwnerToShareLease: true },
      { allowOwnerToShareLease: false },
    ] as any;
    // lease-10 has 3 user assignments, lease-20 has 1 group assignment.
    const assignments = [
      { principalType: "USER", leaseId: "lease-10" },
      { principalType: "USER", leaseId: "lease-10" },
      { principalType: "USER", leaseId: "lease-10" },
      { principalType: "GROUP", leaseId: "lease-20" },
    ] as any;

    await expect(
      summarizeMultiUserLeases(leaseTemplates, assignments),
    ).resolves.toEqual({
      numTemplatesWithSharing: 2,
      numLeasesWithAssignments: 2,
      totalUserAssignments: 3,
      totalGroupAssignments: 1,
      avgAssignmentsPerLease: 2,
      maxAssignmentsPerLease: 3,
    });
  });

  it("returns zeros when there are no assignments", async () => {
    await expect(summarizeMultiUserLeases([], [])).resolves.toEqual({
      numTemplatesWithSharing: 0,
      numLeasesWithAssignments: 0,
      totalUserAssignments: 0,
      totalGroupAssignments: 0,
      avgAssignmentsPerLease: 0,
      maxAssignmentsPerLease: 0,
    });
  });
});

describe("summarizePermissionProfiles", () => {
  const builtInPermissionSetArn =
    "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000001";
  const customPermissionSetArnA =
    "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000002";
  const customPermissionSetArnB =
    "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000003";

  it("calculates all adoption metrics with distinct per-lease permission-set counts", async () => {
    const leaseTemplates = [
      { allowedPermissionSetArns: [builtInPermissionSetArn] },
      {
        allowedPermissionSetArns: [
          builtInPermissionSetArn,
          customPermissionSetArnA,
          customPermissionSetArnB,
        ],
      },
      {},
    ] as any;
    const assignments = [
      {
        leaseId: "00000000-0000-4000-8000-000000000001",
        permissionSetArn: customPermissionSetArnA,
      },
      {
        leaseId: "00000000-0000-4000-8000-000000000001",
        permissionSetArn: customPermissionSetArnA,
      },
      {
        leaseId: "00000000-0000-4000-8000-000000000001",
        permissionSetArn: customPermissionSetArnB,
      },
      {
        leaseId: "00000000-0000-4000-8000-000000000002",
        permissionSetArn: builtInPermissionSetArn,
      },
      {
        leaseId: "00000000-0000-4000-8000-000000000002",
      },
      {
        leaseId: "00000000-0000-4000-8000-000000000099",
        permissionSetArn: customPermissionSetArnB,
      },
    ] as any;
    const activeLeases = [
      {
        uuid: "00000000-0000-4000-8000-000000000001",
        allowedPermissionSetArns: [
          builtInPermissionSetArn,
          customPermissionSetArnA,
        ],
      },
    ] as any;
    const findByStatus = vi.fn().mockResolvedValueOnce({
      result: [
        {
          uuid: "00000000-0000-4000-8000-000000000002",
          defaultPermissionSetArn: builtInPermissionSetArn,
          desiredAssignments: [
            {
              permissionSetArn: customPermissionSetArnB,
            },
            {},
          ],
          allowedPermissionSetArns: [
            builtInPermissionSetArn,
            customPermissionSetArnA,
            customPermissionSetArnB,
          ],
        },
        {
          uuid: "00000000-0000-4000-8000-000000000003",
        },
      ],
      nextPageIdentifier: null,
    });

    await expect(
      summarizePermissionProfiles(
        leaseTemplates,
        assignments,
        activeLeases,
        { findByStatus } as any,
        {
          getPermissionSetCacheItems: vi
            .fn()
            .mockResolvedValue([{}, {}, {}, {}]),
        } as any,
        builtInPermissionSetArn,
      ),
    ).resolves.toEqual({
      numTaggedPermissionSets: 4,
      numAssignmentsWithCustomPermissionSet: 4,
      numLeasesWithCustomPermissionSet: 2,
      maxUniquePermissionSetsPerLease: 2,
      avgUniquePermissionSetsPerLease: 1.33,
      maxAllowedPermissionSetsPerTemplate: 3,
      avgAllowedPermissionSetsPerTemplate: 1.33,
      maxAllowedPermissionSetsPerLease: 3,
      avgAllowedPermissionSetsPerLease: 1.67,
    });

    // Active leases are shared with other collectors; only Frozen is read here.
    expect(findByStatus).toHaveBeenCalledOnce();
    expect(findByStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Frozen" }),
    );
  });

  it("measures desired-state adoption and uses records only for legacy leases", async () => {
    const activeLeases = [
      {
        uuid: "00000000-0000-4000-8000-000000000001",
        desiredAssignments: [{ permissionSetArn: customPermissionSetArnA }],
      },
      {
        uuid: "00000000-0000-4000-8000-000000000002",
        desiredAssignments: [],
      },
      {
        uuid: "00000000-0000-4000-8000-000000000003",
      },
    ];
    const frozenLeases = [
      {
        uuid: "00000000-0000-4000-8000-000000000004",
        desiredAssignments: [{ permissionSetArn: customPermissionSetArnB }],
      },
    ];
    const assignments = [
      // An explicitly empty desired state wins over this stale physical record.
      {
        leaseId: activeLeases[1]!.uuid,
        permissionSetArn: customPermissionSetArnA,
      },
      // A pre-v1.4 lease without desired state falls back to physical records.
      {
        leaseId: activeLeases[2]!.uuid,
        permissionSetArn: customPermissionSetArnB,
      },
    ] as any;
    const findByStatus = vi.fn().mockResolvedValueOnce({
      result: frozenLeases,
      nextPageIdentifier: null,
    });

    await expect(
      summarizePermissionProfiles(
        [],
        assignments,
        activeLeases as any,
        { findByStatus } as any,
        {
          getPermissionSetCacheItems: vi.fn().mockResolvedValue([]),
        } as any,
        builtInPermissionSetArn,
      ),
    ).resolves.toEqual({
      numTaggedPermissionSets: 0,
      numAssignmentsWithCustomPermissionSet: 2,
      numLeasesWithCustomPermissionSet: 3,
      maxUniquePermissionSetsPerLease: 1,
      avgUniquePermissionSetsPerLease: 0.75,
      maxAllowedPermissionSetsPerTemplate: 0,
      avgAllowedPermissionSetsPerTemplate: 0,
      maxAllowedPermissionSetsPerLease: 0,
      avgAllowedPermissionSetsPerLease: 0,
    });
  });

  it("returns zero maxima and averages for empty populations", async () => {
    const findByStatus = vi
      .fn()
      .mockResolvedValue({ result: [], nextPageIdentifier: null });

    await expect(
      summarizePermissionProfiles(
        [],
        [],
        [],
        { findByStatus } as any,
        {
          getPermissionSetCacheItems: vi.fn().mockResolvedValue([]),
        } as any,
        builtInPermissionSetArn,
      ),
    ).resolves.toEqual({
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
  });
});

describe("summarizePredictiveBudget", () => {
  it("counts the templates that opt in and the active leases carrying the opt-in", () => {
    const leaseTemplates = [
      { predictiveBudgetEnabled: true },
      { predictiveBudgetEnabled: false },
      {},
    ] as any;
    const activeLeases = [
      { uuid: "l1", predictiveBudgetEnabled: true },
      { uuid: "l2", predictiveBudgetEnabled: false },
      { uuid: "l3", predictiveBudgetEnabled: true },
      { uuid: "l4" },
    ] as any;

    expect(summarizePredictiveBudget(leaseTemplates, activeLeases)).toEqual({
      enabledTemplates: 1,
      enabledActiveLeases: 2,
      rateLimitTemplates: 0,
      rateLimitActiveLeases: 0,
    });
  });

  it("counts rate limits only where predictive budget is on, since they fire only there", () => {
    const limit = { basis: "HOURLY", rate: 5, action: "ALERT" };
    const leaseTemplates = [
      { predictiveBudgetEnabled: true, rateLimits: [limit] },
      { predictiveBudgetEnabled: true, rateLimits: [] },
      { predictiveBudgetEnabled: false, rateLimits: [limit] },
    ] as any;
    const activeLeases = [
      { uuid: "l1", predictiveBudgetEnabled: true, rateLimits: [limit] },
      { uuid: "l2", predictiveBudgetEnabled: true },
      { uuid: "l3", rateLimits: [limit] },
    ] as any;

    expect(summarizePredictiveBudget(leaseTemplates, activeLeases)).toEqual({
      enabledTemplates: 2,
      enabledActiveLeases: 2,
      rateLimitTemplates: 1,
      rateLimitActiveLeases: 1,
    });
  });

  it("returns zeros when nothing has opted in", () => {
    expect(summarizePredictiveBudget([], [])).toEqual({
      enabledTemplates: 0,
      enabledActiveLeases: 0,
      rateLimitTemplates: 0,
      rateLimitActiveLeases: 0,
    });
  });
});

describe("summarizeBedrockTokenMonitoring", () => {
  it("counts a Sandbox Spaces template as monitored, and only leases whose snapshot says so", () => {
    const leaseTemplates = [
      { bedrockTokenMonitoringEnabled: true, sandboxSpacesEnabled: false },
      { bedrockTokenMonitoringEnabled: false, sandboxSpacesEnabled: true },
      { bedrockTokenMonitoringEnabled: false, sandboxSpacesEnabled: false },
    ] as any;
    const activeLeases = [
      { uuid: "l1", bedrockTokenMonitoringEnabled: true },
      { uuid: "l2", bedrockTokenMonitoringEnabled: false },
      { uuid: "l3" },
    ] as any;

    expect(
      summarizeBedrockTokenMonitoring(leaseTemplates, activeLeases),
    ).toEqual({ enabledTemplates: 2, enabledActiveLeases: 1 });
  });
});

describe("notification delivery metrics", () => {
  const ISB_NAMESPACE = "test-isb";
  const TOPIC_ARN = "arn:aws:sns:us-east-1:111122223333:ISB-test-Notification";
  const snsMock = mockClient(SNSClient);
  const cloudWatchMock = mockClient(CloudWatchClient);

  beforeEach(() => {
    snsMock.reset();
    cloudWatchMock.reset();
  });

  it("reports the confirmed SNS subscription count", async () => {
    snsMock.on(GetTopicAttributesCommand).resolves({
      Attributes: { SubscriptionsConfirmed: "3", SubscriptionsPending: "9" },
    });

    await expect(
      getNotificationSnsSubscriptionCount(new SNSClient({}), TOPIC_ARN),
    ).resolves.toBe(3);
    expect(
      snsMock.commandCalls(GetTopicAttributesCommand)[0]?.args[0].input,
    ).toEqual({ TopicArn: TOPIC_ARN });
  });

  it("normalizes a missing subscription count to zero", async () => {
    snsMock.on(GetTopicAttributesCommand).resolves({ Attributes: {} });

    await expect(
      getNotificationSnsSubscriptionCount(new SNSClient({}), TOPIC_ARN),
    ).resolves.toBe(0);
  });

  it("reports per-channel failure sums", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "ses", Values: [2, 1] },
        { Id: "sns", Values: [4] },
      ],
    });

    await expect(
      summarizeNotificationFailures(new CloudWatchClient({}), ISB_NAMESPACE),
    ).resolves.toEqual({ failuresSes: 3, failuresSns: 4 });
  });

  it("normalizes each missing channel result independently", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [{ Id: "sns", Values: [4] }],
    });

    await expect(
      summarizeNotificationFailures(new CloudWatchClient({}), ISB_NAMESPACE),
    ).resolves.toEqual({ failuresSes: 0, failuresSns: 4 });
  });

  it("queries NotificationFailed once per channel over the previous UTC day", async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    await summarizeNotificationFailures(
      new CloudWatchClient({}),
      ISB_NAMESPACE,
    );

    const metricCalls = cloudWatchMock.commandCalls(GetMetricDataCommand);
    expect(metricCalls).toHaveLength(1);
    const input = metricCalls[0]!.args[0].input;
    expect(input.MetricDataQueries).toEqual([
      expect.objectContaining({
        Id: "ses",
        MetricStat: expect.objectContaining({
          Metric: {
            Namespace: "ISB/Notifications",
            MetricName: "NotificationFailed",
            Dimensions: [
              { Name: "ISBNamespace", Value: ISB_NAMESPACE },
              { Name: "Channel", Value: "SES" },
            ],
          },
          Period: 86_400,
          Stat: "Sum",
        }),
      }),
      expect.objectContaining({
        Id: "sns",
        MetricStat: expect.objectContaining({
          Metric: expect.objectContaining({
            Dimensions: [
              { Name: "ISBNamespace", Value: ISB_NAMESPACE },
              { Name: "Channel", Value: "SNS" },
            ],
          }),
        }),
      }),
    ]);
    expect(input.EndTime!.getTime() % 86_400_000).toBe(0);
    expect(input.EndTime!.getTime() - input.StartTime!.getTime()).toBe(
      86_400_000,
    );
  });
});

describe("summarizeSandboxSpaces", () => {
  it("counts the active leases with Sandbox Spaces enabled", () => {
    const activeLeases = [
      { uuid: "l1", sandboxSpacesEnabled: true },
      { uuid: "l2", sandboxSpacesEnabled: false },
      { uuid: "l3", sandboxSpacesEnabled: true },
    ] as any;

    expect(summarizeSandboxSpaces(activeLeases)).toEqual({
      enabledActiveLeases: 2,
    });
  });
});
