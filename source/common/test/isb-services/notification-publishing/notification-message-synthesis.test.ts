// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { AssignmentCreatedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-created-event.js";
import { AssignmentRemovedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-removed-event.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEvent } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  synthesizeNotificationMessages,
  toPublishMessage,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-message-synthesis.js";
import { NOTIFICATION_SCHEMA_VERSION } from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-publishing.types.js";
import { EmailTemplates } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import { describe, expect, it, vi } from "vitest";

const managerAudienceEmails = ["admin@example.com", "manager@example.com"];
const adminOnlyEmails = ["admin@example.com"];
const managerOnlyEmails = ["manager@example.com"];

// resolveManagerRecipients (recipient-resolvers.ts) calls allAdmins/allManagers
// (email-address-utils.ts), which are the seam mocked here -- the same seam
// email-service.test.ts and recipient-resolvers.test.ts use, so all three
// suites exercise the real resolveManagerRecipients union/dedup logic
// against a fixed IDC-backed fixture rather than each stubbing their own.
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
  async () => {
    const actual = (await vi.importActual(
      "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js",
    )) as any;
    return {
      ...actual,
      allAdmins: vi.fn().mockResolvedValue(["admin@example.com"]),
      allManagers: vi.fn().mockResolvedValue(["manager@example.com"]),
    };
  },
);

const webAppUrl = "https://isb.example.com";
// The IdcService instance is never dereferenced directly by this suite --
// resolveManagerRecipients only forwards it into the mocked allAdmins/
// allManagers calls above -- so an empty stub is sufficient here.
const idcService = {} as IdcService;
const routingProps = { webAppUrl, idcService };

describe("notification-message-synthesis", () => {
  describe("synthesizeNotificationMessages", () => {
    it("matches the SES-path subject/body for a single-audience event (LeaseApproved)", async () => {
      const event = new LeaseApprovedEvent({
        leaseId: "lease-uuid-1",
        approvedBy: "AUTO_APPROVED",
        userEmail: "user@example.com",
      });
      const sesExpected = EmailTemplates.LeaseApproved(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const [message] = await synthesizeNotificationMessages(
        "LeaseApproved",
        event.Detail,
        routingProps,
      );

      expect(message).toBeDefined();
      expect(message!.subject).toEqual(sesExpected.subject);
      expect(message!.textBody).toEqual(sesExpected.textBody);
      expect(message!.htmlBody).toEqual(sesExpected.htmlBody);
      expect(message!.persona).toEqual("user");
      expect(message!.recipientEmails).toEqual(["user@example.com"]);
      expect(message!.leaseUuid).toEqual("lease-uuid-1");
    });

    it("produces two publishes for a dual-audience event, one persona=user and one persona=manager, matching SES content for each and carrying the exact manager audience (admins and managers, no leakage or omission)", async () => {
      const event = new LeaseFrozenEvent<"BudgetExceeded">({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000002",
        },
        accountId: "123456789012",
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 100,
          totalSpend: 120,
        },
      });
      const userContext = {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      };
      const adminContext = {
        webAppUrl,
        destination: { bcc: managerAudienceEmails },
      };
      const sesUserExpected = EmailTemplates.LeaseFrozen.byBudgetUser(
        event,
        userContext,
      );
      const sesAdminExpected = EmailTemplates.LeaseFrozen.byBudgetAdminManager(
        event,
        adminContext,
      );

      const messages = await synthesizeNotificationMessages(
        "LeaseFrozen",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(2);
      const userMessage = messages.find((m) => m.persona === "user");
      const managerMessage = messages.find((m) => m.persona === "manager");
      expect(userMessage?.subject).toEqual(sesUserExpected.subject);
      expect(userMessage?.textBody).toEqual(sesUserExpected.textBody);
      expect(managerMessage?.subject).toEqual(sesAdminExpected.subject);
      expect(managerMessage?.textBody).toEqual(sesAdminExpected.textBody);
      expect(managerMessage?.recipientEmails.slice().sort()).toEqual(
        [...managerAudienceEmails].sort(),
      );
      expect(userMessage?.awsAccountId).toEqual("123456789012");
      expect(managerMessage?.awsAccountId).toEqual("123456789012");
      expect(userMessage?.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000002",
      );
      expect(managerMessage?.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000002",
      );
    });

    it("produces no messages for LeaseTerminated by UserTerminated, matching EmailService's no-email behavior for self-termination", async () => {
      const event = new LeaseTerminatedEvent<"UserTerminated">({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000003",
        },
        accountId: "123456789012",
        reason: { type: "UserTerminated", comment: "Terminated by user" },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseTerminated",
        event.Detail,
        routingProps,
      );

      expect(messages).toEqual([]);
    });

    it("produces a single-audience message for LeaseTerminated by ManuallyTerminated", async () => {
      const event = new LeaseTerminatedEvent<"ManuallyTerminated">({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000004",
        },
        accountId: "123456789012",
        reason: { type: "ManuallyTerminated", comment: "cleanup" },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseTerminated",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
    });

    it("matches the SES-path subject/body for LeaseRequested (manager audience) and carries the exact manager audience", async () => {
      const event = new LeaseRequestedEvent({
        leaseId: {
          userEmail: "requester@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000015",
        },
        userEmail: "requester@example.com",
        requiresManualApproval: true,
      });
      const sesExpected = EmailTemplates.LeaseRequested(event, {
        webAppUrl,
        destination: { bcc: managerAudienceEmails },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseRequested",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("manager");
      expect(messages[0]!.recipientEmails.slice().sort()).toEqual(
        [...managerAudienceEmails].sort(),
      );
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.htmlBody).toEqual(sesExpected.htmlBody);
      expect(messages[0]!.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000015",
      );
    });

    it("matches the SES-path subject/body for LeaseDenied (user-only)", async () => {
      const event = new LeaseDeniedEvent({
        leaseId: "lease-uuid-denied",
        deniedBy: "manager@example.com",
        userEmail: "user@example.com",
      });
      const sesExpected = EmailTemplates.LeaseDenied(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseDenied",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.leaseUuid).toEqual("lease-uuid-denied");
    });

    it("matches the SES-path subject/body for LeaseBudgetThresholdAlert and carries awsAccountId", async () => {
      const event = new LeaseBudgetThresholdBreachedAlert({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000005",
        },
        accountId: "123456789012",
        totalSpend: 50,
        budgetThresholdTriggered: 40,
        actionRequested: "ALERT",
      });
      const sesExpected = EmailTemplates.LeaseBudgetAlert(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseBudgetThresholdAlert",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.awsAccountId).toEqual("123456789012");
      expect(messages[0]!.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000005",
      );
    });

    it("matches the SES-path subject/body for LeaseSpendRateThresholdAlert, routes it to the lease user and carries awsAccountId", async () => {
      const event = new LeaseSpendRateThresholdBreachedAlert({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000017",
        },
        accountId: "123456789012",
        rateBasis: "HOURLY",
        thresholdRate: 12,
        measuredRate: 14,
        budget: 200,
        totalSpend: 60,
      });
      const sesExpected = EmailTemplates.LeaseSpendRateThresholdAlert(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseSpendRateThresholdAlert",
        event.Detail,
        routingProps,
      );

      expect(sesExpected.subject).toEqual(
        "[Action may be needed] Innovation Sandbox: Spend Rate Limit Alert",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        persona: "user",
        recipientEmails: ["user@example.com"],
        subject: sesExpected.subject,
        textBody: sesExpected.textBody,
        htmlBody: sesExpected.htmlBody,
        awsAccountId: "123456789012",
        leaseUuid: "b2c3d4e5-0000-4000-8000-000000000017",
      });
    });

    it("rejects a LeaseSpendRateThresholdAlert missing its measured rate", async () => {
      await expect(
        synthesizeNotificationMessages(
          "LeaseSpendRateThresholdAlert",
          {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "b2c3d4e5-0000-4000-8000-000000000017",
            },
            accountId: "123456789012",
            rateBasis: "HOURLY",
            thresholdRate: 12,
            totalSpend: 60,
          },
          routingProps,
        ),
      ).rejects.toThrow();
    });

    it("matches the SES-path subject/body for LeaseDurationThresholdAlert and carries awsAccountId", async () => {
      const event = new LeaseDurationThresholdBreachedAlert({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000006",
        },
        accountId: "123456789012",
        triggeredDurationThreshold: 10,
        leaseDurationInHours: 100,
        actionRequested: "ALERT",
      });
      const sesExpected = EmailTemplates.LeaseDurationThresholdAlert(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseDurationThresholdAlert",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.awsAccountId).toEqual("123456789012");
      expect(messages[0]!.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000006",
      );
    });

    it("matches the SES-path subject/body for AccountCleanupFailed and carries the exact admin-only audience, excluding managers", async () => {
      const event = new AccountCleanupFailureEvent({
        accountId: "123456789012",
        cleanupExecutionContext: {
          executionArn: "arn:aws:states:us-east-1:123456789012:execution:test",
          executionStartTime: "2026-01-01T00:00:00Z",
        },
        reason: "LEASE_TERMINATION",
      });
      const sesExpected = EmailTemplates.AccountCleanupFailure(event, {
        webAppUrl,
        destination: { bcc: adminOnlyEmails },
      });

      const messages = await synthesizeNotificationMessages(
        "AccountCleanupFailed",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("admin");
      expect(messages[0]!.recipientEmails.slice().sort()).toEqual(
        [...adminOnlyEmails].sort(),
      );
      for (const managerEmail of managerOnlyEmails) {
        expect(messages[0]!.recipientEmails).not.toContain(managerEmail);
      }
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.awsAccountId).toEqual("123456789012");
      expect(messages[0]!.leaseUuid).toBeUndefined();
    });

    it("matches the SES-path subject/body for AccountDriftDetected and carries the exact admin-only audience, excluding managers", async () => {
      const event = new AccountDriftDetectedAlert({
        accountId: "123456789012",
        expectedOu: "Available",
        actualOu: "Quarantine",
      });
      const sesExpected = EmailTemplates.AccountDrift(event, {
        webAppUrl,
        destination: { bcc: adminOnlyEmails },
      });

      const messages = await synthesizeNotificationMessages(
        "AccountDriftDetected",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("admin");
      expect(messages[0]!.recipientEmails.slice().sort()).toEqual(
        [...adminOnlyEmails].sort(),
      );
      for (const managerEmail of managerOnlyEmails) {
        expect(messages[0]!.recipientEmails).not.toContain(managerEmail);
      }
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.htmlBody).toEqual(sesExpected.htmlBody);
      expect(messages[0]!.awsAccountId).toEqual("123456789012");
    });

    it("matches the SES-path subject/body for LeaseUnfrozen (user-only) and carries awsAccountId", async () => {
      const event = new LeaseUnfrozenEvent({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000007",
        },
        accountId: "123456789012",
        maxBudget: 100,
        leaseDurationInHours: 200,
        reason: "Manually unfrozen by admin",
      });
      const sesExpected = EmailTemplates.LeaseUnfrozen(event, {
        webAppUrl,
        destination: { to: ["user@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseUnfrozen",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.awsAccountId).toEqual("123456789012");
      expect(messages[0]!.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000007",
      );
    });

    it("matches the SES-path subject/body for GroupCostReportGenerated and carries the exact admin-only audience, excluding managers", async () => {
      const event = new GroupCostReportGeneratedEvent({
        reportMonth: "2026-01",
        fileName: "report.csv",
        bucketName: "isb-reports-bucket",
        timestamp: "2026-02-01T00:00:00Z",
      });
      const sesExpected = EmailTemplates.GroupCostReportGenerated(event, {
        webAppUrl,
        destination: { bcc: adminOnlyEmails },
      });

      const messages = await synthesizeNotificationMessages(
        "GroupCostReportGenerated",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("admin");
      expect(messages[0]!.recipientEmails.slice().sort()).toEqual(
        [...adminOnlyEmails].sort(),
      );
      for (const managerEmail of managerOnlyEmails) {
        expect(messages[0]!.recipientEmails).not.toContain(managerEmail);
      }
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
    });

    it("matches the SES-path subject/body for GroupCostReportGeneratedFailure and carries the exact admin-only audience, excluding managers", async () => {
      const event = new GroupCostReportGeneratedFailureEvent({
        reportMonth: "2026-01",
        timestamp: "2026-02-01T00:00:00Z",
        logName: "/aws/lambda/group-cost-reporting",
      });
      const sesExpected = EmailTemplates.GroupCostReportGenerationFailure(
        event,
        {
          webAppUrl,
          destination: { bcc: adminOnlyEmails },
        },
      );

      const messages = await synthesizeNotificationMessages(
        "GroupCostReportGeneratedFailure",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("admin");
      expect(messages[0]!.recipientEmails.slice().sort()).toEqual(
        [...adminOnlyEmails].sort(),
      );
      for (const managerEmail of managerOnlyEmails) {
        expect(messages[0]!.recipientEmails).not.toContain(managerEmail);
      }
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
    });

    it("matches the SES-path subject/body for LeaseProvisioningFailed (admin+manager)", async () => {
      const event = new LeaseProvisioningFailedEvent({
        leaseId: {
          userEmail: "user@example.com",
          uuid: "b2c3d4e5-0000-4000-8000-000000000008",
        },
        accountId: "123456789012",
        blueprintName: "my-blueprint",
      });
      const sesExpected = EmailTemplates.LeaseProvisioningFailed(event, {
        webAppUrl,
        destination: { bcc: managerAudienceEmails },
      });

      const messages = await synthesizeNotificationMessages(
        "LeaseProvisioningFailed",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("manager");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000008",
      );
    });

    it("matches the SES-path subject/body for AssignmentCreated (user-only)", async () => {
      const event = new AssignmentCreatedEvent({
        leaseId: "lease-uuid-assignment-created",
        principalId: "assignee-principal",
        principalType: "USER",
        assigneeEmail: "assignee@example.com",
        accountId: "123456789012",
        addedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      const sesExpected = EmailTemplates.AssignmentCreated(event, {
        webAppUrl,
        destination: { to: ["assignee@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "AssignmentCreated",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.recipientEmails).toEqual([
        "owner@example.com",
        "assignee@example.com",
      ]);
      expect(messages[0]!.leaseUuid).toEqual("lease-uuid-assignment-created");
    });

    it("matches the SES-path subject/body for AssignmentRemoved (user-only)", async () => {
      const event = new AssignmentRemovedEvent({
        leaseId: "lease-uuid-assignment-removed",
        principalId: "assignee-principal",
        principalType: "USER",
        assigneeEmail: "assignee@example.com",
        accountId: "123456789012",
        removedBy: "owner@example.com",
        leaseOwner: "owner@example.com",
      });
      const sesExpected = EmailTemplates.AssignmentRemoved(event, {
        webAppUrl,
        destination: { to: ["assignee@example.com"] },
      });

      const messages = await synthesizeNotificationMessages(
        "AssignmentRemoved",
        event.Detail,
        routingProps,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]!.persona).toEqual("user");
      expect(messages[0]!.subject).toEqual(sesExpected.subject);
      expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      expect(messages[0]!.recipientEmails).toEqual([
        "owner@example.com",
        "assignee@example.com",
      ]);
      expect(messages[0]!.leaseUuid).toEqual("lease-uuid-assignment-removed");
    });

    describe("LeaseFrozen reason branches", () => {
      it("produces dual-audience messages for LeaseFrozen by Expired (duration)", async () => {
        const event = new LeaseFrozenEvent<"Expired">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000009",
          },
          accountId: "123456789012",
          reason: {
            type: "Expired",
            triggeredDurationThreshold: 10,
            leaseDurationInHours: 100,
          },
        });
        const userContext = {
          webAppUrl,
          destination: { to: ["user@example.com"] },
        };
        const adminContext = {
          webAppUrl,
          destination: { bcc: managerAudienceEmails },
        };
        const sesUserExpected = EmailTemplates.LeaseFrozen.byDurationUser(
          event,
          userContext,
        );
        const sesAdminExpected =
          EmailTemplates.LeaseFrozen.byDurationAdminManager(
            event,
            adminContext,
          );

        const messages = await synthesizeNotificationMessages(
          "LeaseFrozen",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(2);
        const userMessage = messages.find((m) => m.persona === "user");
        const managerMessage = messages.find((m) => m.persona === "manager");
        expect(userMessage?.subject).toEqual(sesUserExpected.subject);
        expect(userMessage?.textBody).toEqual(sesUserExpected.textBody);
        expect(managerMessage?.subject).toEqual(sesAdminExpected.subject);
        expect(managerMessage?.textBody).toEqual(sesAdminExpected.textBody);
        expect(userMessage?.awsAccountId).toEqual("123456789012");
        expect(managerMessage?.awsAccountId).toEqual("123456789012");
      });

      it("produces dual-audience messages for LeaseFrozen by SpendRateExceeded", async () => {
        const event = new LeaseFrozenEvent<"SpendRateExceeded">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000018",
          },
          accountId: "123456789012",
          reason: {
            type: "SpendRateExceeded",
            rateBasis: "HOURLY",
            thresholdRate: 15,
            measuredRate: 16,
            budget: 200,
            totalSpend: 72,
          },
        });
        const sesUserExpected = EmailTemplates.LeaseFrozen.byBudgetUser(event, {
          webAppUrl,
          destination: { to: ["user@example.com"] },
        });
        const sesAdminExpected =
          EmailTemplates.LeaseFrozen.byBudgetAdminManager(event, {
            webAppUrl,
            destination: { bcc: managerAudienceEmails },
          });

        const messages = await synthesizeNotificationMessages(
          "LeaseFrozen",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(2);
        const userMessage = messages.find((m) => m.persona === "user");
        const managerMessage = messages.find((m) => m.persona === "manager");
        expect(userMessage?.recipientEmails).toEqual(["user@example.com"]);
        expect(managerMessage?.recipientEmails.slice().sort()).toEqual(
          [...managerAudienceEmails].sort(),
        );
        expect(userMessage?.subject).toEqual(sesUserExpected.subject);
        expect(userMessage?.textBody).toEqual(sesUserExpected.textBody);
        expect(managerMessage?.subject).toEqual(sesAdminExpected.subject);
        expect(managerMessage?.textBody).toEqual(sesAdminExpected.textBody);
        for (const message of [userMessage, managerMessage]) {
          expect(message?.subject).toContain(
            "Account Freeze Action based on Spend Rate Limit",
          );
          expect(message?.textBody.replace(/\s+/g, " ")).toContain(
            "spend rate of USD 16.00/hour exceeded the spend rate limit of USD 15.00/hour",
          );
          expect(message?.textBody).not.toContain("undefined");
          expect(message?.awsAccountId).toEqual("123456789012");
        }
      });

      it("produces a single-audience user message for LeaseFrozen by ManuallyFrozen", async () => {
        const event = new LeaseFrozenEvent<"ManuallyFrozen">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000010",
          },
          accountId: "123456789012",
          reason: { type: "ManuallyFrozen", comment: "frozen by admin" },
        });
        const sesExpected = EmailTemplates.LeaseFrozen.byManuallyFrozenUser(
          event,
          { webAppUrl, destination: { to: ["user@example.com"] } },
        );

        const messages = await synthesizeNotificationMessages(
          "LeaseFrozen",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]!.persona).toEqual("user");
        expect(messages[0]!.subject).toEqual(sesExpected.subject);
        expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      });
    });

    describe("LeaseTerminated reason branches", () => {
      it("produces dual-audience messages for LeaseTerminated by BudgetExceeded", async () => {
        const userEmail = "user@example.com";
        const leaseUuid = "b2c3d4e5-0000-4000-8000-000000000016";
        const awsAccountId = "123456789012";
        const event = new LeaseTerminatedEvent<"BudgetExceeded">({
          leaseId: { userEmail, uuid: leaseUuid },
          accountId: awsAccountId,
          reason: {
            type: "BudgetExceeded",
            budget: 100,
            totalSpend: 120,
          },
        });
        const sesUserExpected = EmailTemplates.LeaseTerminated.byBudgetUser(
          event,
          {
            webAppUrl,
            destination: { to: [userEmail] },
          },
        );
        const sesManagerExpected =
          EmailTemplates.LeaseTerminated.byBudgetAdminManager(event, {
            webAppUrl,
            destination: { bcc: managerAudienceEmails },
          });

        const messages = await synthesizeNotificationMessages(
          "LeaseTerminated",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(2);
        expect(messages.find(({ persona }) => persona === "user")).toEqual({
          persona: "user",
          recipientEmails: [userEmail],
          subject: sesUserExpected.subject,
          textBody: sesUserExpected.textBody,
          htmlBody: sesUserExpected.htmlBody,
          awsAccountId,
          leaseUuid,
        });
        const managerMessage = messages.find(
          ({ persona }) => persona === "manager",
        );
        expect(managerMessage?.recipientEmails.slice().sort()).toEqual(
          [...managerAudienceEmails].sort(),
        );
        expect(managerMessage).toMatchObject({
          persona: "manager",
          subject: sesManagerExpected.subject,
          textBody: sesManagerExpected.textBody,
          htmlBody: sesManagerExpected.htmlBody,
          awsAccountId,
          leaseUuid,
        });
      });

      it("produces dual-audience messages for LeaseTerminated by Expired (duration)", async () => {
        const event = new LeaseTerminatedEvent<"Expired">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000011",
          },
          accountId: "123456789012",
          reason: { type: "Expired", leaseDurationInHours: 100 },
        });
        const userContext = {
          webAppUrl,
          destination: { to: ["user@example.com"] },
        };
        const adminContext = {
          webAppUrl,
          destination: { bcc: managerAudienceEmails },
        };
        const sesUserExpected = EmailTemplates.LeaseTerminated.byDurationUser(
          event,
          userContext,
        );
        const sesAdminExpected =
          EmailTemplates.LeaseTerminated.byDurationAdminManager(
            event,
            adminContext,
          );

        const messages = await synthesizeNotificationMessages(
          "LeaseTerminated",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(2);
        const userMessage = messages.find((m) => m.persona === "user");
        const managerMessage = messages.find((m) => m.persona === "manager");
        expect(userMessage?.subject).toEqual(sesUserExpected.subject);
        expect(userMessage?.textBody).toEqual(sesUserExpected.textBody);
        expect(managerMessage?.subject).toEqual(sesAdminExpected.subject);
        expect(managerMessage?.textBody).toEqual(sesAdminExpected.textBody);
      });

      it("produces a single-audience user message for LeaseTerminated by AccountQuarantined", async () => {
        const event = new LeaseTerminatedEvent<"AccountQuarantined">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000012",
          },
          accountId: "123456789012",
          reason: {
            type: "AccountQuarantined",
            comment: "quarantined by admin",
          },
        });
        const sesExpected =
          EmailTemplates.LeaseTerminated.byAccountQuarantinedUser(event, {
            webAppUrl,
            destination: { to: ["user@example.com"] },
          });

        const messages = await synthesizeNotificationMessages(
          "LeaseTerminated",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]!.persona).toEqual("user");
        expect(messages[0]!.subject).toEqual(sesExpected.subject);
        expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      });

      it("produces a single-audience user message for LeaseTerminated by Ejected", async () => {
        const event = new LeaseTerminatedEvent<"Ejected">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000013",
          },
          accountId: "123456789012",
          reason: { type: "Ejected", comment: "ejected by admin" },
        });
        const sesExpected = EmailTemplates.LeaseTerminated.byEjectedUser(
          event,
          { webAppUrl, destination: { to: ["user@example.com"] } },
        );

        const messages = await synthesizeNotificationMessages(
          "LeaseTerminated",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]!.persona).toEqual("user");
        expect(messages[0]!.subject).toEqual(sesExpected.subject);
        expect(messages[0]!.textBody).toEqual(sesExpected.textBody);
      });

      it("produces dual-audience messages for LeaseTerminated by ProvisioningFailed", async () => {
        const event = new LeaseTerminatedEvent<"ProvisioningFailed">({
          leaseId: {
            userEmail: "user@example.com",
            uuid: "b2c3d4e5-0000-4000-8000-000000000014",
          },
          accountId: "123456789012",
          reason: {
            type: "ProvisioningFailed",
            comment: "blueprint deployment failed",
          },
        });
        const userContext = {
          webAppUrl,
          destination: { to: ["user@example.com"] },
        };
        const adminContext = {
          webAppUrl,
          destination: { bcc: managerAudienceEmails },
        };
        const sesUserExpected =
          EmailTemplates.LeaseTerminated.byProvisioningFailedUser(
            event,
            userContext,
          );
        const sesAdminExpected =
          EmailTemplates.LeaseTerminated.byProvisioningFailedAdminManager(
            event,
            adminContext,
          );

        const messages = await synthesizeNotificationMessages(
          "LeaseTerminated",
          event.Detail,
          routingProps,
        );

        expect(messages).toHaveLength(2);
        const userMessage = messages.find((m) => m.persona === "user");
        const managerMessage = messages.find((m) => m.persona === "manager");
        expect(userMessage?.subject).toEqual(sesUserExpected.subject);
        expect(userMessage?.textBody).toEqual(sesUserExpected.textBody);
        expect(managerMessage?.subject).toEqual(sesAdminExpected.subject);
        expect(managerMessage?.textBody).toEqual(sesAdminExpected.textBody);
      });
    });
  });

  describe("toPublishMessage", () => {
    it("stamps notificationType and schemaVersion, and carries persona/recipients/body through unchanged", () => {
      const synthesized = {
        persona: "manager" as const,
        recipientEmails: ["admin@example.com"],
        subject: "Test subject",
        textBody: "Test body",
        htmlBody: "<p>Test body</p>",
        awsAccountId: "123456789012",
        leaseUuid: undefined,
      };

      const published = toPublishMessage("LeaseApproved", synthesized);

      expect(published).toEqual({
        subject: "Test subject",
        textBody: "Test body",
        htmlBody: "<p>Test body</p>",
        notificationType: "LeaseApproved",
        recipientPersona: "manager",
        recipientEmails: ["admin@example.com"],
        awsAccountId: "123456789012",
        leaseUuid: undefined,
      });
      // NOTIFICATION_SCHEMA_VERSION is stamped by the publishing service at
      // send time, not here.
      expect(NOTIFICATION_SCHEMA_VERSION).toEqual("1");
    });

    it("carries a defined leaseUuid through unchanged", () => {
      const synthesized = {
        persona: "user" as const,
        recipientEmails: ["user@example.com"],
        subject: "Test subject",
        textBody: "Test body",
        htmlBody: "<p>Test body</p>",
        leaseUuid: "b2c3d4e5-0000-4000-8000-000000000099",
      };

      const published = toPublishMessage("LeaseApproved", synthesized);

      expect(published.leaseUuid).toEqual(
        "b2c3d4e5-0000-4000-8000-000000000099",
      );
    });
  });
});
