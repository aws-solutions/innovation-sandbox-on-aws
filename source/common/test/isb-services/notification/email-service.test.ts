// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
  LeaseFrozenByDurationSchema,
  LeaseFrozenBySpendRateSchema,
  LeaseFrozenEventSchema,
  LeaseFrozenManualSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseSpendRateThresholdTriggeredEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  LeaseTerminatedByBudgetSchema,
  LeaseTerminatedByDurationSchema,
  LeaseTerminatedByUserSchema,
  LeaseTerminatedEjectedSchema,
  LeaseTerminatedEventSchema,
  LeaseTerminatedManualSchema,
  LeaseTerminatedProvisioningFailedSchema,
  LeaseTerminatedQuarantinedSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  SynthesizedAudienceMessage,
  synthesizeNotificationMessages,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-message-synthesis.js";
import { EmailEventName } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import { SynthesizedEmail } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import { EmailTemplates } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import { EmailNotificationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  SendEmailCommand,
  SESClient,
  SESServiceException,
} from "@aws-sdk/client-ses";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const managerEmails = ["manager@example.com", "manager2@example.com"];
const adminEmails = ["admin@example.com"];
const adminOnlyEmails = [...adminEmails];

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
  async () => {
    const actual = (await vi.importActual(
      "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
    )) as any;
    return {
      ...actual,
      allAdmins: vi.fn().mockResolvedValue(["admin@example.com"]),
      allManagers: vi
        .fn()
        .mockResolvedValue(["manager@example.com", "manager2@example.com"]),
    };
  },
);

const testEnv = {
  ...generateSchemaData(EmailNotificationEnvironmentSchema),
  IDC_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/isb_test_idc_configuration",
};

const fromAddress = "example@example.com";
const emailService = IsbServices.emailService(testEnv, {
  fromAddress: fromAddress,
  logger: new Logger(),
});
const routingIdcService = IsbServices.idcService(testEnv);

async function synthesizeAndSendNotificationEmail(
  emailEventName: EmailEventName,
  isbAlert: unknown,
): Promise<void> {
  const messages = await synthesizeNotificationMessages(
    emailEventName,
    isbAlert,
    {
      webAppUrl: "https://www.example.com",
      idcService: routingIdcService,
    },
  );
  await emailService.sendNotificationEmail(emailEventName, messages);
}

const sesMock = mockClient(SESClient);
beforeEach(() => {
  vi.clearAllMocks();
  sesMock.reset();
});

describe("SES Service", async () => {
  describe("Email retries", async () => {
    const size = 5;
    const testEmail: SynthesizedEmail = {
      subject: "test subject",
      to: Array.from({ length: size }, (_, i) => `email${i}@example.com`),
      bcc: undefined,
      textBody: "text body",
      htmlBody: "html body",
    };
    const privateBody = "private notification body";

    function notificationMessage(
      recipientEmails: string[],
    ): SynthesizedAudienceMessage {
      return {
        persona: "user",
        recipientEmails,
        subject: "notification subject",
        textBody: privateBody,
        htmlBody: `<p>${privateBody}</p>`,
      };
    }

    function notificationService() {
      const logger = new Logger();
      const errorSpy = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);
      return {
        errorSpy,
        service: IsbServices.emailService(testEnv, { fromAddress, logger }),
      };
    }

    function namedError(name: string): Error {
      const error = new Error();
      error.name = name;
      return error;
    }

    it("should send all emails when in one call no exception is returned", async () => {
      sesMock.on(SendEmailCommand).resolves({
        MessageId: "test-message-id",
      });

      await emailService.sendEmail(testEmail);
      expect(sesMock.calls().length).toEqual(1);
    });
    it.each<string>([
      "AccessDenied",
      "AccountSendingPausedException",
      "ConfigurationSetDoesNotExistException",
      "ConfigurationSetSendingPausedException",
    ])(
      "should bail out when irrecoverable exceptions are thrown, %s",
      async (exceptionName: string) => {
        const currentException = new SESServiceException({
          $fault: "client",
          $metadata: {},
          name: exceptionName,
        });
        sesMock.on(SendEmailCommand).rejects(currentException);
        await expect(emailService.sendEmail(testEmail)).rejects.toThrow(
          currentException,
        );
        expect(sesMock.calls().length).toEqual(1);
      },
    );

    it("logs a terminal SES failure once before rethrowing", async () => {
      const logger = new Logger();
      const errorSpy = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);
      const service = IsbServices.emailService(testEnv, {
        fromAddress,
        logger,
      });
      const terminalError = new SESServiceException({
        $fault: "client",
        $metadata: {},
        name: "AccountSendingPausedException",
      });
      sesMock.on(SendEmailCommand).rejects(terminalError);

      await expect(service.sendEmail(testEmail)).rejects.toThrow(terminalError);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        LogPatterns.EmailSendingError.pattern,
        terminalError,
      );
    });

    it("emits a structured SES delivery failure for an irrecoverable notification send and rethrows", async () => {
      const { service, errorSpy } = notificationService();
      const terminalError = new SESServiceException({
        $fault: "client",
        $metadata: {},
        name: "AccountSendingPausedException",
        message: "Email address is not verified: someone@example.com",
      });
      sesMock.on(SendEmailCommand).rejects(terminalError);

      await expect(
        service.sendNotificationEmail("LeaseApproved", [
          notificationMessage(["someone@example.com"]),
        ]),
      ).rejects.toThrow(terminalError);

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        LogPatterns.NotificationFailed.pattern,
        {
          notificationMetricType: "NotificationDeliveryFailed",
          isbNamespace: testEnv.ISB_NAMESPACE,
          channel: "SES",
          notificationType: "LeaseApproved",
          errorNames: ["AccountSendingPausedException"],
        },
      );
      const serializedLog = JSON.stringify(errorSpy.mock.calls[0]);
      expect(serializedLog).not.toContain("someone@example.com");
      expect(serializedLog).not.toContain(privateBody);
    });

    it("does not emit a delivery failure when SES bisection recovers", async () => {
      const { service, errorSpy } = notificationService();
      const retryableError = new Error("batch rejected");
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(retryableError)
        .resolves({ MessageId: "test-message-id" });

      await service.sendNotificationEmail("LeaseApproved", [
        notificationMessage(["first@example.com", "second@example.com"]),
      ]);

      expect(sesMock.calls()).toHaveLength(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("emits one delivery failure when an audience is partially delivered after bisection", async () => {
      const { service, errorSpy } = notificationService();
      const retryableError = new Error(
        "Email address is not verified: invalid@example.com",
      );
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(retryableError)
        .resolvesOnce({ MessageId: "test-message-id" })
        .rejectsOnce(retryableError);

      await service.sendNotificationEmail("LeaseApproved", [
        notificationMessage(["valid@example.com", "invalid@example.com"]),
      ]);

      expect(sesMock.calls()).toHaveLength(3);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        LogPatterns.NotificationFailed.pattern,
        {
          notificationMetricType: "NotificationDeliveryFailed",
          isbNamespace: testEnv.ISB_NAMESPACE,
          channel: "SES",
          notificationType: "LeaseApproved",
          errorNames: ["Error"],
        },
      );
      const serializedLog = JSON.stringify(errorSpy.mock.calls[0]);
      expect(serializedLog).not.toContain("invalid@example.com");
      expect(serializedLog).not.toContain(privateBody);
    });

    it("emits one delivery failure when several recipients in one audience fail", async () => {
      // One audience is one metric event for both SES and SNS.
      const { service, errorSpy } = notificationService();
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(namedError("BatchRejected"))
        .rejectsOnce(namedError("BatchRejected"))
        .rejectsOnce(namedError("InvalidAddress"))
        .rejectsOnce(namedError("SuppressedAddress"))
        .rejectsOnce(namedError("BatchRejected"))
        .rejectsOnce(namedError("InvalidAddress"))
        .rejectsOnce(namedError("ConfigurationError"));

      await service.sendNotificationEmail("LeaseApproved", [
        notificationMessage([
          "first@example.com",
          "second@example.com",
          "third@example.com",
          "fourth@example.com",
        ]),
      ]);

      expect(sesMock.calls()).toHaveLength(7);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        LogPatterns.NotificationFailed.pattern,
        {
          notificationMetricType: "NotificationDeliveryFailed",
          isbNamespace: testEnv.ISB_NAMESPACE,
          channel: "SES",
          notificationType: "LeaseApproved",
          errorNames: [
            "InvalidAddress",
            "SuppressedAddress",
            "ConfigurationError",
          ],
        },
      );
    });

    it.each<{ exceptionName: string; isBcc: boolean }>([
      {
        exceptionName: "InvalidParameterValueException",
        isBcc: true,
      },
      {
        exceptionName: "InvalidParameterValueException",
        isBcc: false,
      },
      {
        exceptionName: "UnExpectedException",
        isBcc: true,
      },
      {
        exceptionName: "UnExpectedException",
        isBcc: false,
      },
    ])(
      "should retry for unexpected exceptions and parameter validation exception, %s",
      async ({ exceptionName, isBcc }) => {
        const currentException = new SESServiceException({
          $fault: "client",
          $metadata: {},
          name: exceptionName,
        });
        sesMock
          .on(SendEmailCommand)
          .rejectsOnce(currentException)
          .resolvesOnce({
            MessageId: "test-message-id",
          })
          .rejectsOnce(currentException);
        const size = 2;
        const addresses = Array.from(
          { length: size },
          (_, i) => `email${i}@example.com`,
        );
        const currentEmail = isBcc
          ? { ...testEmail, bcc: addresses, to: undefined }
          : { ...testEmail, to: addresses, bcc: undefined };
        await emailService.sendEmail(currentEmail);
        expect(sesMock.calls().length).toEqual(3);
      },
    );
    it("should retry when a non SESServiceException is thrown", async () => {
      const currentException = new Error("test error");
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(currentException)
        .rejectsOnce(currentException)
        .resolvesOnce({
          MessageId: "test-message-id",
        });
      const size = 2;
      testEmail.to = Array.from(
        { length: size },
        (_, i) => `email${i}@example.com`,
      );

      await emailService.sendEmail(testEmail);
      expect(sesMock.calls().length).toEqual(3);
    });

    it("should retry when an InvalidParameterValueException is thrown, size 5 first failing", async () => {
      const currentException = new SESServiceException({
        $fault: "client",
        $metadata: {},
        name: "InvalidParameterValueException",
      });
      /*
        12345
        12
        1 2
            345
         */
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(currentException) // 12345
        .rejectsOnce(currentException) // 12
        .rejectsOnce(currentException) // 1
        .resolves({
          MessageId: "test-message-id",
        });
      const size = 5;
      testEmail.to = Array.from(
        { length: size },
        (_, i) => `email${i}@example.com`,
      );

      await emailService.sendEmail(testEmail);
      expect(sesMock.calls().length).toEqual(5);
    });

    it("should retry when a UnExpected SESServiceException is thrown, size 5 last failing", async () => {
      const currentException = new SESServiceException({
        $fault: "client",
        $metadata: {},
        name: "Unexpected Exception",
      });
      /*
        12345
        12
            345
            3 45
              4 5
         */
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(currentException) // 12345
        .resolvesOnce({
          MessageId: "test-message-id",
        }) // 12
        .rejectsOnce(currentException) // 345
        .resolvesOnce({
          MessageId: "test-message-id",
        }) // 3
        .rejectsOnce(currentException) // 45
        .resolvesOnce({
          MessageId: "test-message-id",
        }) // 4
        .rejectsOnce(currentException); // 5
      const size = 5;
      testEmail.to = Array.from(
        { length: size },
        (_, i) => `email${i}@example.com`,
      );

      await emailService.sendEmail(testEmail);
      expect(sesMock.calls().length).toEqual(7);
    });

    it("should retry when a non SESServiceException is thrown, size 5, 2 in the middle failing", async () => {
      const currentException = new Error("test error");
      /*
        1234
        12
        1 2
            34
            3 4
         */
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(currentException) // 1234
        .rejectsOnce(currentException) // 12
        .resolvesOnce({
          MessageId: "test-message-id",
        }) // 1
        .rejectsOnce(currentException) // 2
        .rejectsOnce(currentException) // 34
        .rejectsOnce(currentException) // 3
        .resolvesOnce({
          MessageId: "test-message-id",
        }); // 4
      const size = 5;
      const addresses = Array.from(
        { length: size },
        (_, i) => `email${i}@example.com`,
      );
      const currentEmail = { ...testEmail, bcc: addresses, to: undefined };

      await emailService.sendEmail(currentEmail);
      expect(sesMock.calls().length).toEqual(7);
    });
  });

  describe("M2M synthetic recipient filtering", async () => {
    const baseEmail = {
      subject: "test subject",
      textBody: "text body",
      htmlBody: "html body",
    };

    beforeEach(() => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: "test-message-id" });
    });

    it("drops @automation.local recipients from the to: list", async () => {
      await emailService.sendEmail({
        ...baseEmail,
        to: ["real@example.com", "m2m-client-Admin@automation.local"],
        bcc: undefined,
      });

      expect(sesMock.calls().length).toEqual(1);
      const input = sesMock.call(0).args[0].input as SendEmailCommand["input"];
      expect(input.Destination?.ToAddresses).toEqual(["real@example.com"]);
    });

    it("skips the SES send when every to recipient is synthetic", async () => {
      const warnSpy = vi
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);

      try {
        await emailService.sendEmail({
          ...baseEmail,
          to: ["m2m-client-Admin@automation.local"],
          bcc: undefined,
        });

        expect(sesMock.calls()).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("legacy data or a bypass path"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does not touch the bcc-only (admin/manager) path", async () => {
      await emailService.sendEmail({
        ...baseEmail,
        to: undefined,
        bcc: ["admin@example.com", "manager@example.com"],
      });

      expect(sesMock.calls().length).toEqual(1);
      const input = sesMock.call(0).args[0].input as SendEmailCommand["input"];
      expect(input.Destination?.BccAddresses).toEqual([
        "admin@example.com",
        "manager@example.com",
      ]);
    });
  });

  describe("delegated SES identity (sesIdentityArn)", () => {
    const testEmail: SynthesizedEmail = {
      subject: "test subject",
      to: ["someone@example.com"],
      bcc: undefined,
      textBody: "text body",
      htmlBody: "html body",
    };

    beforeEach(() => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: "test-message-id" });
    });

    it("omits SourceArn when sesIdentityArn is not configured", async () => {
      const service = IsbServices.emailService(testEnv, {
        fromAddress,
        logger: new Logger(),
      });
      await service.sendEmail(testEmail);
      const input = sesMock.call(0).args[0].input as SendEmailCommand["input"];
      expect(input.SourceArn).toBeUndefined();
    });

    it("sets SourceArn when sesIdentityArn is configured", async () => {
      const sesIdentityArn =
        "arn:aws:ses:us-east-1:123456789012:identity/example.com";
      const service = IsbServices.emailService(testEnv, {
        fromAddress,
        logger: new Logger(),
        sesIdentityArn,
      });
      await service.sendEmail(testEmail);
      const input = sesMock.call(0).args[0].input as SendEmailCommand["input"];
      expect(input.SourceArn).toEqual(sesIdentityArn);
    });

    const domainIdentityArn =
      "arn:aws:ses:us-east-1:123456789012:identity/example.com";
    const emailIdentityArn =
      "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com";

    it.each([
      {
        description: "warns for a mismatched domain identity",
        sender: "sender@mismatched-domain.com",
        identityArn: domainIdentityArn,
        warningCount: 1,
      },
      {
        description: "accepts a matching domain identity",
        sender: "sender@example.com",
        identityArn: domainIdentityArn,
        warningCount: 0,
      },
      {
        description: "accepts a matching parent domain identity",
        sender: "sender@mail.example.com",
        identityArn: domainIdentityArn,
        warningCount: 0,
      },
      {
        description: "accepts an exact email identity",
        sender: "sender@example.com",
        identityArn: emailIdentityArn,
        warningCount: 0,
      },
      {
        description: "warns for a sibling email identity",
        sender: "other@example.com",
        identityArn: emailIdentityArn,
        warningCount: 1,
      },
      {
        description: "warns for an email identity on a parent domain",
        sender: "sender@mail.example.com",
        identityArn: emailIdentityArn,
        warningCount: 1,
      },
      {
        description: "warns for a case-mismatched email identity",
        sender: "Sender@Example.com",
        identityArn: emailIdentityArn,
        warningCount: 1,
      },
      {
        description: "accepts a plus label on an email identity",
        sender: "sender+alerts@example.com",
        identityArn: emailIdentityArn,
        warningCount: 0,
      },
      {
        description: "accepts no identity ARN",
        sender: "sender@example.com",
        identityArn: undefined,
        warningCount: 0,
      },
    ])("$description", ({ sender, identityArn, warningCount }) => {
      const logger = new Logger();
      const warnSpy = vi
        .spyOn(logger, "warn")
        .mockImplementation(() => undefined);
      IsbServices.emailService(testEnv, {
        fromAddress: sender,
        logger,
        sesIdentityArn: identityArn,
      });
      expect(warnSpy).toHaveBeenCalledTimes(warningCount);
    });

    it("throws on an unparsable ARN, which the environment schema should have rejected", () => {
      expect(() =>
        IsbServices.emailService(testEnv, {
          fromAddress: "sender@example.com",
          logger: new Logger(),
          sesIdentityArn: "arn:aws:ses:us-east-1:123456789012:not-an-identity",
        }),
      ).toThrow("SES_IDENTITY_ARN passed startup validation but is unparsable");
    });

    it("does not include the sender or identity ARN in mismatch warnings", () => {
      const mismatchedFromAddress = "sender@mismatched-domain.com";
      const sesIdentityArn =
        "arn:aws:ses:us-east-1:123456789012:identity/example.com";
      const logger = new Logger();
      const warnSpy = vi
        .spyOn(logger, "warn")
        .mockImplementation(() => undefined);
      IsbServices.emailService(testEnv, {
        fromAddress: mismatchedFromAddress,
        logger,
        sesIdentityArn,
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(
        mismatchedFromAddress,
      );
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(
        sesIdentityArn,
      );
    });
  });

  describe("empty recipient handling", () => {
    const messageBody = {
      subject: "test subject",
      textBody: "text body",
      htmlBody: "html body",
    };

    it.each<SynthesizedAudienceMessage["persona"]>([
      "user",
      "manager",
      "admin",
    ])("skips an empty %s audience", async (persona) => {
      await emailService.sendNotificationEmail("LeaseApproved", [
        {
          persona,
          recipientEmails: [],
          ...messageBody,
        },
      ]);

      expect(sesMock.calls()).toHaveLength(0);
    });

    it("skips a direct send with an empty BCC audience", async () => {
      await emailService.sendEmail({
        ...messageBody,
        to: undefined,
        bcc: [],
      });

      expect(sesMock.calls()).toHaveLength(0);
    });
  });

  describe("Email routing", async () => {
    sesMock.on(SendEmailCommand).resolves({
      MessageId: "test-message-id",
    });

    it(`should send email - ${EventDetailTypes.LeaseRequested}`, async () => {
      const isbAlert = generateSchemaData(LeaseRequestedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseRequested,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action Required\] Innovation Sandbox: New Lease Approval Request/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails, ...managerEmails],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseApproved}`, async () => {
      const isbAlert = generateSchemaData(LeaseApprovedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseApproved,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Lease Request Approved/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseDenied}`, async () => {
      const isbAlert = generateSchemaData(LeaseDeniedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseDenied,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Lease Request Denied/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert}`, async () => {
      // Pin every field a schema refinement pairs: zocker populates optionals
      // at random, so leaving the branch, its threshold, or the insight kind
      // free makes this suite intermittently red for unrelated reasons.
      const isbAlert = generateSchemaData(
        LeaseBudgetThresholdTriggeredEventSchema,
        {
          triggeredBy: "REPORTED",
          budgetThresholdTriggered: 70,
          insight: null,
        },
      );
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action may be needed\] Innovation Sandbox: Budget Threshold Alert/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} shaped as the previous release emits it`, async () => {
      // During a deploy the new notification Lambda can receive a detail from
      // the previous release's Lease Monitoring, which carries none of the
      // fields this feature added. It must still parse and render the copy
      // that release's users know.
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 72,
          budgetThresholdTriggered: 70,
          actionRequested: "ALERT",
        },
      );
      assertSingleEmailActions({
        subject:
          /\[Action may be needed\] Innovation Sandbox: Budget Threshold Alert/,
        numSesMockCalls: 1,
        toAddresses: ["user@example.com"],
      });
      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "has reached the budget threshold of USD 70.00 against the assigned budget of USD 100.00",
        );
        expect(body).not.toContain("The last confirmed cost");
        expect(body).not.toContain("At the current rate");
        expect(body).not.toContain("estimate");
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert}`, async () => {
      // `insight` is pinned because zocker populates its kind and figures
      // independently, and the persisted schema pairs them.
      const isbAlert = generateSchemaData(
        LeaseSpendRateThresholdTriggeredEventSchema,
        { insight: null },
      );
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action may be needed\] Innovation Sandbox: Spend Rate Limit Alert/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} names the limit and the measured rate, not a dollar threshold`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          rateBasis: "HOURLY",
          thresholdRate: 12,
          measuredRate: 14,
          totalSpend: 60,
        },
      );

      assertSingleEmailActions({
        subject:
          /\[Action may be needed\] Innovation Sandbox: Spend Rate Limit Alert/,
        numSesMockCalls: 1,
        toAddresses: ["someone@example.com"],
      });
      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "has exceeded its configured spend rate limit of USD 12.00/hour; the measured rate is USD 14.00/hour",
        );
        expect(body).toContain("The last confirmed cost was USD 60.00.");
        expect(body).not.toContain("budget threshold");
        expect(body).not.toContain("undefined");
      }
    });

    // Asserts the assembled body in BOTH html and text, since the two are
    // written from one paragraph and would otherwise drift.
    function sentBodies(callIndex: number): { html: string; text: string } {
      const message =
        sesMock.commandCalls(SendEmailCommand)[callIndex]!.args[0]!.input!
          .Message!;
      return {
        html: message.Body!.Html!.Data!,
        text: message.Body!.Text!.Data!,
      };
    }

    function budgetAlertBodies(): { html: string; text: string } {
      expect(sesMock.calls().length).toEqual(1);
      return sentBodies(0);
    }

    // Both freeze emails, user then admin/manager, html and text of each, with
    // whitespace collapsed so a reflow of the template's line breaks cannot
    // break a whole-sentence assertion.
    function frozenBodies(): string[] {
      expect(sesMock.calls().length).toEqual(2);
      return [0, 1].flatMap((callIndex) =>
        Object.values(sentBodies(callIndex)).map((body) =>
          body.replace(/\s+/g, " "),
        ),
      );
    }

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} on a PREDICTED breach reads as an estimate`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 60,
          budgetThresholdTriggered: 70,
          actionRequested: "ALERT",
          triggeredBy: "PREDICTED",
          predictedCost: 72,
          rate: 3.5,
          rateSource: "HOURLY",
          hoursToBudgetExhaustion: 8,
          lastReportedAt: "2026-08-11T08:00:00.000Z",
          insight: {
            kind: "COMPOSITION",
            service: "Amazon Bedrock",
            amount: 52.1,
            shareOfComparedSpend: 0.87,
          },
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        // Estimate framing, never a confirmed-fact "reached".
        expect(body).toContain("is projected to cross");
        expect(body).toContain("estimate");
        expect(body).not.toContain("has reached");
        expect(body).toContain("The last confirmed cost was USD 60.00");
        expect(body).toContain("observed");
        expect(body).toContain("At the current rate of USD 3.50/hour");
        expect(body).toContain("the projected cost is USD 72.00");
        expect(body).toContain("budget would be exhausted in about 8 hours");
        expect(body).toContain(
          "The largest service is Amazon Bedrock, USD 52.10 (87%)",
        );
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} names the unbilled Bedrock usage, the countdown at its own rate, and the unbilled usage as the largest service`, async () => {
      // The token poll's alert of 2026-10-14, a bill that is all EC2 beside
      // far more unbilled Nova Pro usage.
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 200,
          totalSpend: 2.22,
          budgetThresholdTriggered: 8,
          actionRequested: "ALERT",
          triggeredBy: "PREDICTED",
          predictedCost: 8.9,
          rate: 0.096,
          rateSource: "HOURLY",
          countdownRate: 5.55,
          countdownRateSource: "HOURLY",
          hoursToBudgetExhaustion: (200 - 8.9) / 5.55,
          lastReportedAt: now().minus({ hours: 11 }).toISO(),
          unbilledBedrockTokenCost: 5.45,
          insight: {
            kind: "COMPOSITION",
            service: "Amazon Bedrock token usage not yet billed",
            amount: 5.45,
            shareOfComparedSpend: 5.45 / (2.22 + 5.45),
          },
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "The last confirmed cost was USD 2.22, observed 11 hours ago, plus USD 5.45 of Bedrock token usage not yet billed. At the current rate of USD 0.10/hour, the projected cost is USD 8.90. At USD 5.55/hour including monitored Bedrock token cost, the USD 200.00 budget would be exhausted in about 34 hours. The largest service is Amazon Bedrock token usage not yet billed, USD 5.45 (71%).",
        );
      }
    });

    it.each([
      [
        "the unbilled Bedrock usage",
        { unbilledBedrockTokenCost: 5.45 },
        "The last confirmed cost was USD 2.22, plus USD 5.45 of Bedrock token usage not yet billed.",
      ],
      [
        "nothing where it is zero",
        { unbilledBedrockTokenCost: 0 },
        "The last confirmed cost was USD 2.22.",
      ],
      [
        "nothing where it is missing",
        {},
        "The last confirmed cost was USD 2.22.",
      ],
      [
        "nothing where it rounds to zero cents",
        { unbilledBedrockTokenCost: 0.004 },
        "The last confirmed cost was USD 2.22.",
      ],
    ])(
      `should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} adds %s to the last confirmed cost`,
      async (_case, added, sentence) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
          {
            leaseId: {
              userEmail: "someone@example.com",
              uuid: "750e8400-e29b-41d4-a716-446655440002",
            },
            accountId: "123456789012",
            totalSpend: 2.22,
            budgetThresholdTriggered: 8,
            actionRequested: "ALERT",
            triggeredBy: "PREDICTED",
            predictedCost: 8.9,
            rate: 5.55,
            rateSource: "HOURLY",
            ...added,
          },
        );

        for (const body of Object.values(budgetAlertBodies())) {
          expect(body).toContain(sentence);
          expect(body).not.toContain("plus USD 0.00");
        }
      },
    );

    it.each([
      [
        "states the countdown with the projection where its rate reads the same",
        { countdownRate: 2.0001, countdownRateSource: "HOURLY" },
        "At the current rate of USD 2.00/hour, the projected cost is USD 88.00, the USD 200.00 budget would be exhausted in about 42 hours.",
      ],
      [
        "states the countdown on its own with its daily rate per day",
        { countdownRate: 64, countdownRateSource: "DAILY" },
        "At the current rate of USD 2.00/hour, the projected cost is USD 88.00. At USD 64.00/day including monitored Bedrock token cost, the USD 200.00 budget would be exhausted in about 42 hours.",
      ],
      [
        "names the budget alone, with no countdown rate, where no positive countdown exists",
        {
          countdownRate: 64,
          countdownRateSource: "DAILY",
          hoursToBudgetExhaustion: null,
        },
        "At the current rate of USD 2.00/hour, the projected cost is USD 88.00, the assigned budget is USD 200.00.",
      ],
    ])(
      `should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} %s`,
      async (_case, countdown, sentence) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
          {
            leaseId: {
              userEmail: "someone@example.com",
              uuid: "750e8400-e29b-41d4-a716-446655440002",
            },
            accountId: "123456789012",
            budget: 200,
            totalSpend: 56,
            budgetThresholdTriggered: 85,
            actionRequested: "ALERT",
            triggeredBy: "PREDICTED",
            predictedCost: 88,
            rate: 2,
            rateSource: "HOURLY",
            hoursToBudgetExhaustion: 42,
            ...countdown,
          },
        );

        for (const body of Object.values(budgetAlertBodies())) {
          expect(body).toContain(sentence);
        }
      },
    );

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} states a daily rate per day`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 200,
          totalSpend: 105,
          budgetThresholdTriggered: 100,
          actionRequested: "ALERT",
          triggeredBy: "REPORTED",
          predictedCost: 120,
          rate: 52,
          rateSource: "DAILY",
          hoursToBudgetExhaustion: 36,
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain("At the current rate of USD 52.00/day");
        expect(body).not.toContain("/hour");
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} on a REPORTED breach carries the figures and the insight`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 200,
          totalSpend: 105,
          budgetThresholdTriggered: 100,
          actionRequested: "ALERT",
          triggeredBy: "REPORTED",
          predictedCost: 120,
          rate: 3.5,
          rateSource: "HOURLY",
          hoursToBudgetExhaustion: 12,
          insight: {
            kind: "CHANGE",
            service: "Amazon EC2",
            amount: 40,
            changePercent: -30,
          },
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        // A REPORTED breach names the crossed figure in its lead, so no
        // separate confirmed-cost line.
        expect(body).toContain(
          "has reached the budget threshold of USD 100.00",
        );
        expect(body).toContain("against the assigned budget of USD 200.00");
        expect(body).not.toContain("The last confirmed cost was");
        expect(body).toContain("the projected cost is USD 120.00");
        expect(body).toContain(
          "The biggest change is Amazon EC2, down 30% since the previous interval, now USD 40.00",
        );
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} on a first-interval lease claims no projection`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          totalSpend: 50,
          budgetThresholdTriggered: 50,
          actionRequested: "ALERT",
          triggeredBy: "REPORTED",
          // No rate in force. predictedCost carries the reported total under
          // another name, so the copy must not call it a projection -- and it
          // is set here, so the suppression is proven to hinge on the null
          // rate rather than on an absent predictedCost.
          predictedCost: 50,
          rate: null,
          rateSource: null,
          hoursToBudgetExhaustion: null,
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain("has reached the budget threshold of USD 50.00");
        expect(body).not.toContain("projected");
        expect(body).not.toContain("At the current rate");
        expect(body).not.toContain("The largest service");
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} names the measured rate, the confirmed cost and the countdown`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 60,
          rateBasis: "HOURLY",
          thresholdRate: 3,
          measuredRate: 3.5,
          predictedCost: 72,
          hoursToBudgetExhaustion: 8,
          lastReportedAt: "2026-08-11T08:00:00.000Z",
          insight: {
            kind: "COMPOSITION",
            service: "Amazon Bedrock",
            amount: 52.1,
            shareOfComparedSpend: 0.87,
          },
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        // The limit and measured rate are independent of the projection basis.
        expect(body).toContain(
          "has exceeded its configured spend rate limit of USD 3.00/hour; the measured rate is USD 3.50/hour",
        );
        expect(body).toContain("rather than a confirmed charge");
        expect(body).toContain("The last confirmed cost was USD 60.00");
        expect(body).toContain("observed");
        expect(body).not.toContain("At the current rate");
        expect(body).toContain("The projected cost is USD 72.00");
        expect(body).toContain(
          "the USD 100.00 budget would be exhausted in about 8 hours",
        );
        expect(body).toContain(
          "The largest service is Amazon Bedrock, USD 52.10 (87%)",
        );
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} names the unbilled Bedrock usage and states the countdown at its own rate in a separate sentence`, async () => {
      // The token poll's spend-rate alert: the measured hourly rate crossed
      // the limit, and the countdown burns at the summed daily rate.
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 200,
          totalSpend: 2.22,
          rateBasis: "HOURLY",
          thresholdRate: 3,
          measuredRate: 5.55,
          predictedCost: 8.9,
          hoursToBudgetExhaustion: 34,
          countdownRate: 133.2,
          countdownRateSource: "DAILY",
          unbilledBedrockTokenCost: 5.45,
          lastReportedAt: now().minus({ hours: 11 }).toISO(),
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "The last confirmed cost was USD 2.22, observed 11 hours ago, plus USD 5.45 of Bedrock token usage not yet billed. The projected cost is USD 8.90, the assigned budget is USD 200.00. At USD 133.20/day including monitored Bedrock token cost, the USD 200.00 budget would be exhausted in about 34 hours.",
        );
        // The measured limit rate did not carry the projection.
        expect(body).not.toContain("At the current rate");
        expect(body).not.toContain("At USD 5.55/hour");
        expect(body).not.toContain("undefined");
      }
    });

    it.each([
      ["zero", { unbilledBedrockTokenCost: 0 }],
      ["missing", {}],
      ["under a rounded cent", { unbilledBedrockTokenCost: 0.004 }],
    ])(
      `should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} adds no unbilled Bedrock usage where it is %s`,
      async (_case, added) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
          {
            leaseId: {
              userEmail: "someone@example.com",
              uuid: "750e8400-e29b-41d4-a716-446655440002",
            },
            accountId: "123456789012",
            totalSpend: 2.22,
            rateBasis: "HOURLY",
            thresholdRate: 3,
            measuredRate: 3.5,
            ...added,
          },
        );

        for (const body of Object.values(budgetAlertBodies())) {
          expect(body).toContain("The last confirmed cost was USD 2.22.");
          expect(body).not.toContain("not yet billed");
        }
      },
    );

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} states a daily limit per day`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 500,
          totalSpend: 105,
          rateBasis: "DAILY",
          thresholdRate: 50,
          measuredRate: 52.004,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "spend rate limit of USD 50.00/day; the measured rate is USD 52.00/day",
        );
        expect(body).toContain("The assigned budget is USD 500.00.");
        expect(body).not.toContain("At the current rate");
        expect(body).not.toContain("/hour");
        expect(body).not.toContain("undefined");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} states a rising CHANGE insight as "up"`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 60,
          budgetThresholdTriggered: 70,
          actionRequested: "ALERT",
          triggeredBy: "REPORTED",
          insight: {
            kind: "CHANGE",
            service: "Amazon Bedrock",
            amount: 52.1,
            changePercent: 112,
          },
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "The biggest change is Amazon Bedrock, up 112% since the previous interval, now USD 52.10",
        );
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} names the budget without a countdown when the projection overshoots it`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 60,
          budgetThresholdTriggered: 70,
          actionRequested: "ALERT",
          triggeredBy: "PREDICTED",
          predictedCost: 150,
          rate: 4,
          rateSource: "HOURLY",
          // predictedCost overshoots the budget, so the countdown is non-positive.
          hoursToBudgetExhaustion: -12.5,
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain("the assigned budget is USD 100.00");
        expect(body).not.toContain("exhausted");
        expect(body).not.toContain("-12");
        expect(body).not.toContain("about -");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} reads a sub-hour countdown as "within the hour"`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          budget: 100,
          totalSpend: 96,
          budgetThresholdTriggered: 70,
          actionRequested: "ALERT",
          triggeredBy: "PREDICTED",
          predictedCost: 99,
          rate: 3.5,
          rateSource: "HOURLY",
          // (100 - 99) / 3.5 ~= 0.29h: positive, but rounds to zero hours.
          hoursToBudgetExhaustion: 0.29,
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        expect(body).toContain(
          "the USD 100.00 budget would be exhausted within the hour",
        );
        expect(body).not.toContain("in about 0 hour");
      }
    });

    it(`should send email - ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} states the rate as a whole sentence when there is no projection or budget to follow it`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        {
          leaseId: {
            userEmail: "someone@example.com",
            uuid: "750e8400-e29b-41d4-a716-446655440002",
          },
          accountId: "123456789012",
          // No maxSpend on the lease, so no budget and no countdown, and no
          // predicted cost. The rate must not trail off as a fragment.
          totalSpend: 60,
          rateBasis: "HOURLY",
          thresholdRate: 3,
          measuredRate: 3.5,
          insight: null,
        },
      );

      for (const body of Object.values(budgetAlertBodies())) {
        // The lead already states the measured rate as a complete sentence, so
        // no rate sentence follows it.
        expect(body).toContain(
          "the measured rate is USD 3.50/hour, an estimate of how fast cost is accruing rather than a confirmed charge.",
        );
        expect(body).toContain("The last confirmed cost was USD 60.00.");
        expect(body).not.toContain("At the current rate of");
        expect(body).not.toMatch(/At the current rate of USD [\d.]+\/hour\./);
        expect(body).not.toContain("assigned budget");
        expect(body).not.toContain("undefined");
      }
    });

    it("escapes an interpolated service name in the html body and strips control characters from the text body", () => {
      const context = {
        webAppUrl: "https://www.example.com",
        destination: { to: ["someone@example.com"] },
      };
      const base = {
        leaseId: {
          userEmail: "someone@example.com",
          uuid: "750e8400-e29b-41d4-a716-446655440002",
        },
        accountId: "123456789012",
        totalSpend: 60,
        budgetThresholdTriggered: 70,
        actionRequested: "ALERT" as const,
        triggeredBy: "REPORTED" as const,
      };

      // The template must be safe whatever reaches it, so this bypasses the
      // schema (whose charset bound would reject these values) and calls the
      // template directly with a hand-built detail.
      const markup = EmailTemplates.LeaseBudgetAlert(
        {
          Detail: {
            ...base,
            insight: {
              kind: "NEW_ENTRANT",
              service: "<img src=x onerror=alert(1)>",
              amount: 5,
            },
          },
        } as any,
        context,
      );
      expect(markup.htmlBody).toContain(
        "New this interval: &lt;img src=x onerror=alert(1)&gt;",
      );
      expect(markup.htmlBody).not.toContain("<img");

      // Exercise the other three replacements and the load-bearing &-first
      // ordering, so a helper that drops or misorders them fails here.
      const allMetachars = EmailTemplates.LeaseBudgetAlert(
        {
          Detail: {
            ...base,
            insight: {
              kind: "NEW_ENTRANT",
              service: `&<>"'`,
              amount: 5,
            },
          },
        } as any,
        context,
      );
      expect(allMetachars.htmlBody).toContain("&amp;&lt;&gt;&quot;&#39;");

      const injected = EmailTemplates.LeaseBudgetAlert(
        {
          Detail: {
            ...base,
            insight: {
              kind: "NEW_ENTRANT",
              service: "Fake\n\nYour account is safe",
              amount: 5,
            },
          },
        } as any,
        context,
      );
      // The newlines that would render as extra sentences are gone.
      expect(injected.textBody).toContain(
        "New this interval: FakeYour account is safe, USD 5.00.",
      );
    });

    it(`should send email - ${EventDetailTypes.LeaseExpiredAlert}`, async () => {
      const isbAlert = generateSchemaData(LeaseExpirationAlertEventSchema);
      await synthesizeAndSendNotificationEmail(
        "LeaseDurationThresholdAlert",
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Lease Threshold Alert/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });
    it(`should send email - ${EventDetailTypes.AccountCleanupFailure}`, async () => {
      const isbAlert = generateSchemaData(AccountCleanupFailureEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AccountCleanupFailure,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action Required\] Innovation Sandbox: Account Clean-up Failure/,
        numSesMockCalls: 1,
        bccAddresses: adminOnlyEmails,
      });
    });
    it(`should send email - ${EventDetailTypes.AccountDriftDetected}`, async () => {
      const isbAlert = generateSchemaData(AccountDriftEventSchema, {
        expectedOu: "Active",
        actualOu: "Quarantine",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AccountDriftDetected,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Action Required\] Innovation Sandbox: Account Drift/,
        numSesMockCalls: 1,
        bccAddresses: adminOnlyEmails,
        body: `The account ID: ${isbAlert.accountId}`,
      });
    });

    it(`should send email - ${EventDetailTypes.AccountDriftDetected} - Untracked Account`, async () => {
      const isbAlert = generateSchemaData(AccountDriftEventSchema, {
        expectedOu: undefined,
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AccountDriftDetected,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Action Required\] Innovation Sandbox: Account Drift/,
        numSesMockCalls: 1,
        bccAddresses: adminOnlyEmails,
        body: "Untracked account ID:",
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} by duration`, async () => {
      const LeaseTerminatedByDurationEventSchema =
        LeaseTerminatedEventSchema.extend({
          reason: LeaseTerminatedByDurationSchema,
        });
      const isbAlert = generateSchemaData(LeaseTerminatedByDurationEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Clean-up Action based on Lease Duration/,
        adminManagerSubject:
          /\[Informational\] Innovation Sandbox: Account Clean-up Action based on Lease Duration/,
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} by budget`, async () => {
      const LeaseTerminatedByBudgetEventSchema =
        LeaseTerminatedEventSchema.extend({
          reason: LeaseTerminatedByBudgetSchema,
        });
      const isbAlert = generateSchemaData(LeaseTerminatedByBudgetEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Clean-up Action based on Allowed Budget/,
        adminManagerSubject:
          /\[Informational\] Innovation Sandbox: Account Clean-up Action based on Allowed Budget/,
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} manually terminated`, async () => {
      const LeaseManuallyEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedManualSchema,
      });
      const isbAlert = generateSchemaData(LeaseManuallyEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Manual Account Clean-up Action/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send no email - ${EventDetailTypes.LeaseTerminated} user terminated`, async () => {
      const LeaseUserTerminatedEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedByUserSchema,
      });
      const isbAlert = generateSchemaData(LeaseUserTerminatedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      expect(sesMock.calls().length).toEqual(0);
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} quarantined`, async () => {
      const QuarantinedEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedQuarantinedSchema,
      });
      const isbAlert = generateSchemaData(QuarantinedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Account Quarantined Action/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} ejected`, async () => {
      const EjectedEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedEjectedSchema,
      });
      const isbAlert = generateSchemaData(EjectedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Account Ejected Action/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} provisioning failed`, async () => {
      const ProvisioningFailedEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedProvisioningFailedSchema,
      });
      const isbAlert = generateSchemaData(ProvisioningFailedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Blueprint Deployment Failed/,
        adminManagerSubject:
          /\[Action Required\] Innovation Sandbox: Blueprint Deployment Failed/,
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseProvisioningFailed}`, async () => {
      const isbAlert = generateSchemaData(LeaseProvisioningFailedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseProvisioningFailed,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action Required\] Innovation Sandbox: Blueprint Deployment Failed/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails, ...managerEmails],
        body: "Blueprint deployment failed",
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by duration`, async () => {
      const LeaseFrozenByDurationEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenByDurationSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenByDurationEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Freeze Action based on Lease Duration/,
        adminManagerSubject:
          /\[Action Required\] Innovation Sandbox: Account Freeze Action based on Lease Duration/,
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by budget`, async () => {
      const LeaseFrozenByBudgetEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenByBudgetSchema,
      });
      // `reason` is pinned whole because sendNotificationEmail parses the
      // unnarrowed LeaseFrozenEventSchema, whose reason union pairs triggeredBy
      // with rateSource; zocker populates the two independently.
      const isbAlert = generateSchemaData(LeaseFrozenByBudgetEventSchema, {
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          budget: 100,
          totalSpend: 72,
          triggeredBy: "PREDICTED",
          rateSource: "HOURLY",
        },
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Freeze Action based on Allowed Budget/,
        adminManagerSubject:
          /\[Action Required\] Innovation Sandbox: Account Freeze Action based on Allowed Budget/,
      });
    });

    function frozenDetail(reason: Record<string, unknown>) {
      return {
        leaseId: {
          userEmail: "user@example.com",
          uuid: "750e8400-e29b-41d4-a716-446655440002",
        },
        accountId: "123456789012",
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          ...reason,
        },
      };
    }

    // Every shape of a predicted freeze the schema admits: the rate basis is
    // required on a projection, so each basis is exercised with and without the
    // optional budget. The confirmed cost sits below the line, as it must for
    // the projection rather than the billed total to have crossed it.
    it.each([
      {
        label: "on the daily rate against a budget",
        reason: { budget: 100, rateSource: "DAILY" },
        lead: "is projected to reach the freeze threshold of USD 70.00 against the assigned budget of USD 100.00. That figure is an estimate from the current spend rate per day, not a confirmed charge",
      },
      {
        label: "on the hourly rate against a budget",
        reason: { budget: 100, rateSource: "HOURLY" },
        lead: "is projected to reach the freeze threshold of USD 70.00 against the assigned budget of USD 100.00. That figure is an estimate from the current spend rate per hour, not a confirmed charge",
      },
      {
        label: "on the daily rate with no budget",
        reason: { rateSource: "DAILY" },
        lead: "is projected to reach the freeze threshold of USD 70.00. That figure is an estimate from the current spend rate per day, not a confirmed charge",
      },
      {
        label: "on the hourly rate with no budget",
        reason: { rateSource: "HOURLY" },
        lead: "is projected to reach the freeze threshold of USD 70.00. That figure is an estimate from the current spend rate per hour, not a confirmed charge",
      },
    ])(
      `should send email - ${EventDetailTypes.LeaseFrozen} by a predicted breach $label reads as an estimate in both emails`,
      async ({ reason, lead }) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseFrozen,
          frozenDetail({ totalSpend: 60, triggeredBy: "PREDICTED", ...reason }),
        );
        for (const body of frozenBodies()) {
          expect(body).toContain(lead);
          expect(body).toContain("the last confirmed cost was USD 60.00");
          expect(body).not.toContain("has reached");
          expect(body).not.toContain("NaN");
          expect(body).not.toContain("undefined");
        }
      },
    );

    it.each([
      ["without triggeredBy, as the previous release emits it", {}],
      ["with triggeredBy REPORTED", { triggeredBy: "REPORTED" }],
    ])(
      `should send email - ${EventDetailTypes.LeaseFrozen} by a billed breach %s keeps the billed wording`,
      async (_label, trigger) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseFrozen,
          frozenDetail({ budget: 100, totalSpend: 72, ...trigger }),
        );
        for (const body of frozenBodies()) {
          expect(body).toContain(
            "has been frozen since usage cost has reached the freeze threshold of USD 70.00 against the assigned budget of USD 100.00.",
          );
          expect(body).not.toContain("projected");
          expect(body).not.toContain("estimate");
        }
      },
    );

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by a billed breach with no budget names only the threshold`, async () => {
      // The previous release rendered an absent budget as "USD undefined";
      // the clause is now omitted instead.
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        frozenDetail({ totalSpend: 72 }),
      );
      for (const body of frozenBodies()) {
        expect(body).toContain(
          "has been frozen since usage cost has reached the freeze threshold of USD 70.00.",
        );
        expect(body).not.toContain("against the assigned budget");
        expect(body).not.toContain("undefined");
      }
    });

    function spendRateFrozenDetail(reason: Record<string, unknown>) {
      return {
        leaseId: {
          userEmail: "user@example.com",
          uuid: "750e8400-e29b-41d4-a716-446655440002",
        },
        accountId: "123456789012",
        reason: {
          type: "SpendRateExceeded",
          rateBasis: "HOURLY",
          thresholdRate: 15,
          measuredRate: 16,
          totalSpend: 72,
          ...reason,
        },
      };
    }

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by spend rate`, async () => {
      const LeaseFrozenBySpendRateEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenBySpendRateSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenBySpendRateEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Freeze Action based on Spend Rate Limit/,
        adminManagerSubject:
          /\[Action Required\] Innovation Sandbox: Account Freeze Action based on Spend Rate Limit/,
      });
    });

    it.each([
      {
        label: "hourly against a budget",
        reason: { budget: 200 },
        lead: "has been frozen because its spend rate of USD 16.00/hour exceeded the spend rate limit of USD 15.00/hour. A spend rate is an estimate of how fast cost is accruing, not a confirmed charge; the last confirmed cost was USD 72.00 against the assigned budget of USD 200.00.",
      },
      {
        label: "daily with no budget",
        reason: {
          rateBasis: "DAILY",
          thresholdRate: 12.5,
          measuredRate: 13.456,
        },
        lead: "has been frozen because its spend rate of USD 13.46/day exceeded the spend rate limit of USD 12.50/day. A spend rate is an estimate of how fast cost is accruing, not a confirmed charge; the last confirmed cost was USD 72.00.",
      },
    ])(
      `should send email - ${EventDetailTypes.LeaseFrozen} by spend rate $label names the limit and measured rate in both emails`,
      async ({ reason, lead }) => {
        await synthesizeAndSendNotificationEmail(
          EventDetailTypes.LeaseFrozen,
          spendRateFrozenDetail(reason),
        );
        const subjects = [0, 1].map(
          (callIndex) =>
            sesMock.commandCalls(SendEmailCommand)[callIndex]!.args[0]!.input!
              .Message!.Subject!.Data!,
        );
        for (const subject of subjects) {
          expect(subject).toContain(
            "Account Freeze Action based on Spend Rate Limit",
          );
        }
        for (const body of frozenBodies()) {
          expect(body).toContain(lead);
          expect(body).not.toContain("freeze threshold");
          expect(body).not.toContain("budget threshold");
          expect(body).not.toContain("NaN");
          expect(body).not.toContain("undefined");
        }
      },
    );

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by budget still names the allowed budget, not a spend rate limit`, async () => {
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        frozenDetail({ budget: 100, totalSpend: 72, triggeredBy: "REPORTED" }),
      );
      const subjects = [0, 1].map(
        (callIndex) =>
          sesMock.commandCalls(SendEmailCommand)[callIndex]!.args[0]!.input!
            .Message!.Subject!.Data!,
      );
      for (const subject of subjects) {
        expect(subject).toContain(
          "Account Freeze Action based on Allowed Budget",
        );
        expect(subject).not.toContain("Spend Rate");
      }
      for (const body of frozenBodies()) {
        expect(body).not.toContain("spend rate limit");
        expect(body).not.toContain("undefined");
      }
    });

    it(`should not send email - ${EventDetailTypes.LeaseFrozen} by spend rate missing its measured rate`, async () => {
      const { reason } = spendRateFrozenDetail({});
      const { measuredRate: _measuredRate, ...incomplete } = reason;
      await expect(
        synthesizeAndSendNotificationEmail(EventDetailTypes.LeaseFrozen, {
          ...spendRateFrozenDetail({}),
          reason: incomplete,
        }),
      ).rejects.toThrow();
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it(`should send email - {EventDetailTypes.LeaseFrozen} manually frozen`, async () => {
      const LeaseFrozenManualEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenManualSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenManualEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Account Frozen Action/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseUnfrozen}`, async () => {
      const isbAlert = generateSchemaData(LeaseUnfrozenEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.LeaseUnfrozen,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Lease Unfrozen/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.GroupCostReportGenerated}`, async () => {
      const isbAlert = generateSchemaData(GroupCostReportGeneratedEventSchema);
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.GroupCostReportGenerated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Monthly Cost Report Generated/,
        numSesMockCalls: 1,
        bccAddresses: adminOnlyEmails,
        body: isbAlert.reportMonth,
      });
    });

    it(`should send email - ${EventDetailTypes.GroupCostReportGeneratedFailure}`, async () => {
      const isbAlert = generateSchemaData(
        GroupCostReportGenerationFailureEventSchema,
        { reportMonth: "2024-06" },
      );
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.GroupCostReportGeneratedFailure,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: new RegExp(
          `Group Cost Report Generation Failed - ${isbAlert.reportMonth}`,
        ),
        numSesMockCalls: 1,
        bccAddresses: adminOnlyEmails,
        body: "Group Cost Report Generation Failed",
      });
    });

    it(`should send email - ${EventDetailTypes.AssignmentCreated} with assigneeEmail`, async () => {
      const isbAlert = generateSchemaData(AssignmentCreatedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "USER",
        assigneeEmail: "assignee@example.com",
        accountId: "123456789012",
        addedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AssignmentCreated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Access granted to a lease/,
        numSesMockCalls: 1,
        toAddresses: ["owner@example.com", "assignee@example.com"],
        body: "Access for assignee@example.com",
      });
    });

    it(`should send email - ${EventDetailTypes.AssignmentCreated} without assigneeEmail (group)`, async () => {
      const isbAlert = generateSchemaData(AssignmentCreatedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "GROUP",
        assigneeEmail: undefined,
        addedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AssignmentCreated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Access granted to a lease/,
        numSesMockCalls: 1,
        toAddresses: ["owner@example.com"],
        body: "Access for d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });
    });

    it(`should send email - ${EventDetailTypes.AssignmentCreated} deduplicates when leaseOwner equals assigneeEmail`, async () => {
      const isbAlert = generateSchemaData(AssignmentCreatedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "USER",
        assigneeEmail: "owner@example.com",
        addedBy: "admin@example.com",
        leaseOwner: "owner@example.com",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AssignmentCreated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Access granted to a lease/,
        numSesMockCalls: 1,
        toAddresses: ["owner@example.com"],
      });
    });

    it(`should send email - ${EventDetailTypes.AssignmentRemoved} with assigneeEmail`, async () => {
      const isbAlert = generateSchemaData(AssignmentRemovedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "USER",
        assigneeEmail: "assignee@example.com",
        accountId: "123456789012",
        removedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AssignmentRemoved,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Access removed from a lease/,
        numSesMockCalls: 1,
        toAddresses: ["owner@example.com", "assignee@example.com"],
        body: "assignee@example.com",
      });
    });

    it(`should send email - ${EventDetailTypes.AssignmentRemoved} without assigneeEmail (group)`, async () => {
      const isbAlert = generateSchemaData(AssignmentRemovedEventSchema, {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        principalId: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        principalType: "GROUP",
        assigneeEmail: undefined,
        removedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      await synthesizeAndSendNotificationEmail(
        EventDetailTypes.AssignmentRemoved,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Access removed from a lease/,
        numSesMockCalls: 1,
        toAddresses: ["owner@example.com"],
        body: "d-1234567890-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });
    });

    function assertSingleEmailActions(props: {
      subject: RegExp;
      numSesMockCalls: number;
      toAddresses?: string[];
      /**
       * Asserts the Bcc list is exactly this set (order-independent), not
       * merely a superset. `arrayContaining` alone would pass even if the
       * manager audience were silently dropped back to admins-only, so exact
       * sorted equality is the default here to prove neither leakage nor
       * omission of the manager audience.
       */
      bccAddresses?: string[];
      body?: string;
    }) {
      expect(sesMock.calls().length).toEqual(props.numSesMockCalls);

      const sendEmailCommand =
        sesMock.commandCalls(SendEmailCommand)[0]!.args[0]!.input!;

      expect(sendEmailCommand).toBeDefined();
      expect(sendEmailCommand.Source).toBe(fromAddress);
      expect(sendEmailCommand.Destination).toEqual({
        ToAddresses: props.toAddresses
          ? expect.arrayContaining(props.toAddresses)
          : undefined,
        BccAddresses: props.bccAddresses ? expect.any(Array) : undefined,
      });
      // arrayContaining above (for To) only proves a superset; Bcc must be
      // proven exact (order-independent) to catch a stray extra recipient
      // or a duplicate, which arrayContaining alone would miss.
      expect(
        sendEmailCommand.Destination?.BccAddresses?.slice().sort(),
      ).toEqual(
        props.bccAddresses ? [...props.bccAddresses].sort() : undefined,
      );
      expect(sendEmailCommand.Message).toEqual({
        Subject: {
          Data: expect.stringMatching(props.subject),
        },
        Body: {
          Html: {
            Data: expect.stringContaining(props.body ?? ""),
          },
          Text: {
            Data: expect.stringContaining(props.body ?? ""),
          },
        },
      });
    }

    function assertLeaseTerminatedFrozen(props: {
      toAddresses: string[];
      userSubject: RegExp;
      adminManagerSubject: RegExp;
    }) {
      expect(sesMock.calls().length).toEqual(2);

      const sendEmailCommand1 =
        sesMock.commandCalls(SendEmailCommand)[0]!.args[0]!.input!;
      const sendEmailCommand2 =
        sesMock.commandCalls(SendEmailCommand)[1]!.args[0]!.input!;

      expect(sendEmailCommand1.Source).toBe(fromAddress);
      expect(sendEmailCommand1.Destination).toEqual({
        ToAddresses: expect.arrayContaining([...props.toAddresses]),
        BccAddresses: undefined,
      });
      expect(sendEmailCommand1.Message).toEqual({
        Subject: {
          Data: expect.stringMatching(props.userSubject),
        },
        Body: expect.anything(),
      });

      expect(sendEmailCommand2.Source).toBe(fromAddress);
      expect(sendEmailCommand2.Destination).toEqual({
        ToAddresses: undefined,
        BccAddresses: expect.arrayContaining([
          ...adminEmails,
          ...managerEmails,
        ]),
      });
      // arrayContaining above only proves the manager+admin set isn't
      // missing; exact sorted equality additionally proves it isn't a
      // superset -- e.g. a stray extra recipient or a duplicate would pass
      // arrayContaining but fail here.
      expect(
        sendEmailCommand2.Destination?.BccAddresses?.slice().sort(),
      ).toEqual([...adminEmails, ...managerEmails].sort());
      expect(sendEmailCommand2.Message).toEqual({
        Subject: {
          Data: expect.stringMatching(props.adminManagerSubject),
        },
        Body: expect.anything(),
      });
    }
  });
});
