// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEventSchema } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftEventSchema } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
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
  LeaseFrozenEventSchema,
  LeaseFrozenManualSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseRequestedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import {
  LeaseTerminatedByBudgetSchema,
  LeaseTerminatedByDurationSchema,
  LeaseTerminatedEjectedSchema,
  LeaseTerminatedEventSchema,
  LeaseTerminatedManualSchema,
  LeaseTerminatedQuarantinedSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { SynthesizedEmail } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import { EmailNotificationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  SendEmailCommand,
  SESClient,
  SESServiceException,
} from "@aws-sdk/client-ses";
import { mockClient } from "aws-sdk-client-mock";
import { LeaseUnfrozenEventSchema } from "events/lease-unfrozen-event.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const managerEmails = ["manager@example.com", "manager2@example.com"];
const adminEmails = ["admin@example.com"];

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

const testEnv = generateSchemaData(EmailNotificationEnvironmentSchema);

const fromAddress = "example@example.com";
const emailService = IsbServices.emailService(
  {
    ...testEnv,
  },
  {
    fromAddress: fromAddress,
    webAppUrl: "https://www.example.com",
    logger: new Logger(),
  },
);

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

    it("should send all emails when in one call no exception is returned", async () => {
      sesMock.on(SendEmailCommand).resolves({
        MessageId: "test-message-id",
      });

      await emailService.sendEmail(testEmail);
      expect(sesMock.calls().length).toEqual(1);
    });
    it.each<string>([
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

  describe("Email routing", async () => {
    sesMock.on(SendEmailCommand).resolves({
      MessageId: "test-message-id",
    });

    it(`should send email - ${EventDetailTypes.LeaseRequested}`, async () => {
      const isbAlert = generateSchemaData(LeaseRequestedEventSchema);
      await emailService.sendNotificationEmail(
        EventDetailTypes.LeaseRequested,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action Needed\] Innovation Sandbox: New Lease Approval Request/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails, ...managerEmails],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseApproved}`, async () => {
      const isbAlert = generateSchemaData(LeaseApprovedEventSchema);
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
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
      const isbAlert = generateSchemaData(
        LeaseBudgetThresholdTriggeredEventSchema,
      );
      await emailService.sendNotificationEmail(
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

    it(`should send email - ${EventDetailTypes.LeaseExpiredAlert}`, async () => {
      const isbAlert = generateSchemaData(LeaseExpirationAlertEventSchema);
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
        EventDetailTypes.AccountCleanupFailure,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Action Required\] Innovation Sandbox: Account Clean-up Failure/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails],
      });
    });
    it(`should send email - ${EventDetailTypes.AccountDriftDetected}`, async () => {
      const isbAlert = generateSchemaData(AccountDriftEventSchema);
      await emailService.sendNotificationEmail(
        EventDetailTypes.AccountDriftDetected,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Action Required\] Innovation Sandbox: Account Drift/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails],
        body: `The account id: ${isbAlert.accountId}`,
      });
    });

    it(`should send email - ${EventDetailTypes.AccountDriftDetected} - Untracked Account`, async () => {
      const isbAlert = generateSchemaData(AccountDriftEventSchema, {
        expectedOu: undefined,
      });
      await emailService.sendNotificationEmail(
        EventDetailTypes.AccountDriftDetected,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Action Required\] Innovation Sandbox: Account Drift/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails],
        body: "Untracked account id:",
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseTerminated} by duration`, async () => {
      const LeaseTerminatedByDurationEventSchema =
        LeaseTerminatedEventSchema.extend({
          reason: LeaseTerminatedByDurationSchema,
        });
      const isbAlert = generateSchemaData(LeaseTerminatedByDurationEventSchema);
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
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

    it(`should send email - ${EventDetailTypes.LeaseTerminated} quarantined`, async () => {
      const QuarantinedEventSchema = LeaseTerminatedEventSchema.extend({
        reason: LeaseTerminatedQuarantinedSchema,
      });
      const isbAlert = generateSchemaData(QuarantinedEventSchema);
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
        EventDetailTypes.LeaseTerminated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: /\[Informational\] Innovation Sandbox: Account Ejected Action/,
        numSesMockCalls: 1,
        toAddresses: [isbAlert.leaseId.userEmail],
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by duration`, async () => {
      const LeaseFrozenByDurationEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenByDurationSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenByDurationEventSchema);
      await emailService.sendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Freeze Action based on Lease Duration/,
        adminManagerSubject:
          /\[Action Needed\] Innovation Sandbox: Account Freeze Action based on Lease Duration/,
      });
    });

    it(`should send email - ${EventDetailTypes.LeaseFrozen} by budget`, async () => {
      const LeaseFrozenByBudgetEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenByBudgetSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenByBudgetEventSchema);
      await emailService.sendNotificationEmail(
        EventDetailTypes.LeaseFrozen,
        isbAlert,
      );
      assertLeaseTerminatedFrozen({
        toAddresses: [isbAlert.leaseId.userEmail],
        userSubject:
          /\[Informational\] Innovation Sandbox: Account Freeze Action based on Allowed Budget/,
        adminManagerSubject:
          /\[Action Needed\] Innovation Sandbox: Account Freeze Action based on Allowed Budget/,
      });
    });

    it(`should send email - {EventDetailTypes.LeaseFrozen} manually frozen`, async () => {
      const LeaseFrozenManualEventSchema = LeaseFrozenEventSchema.extend({
        reason: LeaseFrozenManualSchema,
      });
      const isbAlert = generateSchemaData(LeaseFrozenManualEventSchema);
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
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
      await emailService.sendNotificationEmail(
        EventDetailTypes.GroupCostReportGenerated,
        isbAlert,
      );
      assertSingleEmailActions({
        subject:
          /\[Informational\] Innovation Sandbox: Monthly Cost Report Generated/,
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails],
        body: isbAlert.reportMonth,
      });
    });

    it(`should send email - ${EventDetailTypes.GroupCostReportGeneratedFailure}`, async () => {
      const isbAlert = generateSchemaData(
        GroupCostReportGenerationFailureEventSchema,
      );
      await emailService.sendNotificationEmail(
        EventDetailTypes.GroupCostReportGeneratedFailure,
        isbAlert,
      );
      assertSingleEmailActions({
        subject: new RegExp(
          `Group Cost Report Generation Failed - ${isbAlert.reportMonth}`,
        ),
        numSesMockCalls: 1,
        bccAddresses: [...adminEmails],
        body: "Group Cost Report Generation Failed",
      });
    });

    function assertSingleEmailActions(props: {
      subject: RegExp;
      numSesMockCalls: number;
      toAddresses?: string[];
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
        BccAddresses: props.bccAddresses
          ? expect.arrayContaining(props.bccAddresses)
          : undefined,
      });
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
      expect(sendEmailCommand2.Message).toEqual({
        Subject: {
          Data: expect.stringMatching(props.adminManagerSubject),
        },
        Body: expect.anything(),
      });
    }
  });
});
