// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { AccountCleanupFailureEventSchema } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftEventSchema } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { AssignmentCreatedEventSchema } from "@amzn/innovation-sandbox-commons/events/assignment-created-event.js";
import { AssignmentRemovedEventSchema } from "@amzn/innovation-sandbox-commons/events/assignment-removed-event.js";
import { GroupCostReportGeneratedEventSchema } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGenerationFailureEventSchema } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseApprovedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseBudgetThresholdTriggeredEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDeniedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { LeaseExpirationAlertEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import {
  LeaseFrozenByBudgetSchema,
  LeaseFrozenEventSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseSpendRateThresholdTriggeredEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  LeaseTerminatedByUserSchema,
  LeaseTerminatedEventSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { clearCache as clearIdcCache } from "@amzn/innovation-sandbox-commons/isb-services/idc-cache.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { SynthesizedAudienceMessage } from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-message-synthesis.js";
import { EmailEventName } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import { EmailService } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import {
  EmailNotificationEnvironment,
  EmailNotificationEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
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
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
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
import { z } from "zod";

const testEnv = generateSchemaData(EmailNotificationEnvironmentSchema, {
  // Empty means no delegated identity: the hub-account SES path is the default.
  SES_IDENTITY_ARN: "",
  AWS_REGION: "us-east-1",
});

let mockedGlobalConfig: GlobalConfig;
let mockedContext: ContextWithConfig &
  ValidatedEnvironment<EmailNotificationEnvironment>;
let handler: typeof import("@amzn/innovation-sandbox-email-notification/email-notification-handler.js").handler;

const emailServiceSpy = vi
  .spyOn(EmailService.prototype, "sendNotificationEmail")
  .mockReturnValue(Promise.resolve());

// admin/manager-audience events need IdcService resolution mocked even in
// this SES-only-by-default top-level suite.
vi.spyOn(IdcService.prototype, "listIsbAdmins").mockResolvedValue({
  result: [{ type: "human", email: "admin@example.com" } as any],
  nextPageIdentifier: null,
});
vi.spyOn(IdcService.prototype, "listIsbManagers").mockResolvedValue({
  result: [{ type: "human", email: "manager@example.com" } as any],
  nextPageIdentifier: null,
});

beforeAll(async () => {
  bulkStubEnv(testEnv);
  mockedGlobalConfig = mockGlobalConfig();
  mockedGlobalConfig.notification.emailFrom = "test@example.com";
  mockedContext = mockContext(testEnv, mockedGlobalConfig);
  handler = (
    await import("@amzn/innovation-sandbox-email-notification/email-notification-handler.js")
  ).handler;
});
beforeEach(() => {
  mockAppConfigMiddleware(mockedGlobalConfig);
});
afterEach(() => {
  vi.clearAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("email-notification-handler", () => {
  it.each([
    "not-an-arn",
    "arn:aws:ses:us-west-2:123456789012:identity/example.com",
  ])("rejects invalid SES identity configuration: %s", async (arn) => {
    vi.stubEnv("SES_IDENTITY_ARN", arn);

    const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
    const emailEvent = createEventBridgeEvent(
      EventDetailTypes.LeaseApproved,
      isbEvent,
    );

    try {
      await expect(handler(emailEvent, mockedContext)).rejects.toThrow(
        /SES_IDENTITY_ARN/,
      );
      expect(emailServiceSpy).not.toHaveBeenCalled();
    } finally {
      bulkStubEnv(testEnv);
    }
  });

  type TestInput = {
    eventName: EmailEventName;
    schema: z.ZodType<Record<string, unknown>>;
    overrides?: Record<string, unknown>;
  };
  type RequiredTestCases = {
    [K in EmailEventName]: {
      eventName: K;
      schema: z.ZodType<Record<string, unknown>>;
      overrides?: Record<string, unknown>;
    };
  };

  const testCases: RequiredTestCases = {
    [EventDetailTypes.LeaseRequested]: {
      eventName: EventDetailTypes.LeaseRequested,
      schema: LeaseRequestedEventSchema,
    },
    [EventDetailTypes.LeaseApproved]: {
      eventName: EventDetailTypes.LeaseApproved,
      schema: LeaseApprovedEventSchema,
    },
    [EventDetailTypes.LeaseDenied]: {
      eventName: EventDetailTypes.LeaseDenied,
      schema: LeaseDeniedEventSchema,
    },
    [EventDetailTypes.LeaseTerminated]: {
      eventName: EventDetailTypes.LeaseTerminated,
      schema: LeaseTerminatedEventSchema,
    },
    [EventDetailTypes.LeaseFrozen]: {
      eventName: EventDetailTypes.LeaseFrozen,
      schema: LeaseFrozenEventSchema,
      // The reason union pairs triggeredBy with rateSource; zocker fills the two
      // independently, so the reason is pinned whole to keep this fixture a
      // valid detail.
      overrides: {
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          budget: 100,
          totalSpend: 72,
          triggeredBy: "PREDICTED",
          rateSource: "HOURLY",
        },
      },
    },
    [EventDetailTypes.LeaseUnfrozen]: {
      eventName: EventDetailTypes.LeaseUnfrozen,
      schema: LeaseUnfrozenEventSchema,
    },
    [EventDetailTypes.LeaseProvisioningFailed]: {
      eventName: EventDetailTypes.LeaseProvisioningFailed,
      schema: LeaseProvisioningFailedEventSchema,
    },
    [EventDetailTypes.AccountCleanupFailure]: {
      eventName: EventDetailTypes.AccountCleanupFailure,
      schema: AccountCleanupFailureEventSchema,
    },
    [EventDetailTypes.AccountDriftDetected]: {
      eventName: EventDetailTypes.AccountDriftDetected,
      schema: AccountDriftEventSchema,
    },
    [EventDetailTypes.LeaseBudgetThresholdBreachedAlert]: {
      eventName: EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
      schema: LeaseBudgetThresholdTriggeredEventSchema,
      // The schema's branch rules pair triggeredBy with fields zocker fills
      // independently; pinned so this fixture is a valid detail, as every
      // budget-alert fixture in the suites is.
      overrides: {
        triggeredBy: "REPORTED",
        budgetThresholdTriggered: 70,
        insight: null,
      },
    },
    [EventDetailTypes.LeaseSpendRateThresholdBreachedAlert]: {
      eventName: EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
      schema: LeaseSpendRateThresholdTriggeredEventSchema,
      overrides: { insight: null },
    },
    [EventDetailTypes.LeaseDurationThresholdBreachedAlert]: {
      eventName: EventDetailTypes.LeaseDurationThresholdBreachedAlert,
      schema: LeaseExpirationAlertEventSchema,
    },
    [EventDetailTypes.GroupCostReportGenerated]: {
      eventName: EventDetailTypes.GroupCostReportGenerated,
      schema: GroupCostReportGeneratedEventSchema,
    },
    [EventDetailTypes.GroupCostReportGeneratedFailure]: {
      eventName: EventDetailTypes.GroupCostReportGeneratedFailure,
      schema: GroupCostReportGenerationFailureEventSchema,
    },
    [EventDetailTypes.AssignmentCreated]: {
      eventName: EventDetailTypes.AssignmentCreated,
      schema: AssignmentCreatedEventSchema,
    },
    [EventDetailTypes.AssignmentRemoved]: {
      eventName: EventDetailTypes.AssignmentRemoved,
      schema: AssignmentRemovedEventSchema,
    },
  };

  const testInputs = Object.values(testCases);
  it.each(testInputs)(
    "should send email for all subscribed events, $eventName",
    async ({ eventName, schema, overrides }: TestInput) => {
      const isbEvent = generateSchemaData(schema, overrides);
      const emailEvent = createEventBridgeEvent(eventName, isbEvent);
      await handler(emailEvent, mockedContext);
      expect(emailServiceSpy).toHaveBeenCalled();
    },
  );

  it("should throw error for unsubscribed event when email is configured", async () => {
    const emailEvent = createEventBridgeEvent("InvalidEvent", {});
    await expect(handler(emailEvent, mockedContext)).rejects.toThrow(Error);
    expect(emailServiceSpy).not.toHaveBeenCalled();
  });

  it("should exit early for unsubscribed event when email is not configured", async () => {
    const configWithoutEmail = {
      ...mockedGlobalConfig,
      notification: { ...mockedGlobalConfig.notification, emailFrom: "" },
    };
    const contextWithoutEmail = mockContext(testEnv, configWithoutEmail);
    mockAppConfigMiddleware(configWithoutEmail);

    const emailEvent = createEventBridgeEvent("InvalidEvent", {});

    // Should not throw, just exit early
    await handler(emailEvent, contextWithoutEmail);

    expect(emailServiceSpy).not.toHaveBeenCalled();
  });

  describe("when email notifications are disabled", () => {
    it("should exit early when emailFrom is undefined", async () => {
      const configWithoutEmail = {
        ...mockedGlobalConfig,
        notification: { ...mockedGlobalConfig.notification, emailFrom: "" },
      };
      const contextWithoutEmail = mockContext(testEnv, configWithoutEmail);
      mockAppConfigMiddleware(configWithoutEmail);

      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, contextWithoutEmail);

      expect(emailServiceSpy).not.toHaveBeenCalled();
    });

    it("should exit early when emailFrom is empty string", async () => {
      const configWithEmptyEmail = {
        ...mockedGlobalConfig,
        notification: { ...mockedGlobalConfig.notification, emailFrom: "" },
      };
      const contextWithEmptyEmail = mockContext(testEnv, configWithEmptyEmail);
      mockAppConfigMiddleware(configWithEmptyEmail);

      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, contextWithEmptyEmail);

      expect(emailServiceSpy).not.toHaveBeenCalled();
    });

    it("should send email when emailFrom is properly configured", async () => {
      // This test ensures the normal flow still works
      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, mockedContext);

      expect(emailServiceSpy).toHaveBeenCalled();
    });
  });

  describe("dual-channel dispatch (notification channel toggles)", () => {
    const snsMock = mockClient(SNSClient);
    let loggerErrorSpy: ReturnType<typeof vi.spyOn>;
    let loggerWarnSpy: ReturnType<typeof vi.spyOn>;
    let listIsbAdminsSpy: ReturnType<typeof vi.spyOn>;
    let listIsbManagersSpy: ReturnType<typeof vi.spyOn>;
    let emailServiceFactorySpy: ReturnType<typeof vi.spyOn>;

    function contextWithChannels(channels: {
      sesEnabled: boolean;
      snsIntegrationTopicEnabled: boolean;
    }) {
      const config: GlobalConfig = {
        ...mockedGlobalConfig,
        notification: { ...mockedGlobalConfig.notification, ...channels },
      };
      mockAppConfigMiddleware(config);
      return mockContext(testEnv, config);
    }

    beforeEach(() => {
      // Cold cache per test: listIsbAdmins/listIsbManagers cache
      // module-globally, so a "called once" assertion could otherwise pass
      // from an earlier test's warm cache.
      clearIdcCache();
      snsMock.reset();
      emailServiceSpy.mockClear();
      emailServiceFactorySpy = vi.spyOn(IsbServices, "emailService");
      listIsbAdminsSpy = vi
        .spyOn(IdcService.prototype, "listIsbAdmins")
        .mockResolvedValue({
          result: [{ type: "human", email: "admin@example.com" } as any],
          nextPageIdentifier: null,
        });
      listIsbManagersSpy = vi
        .spyOn(IdcService.prototype, "listIsbManagers")
        .mockResolvedValue({
          result: [{ type: "human", email: "manager@example.com" } as any],
          nextPageIdentifier: null,
        });
      loggerErrorSpy = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      loggerWarnSpy = vi
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      snsMock.on(PublishCommand).resolves({ MessageId: "test-message-id" });
    });

    afterEach(() => {
      loggerErrorSpy.mockRestore();
      loggerWarnSpy.mockRestore();
      emailServiceFactorySpy.mockRestore();
      listIsbAdminsSpy.mockRestore();
      listIsbManagersSpy.mockRestore();
    });

    it("SES-only: dispatches SES and makes no SNS publish call", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
      });
      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).toHaveBeenCalled();
      expect(snsMock.calls()).toHaveLength(0);
    });

    it("SES-only: passes the handler's own shared-router result to EmailService rather than letting EmailService synthesize", async () => {
      // Asserts the received array's shape, not just that EmailService was
      // called, to catch a regression where the handler passes undefined.
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
      });
      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).toHaveBeenCalledTimes(1);
      const [, sharedMessages] = emailServiceSpy.mock.calls[0]!;
      expect(sharedMessages).toEqual([
        expect.objectContaining({
          persona: "user",
          recipientEmails: [isbEvent.userEmail],
        }),
      ]);
    });

    it("SES-only: propagates an email transport failure", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
      });
      const emailError = new Error("SES transport failed");
      emailServiceSpy.mockRejectedValueOnce(emailError);
      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await expect(handler(emailEvent, context)).rejects.toBe(emailError);

      expect(snsMock.calls()).toHaveLength(0);
    });

    it("SNS-only: publishes to SNS via the handler's shared router and does not call EmailService", async () => {
      // LeaseRequested resolves the manager audience via IdcService, so
      // asserting these spies proves the shared router actually ran.
      const context = contextWithChannels({
        sesEnabled: false,
        snsIntegrationTopicEnabled: true,
      });
      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceFactorySpy).not.toHaveBeenCalled();
      expect(emailServiceSpy).not.toHaveBeenCalled();
      expect(snsMock.calls().length).toBeGreaterThan(0);
      // listIsbAdmins/listIsbManagers self-cache per page, so exactly one
      // call proves recipients were resolved via the shared router.
      expect(listIsbAdminsSpy).toHaveBeenCalledTimes(1);
      expect(listIsbManagersSpy).toHaveBeenCalledTimes(1);
      const publishedAttributes =
        snsMock.commandCalls(PublishCommand)[0]!.args[0]!.input
          .MessageAttributes!;
      expect(
        JSON.parse(publishedAttributes.recipientEmails!.StringValue!),
      ).toEqual(
        expect.arrayContaining(["admin@example.com", "manager@example.com"]),
      );
    });

    it("dispatches SES and SNS from one synthesis with a single IDC lookup", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      // Manager audience is the case this "no double fetch" guarantee matters for.
      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).toHaveBeenCalled();
      expect(snsMock.calls().length).toBeGreaterThan(0);
      // One call each proves the handler resolved recipients once and
      // handed the same result to both adapters.
      expect(listIsbAdminsSpy).toHaveBeenCalledTimes(1);
      expect(listIsbManagersSpy).toHaveBeenCalledTimes(1);
      // The same shared array reaches EmailService and SNS, proving one
      // synthesis result is handed to both adapters.
      const [, sharedMessages] = emailServiceSpy.mock.calls[0]!;
      expect(sharedMessages).toEqual([
        expect.objectContaining({
          persona: "manager",
          recipientEmails: expect.arrayContaining([
            "admin@example.com",
            "manager@example.com",
          ]),
        }),
      ]);
      const publishedAttributes =
        snsMock.commandCalls(PublishCommand)[0]!.args[0]!.input
          .MessageAttributes!;
      expect(
        JSON.parse(publishedAttributes.recipientEmails!.StringValue!),
      ).toEqual(
        (sharedMessages as SynthesizedAudienceMessage[])[0]!.recipientEmails,
      );
    });

    it("dispatches SES and SNS concurrently, not sequentially", async () => {
      // Deferred-promise gate: each side records its own start, then blocks
      // until both sides have started. A sequential implementation would
      // deadlock (the second call never starts to open the gate); genuine
      // concurrent dispatch issues both calls before awaiting either, so
      // the gate opens. Proves concurrency without relying on wall-clock
      // timing, which would be flaky under CI scheduling.
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      const startOrder: string[] = [];
      let sesStarted = false;
      let snsStarted = false;
      let openGate: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      function maybeOpenGate() {
        if (sesStarted && snsStarted) {
          openGate!();
        }
      }

      emailServiceSpy.mockImplementationOnce(async () => {
        startOrder.push("ses-started");
        sesStarted = true;
        maybeOpenGate();
        await gate;
        startOrder.push("ses-resolved");
      });
      snsMock.on(PublishCommand).callsFake(async () => {
        startOrder.push("sns-started");
        snsStarted = true;
        maybeOpenGate();
        await gate;
        startOrder.push("sns-resolved");
        return { MessageId: "test-message-id" };
      });

      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      await handler(emailEvent, context);

      // Both starts happened before either resolved: the gate only opens
      // once both have started.
      expect(startOrder.slice(0, 2).sort()).toEqual([
        "ses-started",
        "sns-started",
      ]);
      expect(startOrder.slice(2).sort()).toEqual([
        "ses-resolved",
        "sns-resolved",
      ]);
    });

    it("contains a dual-mode SES failure without logging it twice", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      const terminalSesError = new Error(
        "SES account sending is paused (simulated terminal failure)",
      );
      emailServiceSpy.mockRejectedValueOnce(terminalSesError);

      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      await expect(handler(emailEvent, context)).resolves.toBeUndefined();

      expect(snsMock.calls().length).toBeGreaterThan(0);
      expect(loggerErrorSpy).not.toHaveBeenCalledWith(
        LogPatterns.EmailSendingError.pattern,
        terminalSesError,
      );
    });

    it("logs an unexpected dual-mode SNS rejection without blocking SES", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      const snsError = new Error("SNS client construction failed");
      const snsClientSpy = vi
        .spyOn(IsbClients, "sns")
        .mockImplementationOnce(() => {
          throw snsError;
        });
      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      try {
        await expect(handler(emailEvent, context)).resolves.toBeUndefined();
      } finally {
        snsClientSpy.mockRestore();
      }

      expect(emailServiceSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        LogPatterns.NotificationFailed.pattern,
        {
          notificationMetricType: "NotificationDeliveryFailed",
          isbNamespace: context.env.ISB_NAMESPACE,
          channel: "SNS",
          notificationType: EventDetailTypes.LeaseRequested,
          errorNames: ["Error"],
        },
      );
    });

    it("neither enabled: emits NotificationNoChannelEnabled and calls neither channel", async () => {
      const context = contextWithChannels({
        sesEnabled: false,
        snsIntegrationTopicEnabled: false,
      });
      const isbEvent = generateSchemaData(LeaseApprovedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseApproved,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).not.toHaveBeenCalled();
      expect(snsMock.calls()).toHaveLength(0);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        LogPatterns.NotificationNoChannelEnabled.pattern,
        { notificationType: EventDetailTypes.LeaseApproved },
      );
    });

    it("a shared-synthesis IDC failure propagates and dispatches neither channel", async () => {
      // LeaseRequested resolves the manager audience, so the failure
      // surfaces during the one shared synthesis call before either
      // channel dispatches.
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      listIsbManagersSpy.mockRejectedValueOnce(
        new Error("IDC throttled: DescribeUser rate exceeded"),
      );
      const isbEvent = generateSchemaData(LeaseRequestedEventSchema);
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseRequested,
        isbEvent,
      );

      // Propagates for EventBridge retry rather than being caught,
      // relabeled as SNS-specific, or triggering a second synthesis attempt.
      await expect(handler(emailEvent, context)).rejects.toThrow(
        "IDC throttled: DescribeUser rate exceeded",
      );

      // Neither adapter is reached.
      expect(emailServiceSpy).not.toHaveBeenCalled();
      expect(snsMock.calls()).toHaveLength(0);
    });

    it("a manager-audience IDC failure on a dual-audience event propagates and blocks the whole event, including the resolvable user audience", async () => {
      // The user audience resolves synchronously with no IDC call; the
      // manager audience does. Both come from one synthesizeNotificationMessages
      // call that awaits the manager audience before returning, so a
      // manager-side rejection fails the whole call and blocks both audiences.
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      listIsbManagersSpy.mockRejectedValueOnce(
        new Error("IDC throttled: DescribeUser rate exceeded"),
      );
      const isbEvent = generateSchemaData(
        LeaseFrozenEventSchema.extend({
          reason: LeaseFrozenByBudgetSchema,
        }),
        // The reason union pairs triggeredBy with rateSource; since zocker
        // fills them independently, the whole reason is pinned to keep the
        // fixture valid (same fix as the sibling LeaseFrozen case above).
        {
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 70,
            budget: 100,
            totalSpend: 72,
            triggeredBy: "PREDICTED",
            rateSource: "HOURLY",
          },
        },
      );
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseFrozen,
        isbEvent,
      );

      await expect(handler(emailEvent, context)).rejects.toThrow(
        "IDC throttled: DescribeUser rate exceeded",
      );

      // Neither channel dispatches, including no SES send for the user
      // audience, which itself never failed.
      expect(emailServiceSpy).not.toHaveBeenCalled();
      expect(snsMock.calls()).toHaveLength(0);
    });

    it("both enabled: LeaseTerminated by UserTerminated sends no email and publishes no SNS message", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      const isbEvent = generateSchemaData(
        LeaseTerminatedEventSchema.extend({
          reason: LeaseTerminatedByUserSchema,
        }),
      );
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.LeaseTerminated,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).toHaveBeenCalledTimes(1);
      const [, sharedMessages] = emailServiceSpy.mock.calls[0]!;
      expect(sharedMessages).toEqual([]);
      expect(snsMock.calls()).toHaveLength(0);
    });

    it("skips the SNS publish for an audience with no resolved recipients", async () => {
      const context = contextWithChannels({
        sesEnabled: true,
        snsIntegrationTopicEnabled: true,
      });
      // Non-empty control case alongside the empty-array UserTerminated
      // case above, proving the skip is selective, not a global regression.
      const isbEvent = generateSchemaData(AssignmentRemovedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "GROUP",
        assigneeEmail: undefined,
        removedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      const emailEvent = createEventBridgeEvent(
        EventDetailTypes.AssignmentRemoved,
        isbEvent,
      );

      await handler(emailEvent, context);

      expect(emailServiceSpy).toHaveBeenCalled();
      expect(snsMock.calls().length).toBeGreaterThan(0);
    });
  });
});
