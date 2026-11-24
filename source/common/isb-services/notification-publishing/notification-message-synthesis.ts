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
  NotificationPublishMessage,
  RecipientPersona,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-publishing.types.js";
import {
  resolveAdminRecipients,
  resolveAssignmentRecipients,
  resolveManagerRecipients,
  resolveUserRecipients,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/recipient-resolvers.js";
import { EmailEventName } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import {
  EmailTemplates,
  EmailTemplatesContext,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";

/** A synthesized SES body plus the routing metadata the SNS wire message needs. */
export interface SynthesizedAudienceMessage {
  persona: RecipientPersona;
  recipientEmails: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  awsAccountId?: string;
  leaseUuid?: string;
}

/** Dependencies the router needs to resolve recipients and build template context for one event. */
export interface NotificationRoutingProps {
  webAppUrl: string;
  idcService: IdcService;
}

/**
 * A placeholder `EmailTemplatesContext` for calling `EmailTemplates`
 * functions that only read `context.webAppUrl` and never dereference
 * `context.destination.to`/`.bcc` in their returned body. The literal
 * recipient list for each audience is supplied separately by this module's
 * own resolver calls.
 */
function placeholderContext(webAppUrl: string): EmailTemplatesContext {
  return { webAppUrl, destination: { to: [] } };
}

/** Wraps one synthesized SES-content body into this audience's finished message. */
function toAudienceMessage(
  persona: RecipientPersona,
  recipientEmails: string[],
  synthesized: { subject: string; textBody: string; htmlBody: string },
  eventContext: { awsAccountId?: string; leaseUuid?: string },
): SynthesizedAudienceMessage {
  return {
    persona,
    recipientEmails,
    subject: synthesized.subject,
    textBody: synthesized.textBody,
    htmlBody: synthesized.htmlBody,
    ...eventContext,
  };
}

/**
 * The shared, channel-neutral router: the single switch on event/reason
 * that owns event parsing, template selection, persona/audience,
 * user-recipient extraction, manager-recipient resolution, and metadata for
 * every notification event. `EmailService` and the SNS publishing path
 * both call this rather than resolving recipients or picking templates
 * themselves, so there is exactly one place that decides who gets what for
 * a given event -- not one switch for content and a second, separately-
 * maintained switch for recipients.
 *
 * Managers and admins receive an identical combined message for most
 * manager-audience events: `resolveManagerRecipients` returns the union of
 * both, and that single result is what a `persona="manager"` message
 * carries. Four events are admin-only (`AccountCleanupFailed`,
 * `AccountDriftDetected`, `GroupCostReportGenerated`,
 * `GroupCostReportGeneratedFailure`): they carry `persona="admin"` and
 * resolve recipients via `resolveAdminRecipients`, which never includes
 * managers.
 *
 * Single-audience events return one message; dual-audience events
 * (budget/duration freeze/terminate) return two, one `persona="user"` and
 * one `persona="manager"`.
 */
export async function synthesizeNotificationMessages(
  emailEventName: EmailEventName,
  isbAlert: unknown,
  props: NotificationRoutingProps,
): Promise<SynthesizedAudienceMessage[]> {
  const context = placeholderContext(props.webAppUrl);
  const managerRecipients = () => resolveManagerRecipients(props.idcService);
  const adminRecipients = () => resolveAdminRecipients(props.idcService);
  switch (emailEventName) {
    case "LeaseRequested": {
      const event = LeaseRequestedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseRequested(event, context);
      return [
        toAudienceMessage("manager", await managerRecipients(), synthesized, {
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "LeaseApproved": {
      const event = LeaseApprovedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseApproved(event, context);
      const userRecipients = resolveUserRecipients(event.Detail.userEmail);
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          leaseUuid: event.Detail.leaseId,
        }),
      ];
    }
    case "LeaseDenied": {
      const event = LeaseDeniedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseDenied(event, context);
      const userRecipients = resolveUserRecipients(event.Detail.userEmail);
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          leaseUuid: event.Detail.leaseId,
        }),
      ];
    }
    case "LeaseBudgetThresholdAlert": {
      const event = LeaseBudgetThresholdBreachedAlert.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseBudgetAlert(event, context);
      const userRecipients = resolveUserRecipients(
        event.Detail.leaseId.userEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          awsAccountId: event.Detail.accountId,
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "LeaseSpendRateThresholdAlert": {
      const event = LeaseSpendRateThresholdBreachedAlert.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseSpendRateThresholdAlert(
        event,
        context,
      );
      const userRecipients = resolveUserRecipients(
        event.Detail.leaseId.userEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          awsAccountId: event.Detail.accountId,
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "LeaseDurationThresholdAlert": {
      const event = LeaseDurationThresholdBreachedAlert.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseDurationThresholdAlert(
        event,
        context,
      );
      const userRecipients = resolveUserRecipients(
        event.Detail.leaseId.userEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          awsAccountId: event.Detail.accountId,
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "AccountCleanupFailed": {
      const event = AccountCleanupFailureEvent.parse(isbAlert);
      const synthesized = EmailTemplates.AccountCleanupFailure(event, context);
      return [
        toAudienceMessage("admin", await adminRecipients(), synthesized, {
          awsAccountId: event.Detail.accountId,
        }),
      ];
    }
    case "AccountDriftDetected": {
      const event = AccountDriftDetectedAlert.parse(isbAlert);
      const synthesized = EmailTemplates.AccountDrift(event, context);
      return [
        toAudienceMessage("admin", await adminRecipients(), synthesized, {
          awsAccountId: event.Detail.accountId,
        }),
      ];
    }
    case "LeaseUnfrozen": {
      const event = LeaseUnfrozenEvent.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseUnfrozen(event, context);
      const userRecipients = resolveUserRecipients(
        event.Detail.leaseId.userEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          awsAccountId: event.Detail.accountId,
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "GroupCostReportGenerated": {
      const event = GroupCostReportGeneratedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.GroupCostReportGenerated(
        event,
        context,
      );
      return [
        toAudienceMessage("admin", await adminRecipients(), synthesized, {}),
      ];
    }
    case "GroupCostReportGeneratedFailure": {
      const event = GroupCostReportGeneratedFailureEvent.parse(isbAlert);
      const synthesized = EmailTemplates.GroupCostReportGenerationFailure(
        event,
        context,
      );
      return [
        toAudienceMessage("admin", await adminRecipients(), synthesized, {}),
      ];
    }
    case "LeaseProvisioningFailed": {
      const event = LeaseProvisioningFailedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.LeaseProvisioningFailed(
        event,
        context,
      );
      return [
        toAudienceMessage("manager", await managerRecipients(), synthesized, {
          awsAccountId: event.Detail.accountId,
          leaseUuid: event.Detail.leaseId.uuid,
        }),
      ];
    }
    case "AssignmentCreated": {
      const event = AssignmentCreatedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.AssignmentCreated(event, context);
      const userRecipients = resolveAssignmentRecipients(
        event.Detail.leaseOwner,
        event.Detail.assigneeEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          leaseUuid: event.Detail.leaseId,
        }),
      ];
    }
    case "AssignmentRemoved": {
      const event = AssignmentRemovedEvent.parse(isbAlert);
      const synthesized = EmailTemplates.AssignmentRemoved(event, context);
      const userRecipients = resolveAssignmentRecipients(
        event.Detail.leaseOwner,
        event.Detail.assigneeEmail,
      );
      return [
        toAudienceMessage("user", userRecipients, synthesized, {
          leaseUuid: event.Detail.leaseId,
        }),
      ];
    }
    case "LeaseFrozen": {
      return synthesizeLeaseFrozenMessages(
        isbAlert,
        context,
        managerRecipients,
      );
    }
    case "LeaseTerminated": {
      return synthesizeLeaseTerminatedMessages(
        isbAlert,
        context,
        managerRecipients,
      );
    }
    default:
      return assertNever(emailEventName);
  }
}

async function synthesizeLeaseFrozenMessages(
  isbAlert: unknown,
  context: EmailTemplatesContext,
  managerRecipients: () => Promise<string[]>,
): Promise<SynthesizedAudienceMessage[]> {
  const event = LeaseFrozenEvent.parse(isbAlert);
  const eventContext = {
    awsAccountId: event.Detail.accountId,
    leaseUuid: event.Detail.leaseId.uuid,
  };
  const userRecipients = resolveUserRecipients(event.Detail.leaseId.userEmail);
  switch (event.Detail.reason.type) {
    case "BudgetExceeded":
    case "SpendRateExceeded": {
      const typedEvent = event as LeaseFrozenEvent<
        "BudgetExceeded" | "SpendRateExceeded"
      >;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseFrozen.byBudgetUser(typedEvent, context),
          eventContext,
        ),
        toAudienceMessage(
          "manager",
          await managerRecipients(),
          EmailTemplates.LeaseFrozen.byBudgetAdminManager(typedEvent, context),
          eventContext,
        ),
      ];
    }
    case "Expired": {
      const typedEvent = event as LeaseFrozenEvent<"Expired">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseFrozen.byDurationUser(typedEvent, context),
          eventContext,
        ),
        toAudienceMessage(
          "manager",
          await managerRecipients(),
          EmailTemplates.LeaseFrozen.byDurationAdminManager(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    case "ManuallyFrozen": {
      const typedEvent = event as LeaseFrozenEvent<"ManuallyFrozen">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseFrozen.byManuallyFrozenUser(typedEvent, context),
          eventContext,
        ),
      ];
    }
    default: {
      // event.Detail.reason.type is a generic type parameter, not a plain
      // literal union, so TypeScript can't narrow it to never just by
      // exhausting the cases above. This cast narrows it for assertNever.
      const reasonType = (event.Detail.reason as { type: never }).type;
      return assertNever(reasonType);
    }
  }
}

async function synthesizeLeaseTerminatedMessages(
  isbAlert: unknown,
  context: EmailTemplatesContext,
  managerRecipients: () => Promise<string[]>,
): Promise<SynthesizedAudienceMessage[]> {
  const event = LeaseTerminatedEvent.parse(isbAlert);
  const eventContext = {
    awsAccountId: event.Detail.accountId,
    leaseUuid: event.Detail.leaseId.uuid,
  };
  const userRecipients = resolveUserRecipients(event.Detail.leaseId.userEmail);
  switch (event.Detail.reason.type) {
    case "BudgetExceeded": {
      const typedEvent = event as LeaseTerminatedEvent<"BudgetExceeded">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byBudgetUser(typedEvent, context),
          eventContext,
        ),
        toAudienceMessage(
          "manager",
          await managerRecipients(),
          EmailTemplates.LeaseTerminated.byBudgetAdminManager(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    case "Expired": {
      const typedEvent = event as LeaseTerminatedEvent<"Expired">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byDurationUser(typedEvent, context),
          eventContext,
        ),
        toAudienceMessage(
          "manager",
          await managerRecipients(),
          EmailTemplates.LeaseTerminated.byDurationAdminManager(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    case "ManuallyTerminated": {
      const typedEvent = event as LeaseTerminatedEvent<"ManuallyTerminated">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byManuallyTerminatedUser(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    case "UserTerminated": {
      // User self-termination sends no message on either channel: the UI
      // already shows a success toast.
      return [];
    }
    case "AccountQuarantined": {
      const typedEvent = event as LeaseTerminatedEvent<"AccountQuarantined">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byAccountQuarantinedUser(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    case "Ejected": {
      const typedEvent = event as LeaseTerminatedEvent<"Ejected">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byEjectedUser(typedEvent, context),
          eventContext,
        ),
      ];
    }
    case "ProvisioningFailed": {
      const typedEvent = event as LeaseTerminatedEvent<"ProvisioningFailed">;
      return [
        toAudienceMessage(
          "user",
          userRecipients,
          EmailTemplates.LeaseTerminated.byProvisioningFailedUser(
            typedEvent,
            context,
          ),
          eventContext,
        ),
        toAudienceMessage(
          "manager",
          await managerRecipients(),
          EmailTemplates.LeaseTerminated.byProvisioningFailedAdminManager(
            typedEvent,
            context,
          ),
          eventContext,
        ),
      ];
    }
    default: {
      // Same cause as the default case in synthesizeLeaseFrozenMessages
      // above: a generic type parameter, not a plain literal union.
      const reasonType = (event.Detail.reason as { type: never }).type;
      return assertNever(reasonType);
    }
  }
}

/**
 * Converts one synthesized audience message into the final publish model,
 * stamping `notificationType`. The publishing service adds `schemaVersion`
 * to the SNS message attributes. Split from `synthesizeNotificationMessages`
 * so the per-event-type switch above stays focused on content, while
 * wire-shape concerns remain at the publishing boundary.
 */
export function toPublishMessage(
  notificationType: string,
  message: SynthesizedAudienceMessage,
): NotificationPublishMessage {
  return {
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody,
    notificationType,
    recipientPersona: message.persona,
    recipientEmails: message.recipientEmails,
    awsAccountId: message.awsAccountId,
    leaseUuid: message.leaseUuid,
  };
}
