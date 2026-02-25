// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEvent } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  IsbServices,
  ServiceEnv,
} from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  allAdmins,
  allManagers,
  union,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js";
import { EmailEventName } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import {
  EmailDestination,
  EmailTemplates,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import { AppInsightsLogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  SendEmailCommand,
  SESClient,
  SESServiceException,
} from "@aws-sdk/client-ses";

export type SynthesizedEmail = {
  subject: string;
  htmlBody: string;
  textBody: string;
} & EmailDestination;

export interface EmailServiceProps {
  fromAddress: string;
  webAppUrl: string;
  logger: Logger;
}

export class EmailService {
  private readonly sesClient: SESClient;
  private readonly fromAddress: string;
  private readonly webAppUrl: string;
  private readonly idcService: IdcService;
  private logger: Logger;

  constructor(env: ServiceEnv.emailService, props: EmailServiceProps) {
    this.sesClient = IsbClients.ses(env);
    this.fromAddress = props.fromAddress;
    this.webAppUrl = props.webAppUrl;
    this.idcService = IsbServices.idcService(
      env,
      fromTemporaryIsbIdcCredentials(env),
    );
    this.logger = props.logger;
  }

  async sendNotificationEmail(
    emailEventName: EmailEventName,
    isbAlert: unknown,
  ) {
    this.logger.info(`Sending email for ${emailEventName}`);
    switch (emailEventName) {
      case "LeaseRequested":
        const leaseRequestedEvent = LeaseRequestedEvent.parse(isbAlert);
        const leaseRequestedContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await union(
              await allAdmins(this.idcService),
              await allManagers(this.idcService),
            ),
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseRequested(
            leaseRequestedEvent,
            leaseRequestedContext,
          ),
        );
        break;
      case "LeaseApproved":
        const leaseApprovedEvent = LeaseApprovedEvent.parse(isbAlert);
        const leaseApprovedContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            to: [leaseApprovedEvent.Detail.userEmail],
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseApproved(
            leaseApprovedEvent,
            leaseApprovedContext,
          ),
        );
        break;
      case "LeaseDenied":
        const leaseDeniedEvent = LeaseDeniedEvent.parse(isbAlert);
        const leaseDeniedContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            to: [leaseDeniedEvent.Detail.userEmail],
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseDenied(leaseDeniedEvent, leaseDeniedContext),
        );
        break;
      case "LeaseBudgetThresholdAlert":
        const leaseBudgetEvent =
          LeaseBudgetThresholdBreachedAlert.parse(isbAlert);
        const leaseBudgetContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            to: [leaseBudgetEvent.Detail.leaseId.userEmail],
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseBudgetAlert(leaseBudgetEvent, leaseBudgetContext),
        );
        break;
      case "LeaseDurationThresholdAlert":
        const leaseDurationEvent =
          LeaseDurationThresholdBreachedAlert.parse(isbAlert);
        const leaseDurationContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            to: [leaseDurationEvent.Detail.leaseId.userEmail],
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseDurationThresholdAlert(
            leaseDurationEvent,
            leaseDurationContext,
          ),
        );
        break;
      case "AccountCleanupFailed":
        const cleanupFailureEvent = AccountCleanupFailureEvent.parse(isbAlert);
        const cleanupFailureContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await allAdmins(this.idcService),
          },
        };
        await this.sendEmail(
          EmailTemplates.AccountCleanupFailure(
            cleanupFailureEvent,
            cleanupFailureContext,
          ),
        );
        break;
      case "AccountDriftDetected":
        const driftEvent = AccountDriftDetectedAlert.parse(isbAlert);
        const driftContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await allAdmins(this.idcService),
          },
        };
        await this.sendEmail(
          EmailTemplates.AccountDrift(driftEvent, driftContext),
        );
        break;
      case "LeaseUnfrozen":
        const leaseUnfrozenEvent = LeaseUnfrozenEvent.parse(isbAlert);
        const leaseUnfrozenContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            to: [leaseUnfrozenEvent.Detail.leaseId.userEmail],
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseUnfrozen(
            leaseUnfrozenEvent,
            leaseUnfrozenContext,
          ),
        );
        break;
      case "GroupCostReportGenerated":
        const groupCostReportGeneratedEvent =
          GroupCostReportGeneratedEvent.parse(isbAlert);
        const groupCostReportGeneratedContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await allAdmins(this.idcService),
          },
        };
        await this.sendEmail(
          EmailTemplates.GroupCostReportGenerated(
            groupCostReportGeneratedEvent,
            groupCostReportGeneratedContext,
          ),
        );
        break;
      case "GroupCostReportGeneratedFailure":
        const groupCostReportGeneratedFailureEvent =
          GroupCostReportGeneratedFailureEvent.parse(isbAlert);
        const groupCostReportGeneratedFailureContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await allAdmins(this.idcService),
          },
        };
        await this.sendEmail(
          EmailTemplates.GroupCostReportGenerationFailure(
            groupCostReportGeneratedFailureEvent,
            groupCostReportGeneratedFailureContext,
          ),
        );
        break;
      case "LeaseTerminated":
        await this.sendTerminatedEmails(LeaseTerminatedEvent.parse(isbAlert));
        break;
      case "LeaseFrozen":
        await this.sendFrozenEmails(LeaseFrozenEvent.parse(isbAlert));
        break;
      case "LeaseProvisioningFailed":
        const leaseProvisioningFailedEvent =
          LeaseProvisioningFailedEvent.parse(isbAlert);
        const provisioningFailedContext = {
          webAppUrl: this.webAppUrl,
          destination: {
            bcc: await union(
              await allAdmins(this.idcService),
              await allManagers(this.idcService),
            ),
          },
        };
        await this.sendEmail(
          EmailTemplates.LeaseProvisioningFailed(
            leaseProvisioningFailedEvent,
            provisioningFailedContext,
          ),
        );
        break;
      default:
        assertNever(emailEventName);
    }
  }

  private async sendFrozenEmails(parsedEvent: LeaseFrozenEvent) {
    const eventType = parsedEvent.Detail.reason.type;
    const userEmailContext = {
      webAppUrl: this.webAppUrl,
      destination: {
        to: [parsedEvent.Detail.leaseId.userEmail],
      },
    };
    const adminManagerEmailContext = {
      webAppUrl: this.webAppUrl,
      destination: {
        bcc: await union(
          await allAdmins(this.idcService),
          await allManagers(this.idcService),
        ),
      },
    };
    switch (eventType) {
      case "BudgetExceeded":
        const leaseFrozenByBudgetEvent =
          parsedEvent as LeaseFrozenEvent<"BudgetExceeded">;
        await this.sendEmail(
          EmailTemplates.LeaseFrozen.byBudgetUser(
            leaseFrozenByBudgetEvent,
            userEmailContext,
          ),
        );
        await this.sendEmail(
          EmailTemplates.LeaseFrozen.byBudgetAdminManager(
            leaseFrozenByBudgetEvent,
            adminManagerEmailContext,
          ),
        );
        break;
      case "Expired":
        const leaseFrozenByDurationEvent =
          parsedEvent as LeaseFrozenEvent<"Expired">;
        await this.sendEmail(
          EmailTemplates.LeaseFrozen.byDurationUser(
            leaseFrozenByDurationEvent,
            userEmailContext,
          ),
        );
        await this.sendEmail(
          EmailTemplates.LeaseFrozen.byDurationAdminManager(
            leaseFrozenByDurationEvent,
            adminManagerEmailContext,
          ),
        );
        break;
      case "ManuallyFrozen":
        await this.sendEmail(
          EmailTemplates.LeaseFrozen.byManuallyFrozenUser(
            parsedEvent as LeaseFrozenEvent<"ManuallyFrozen">,
            userEmailContext,
          ),
        );
        break;
    }
  }

  private async sendTerminatedEmails(parsedEvent: LeaseTerminatedEvent) {
    const eventType = parsedEvent.Detail.reason.type;
    const userEmailContext = {
      webAppUrl: this.webAppUrl,
      destination: {
        to: [parsedEvent.Detail.leaseId.userEmail],
      },
    };
    const adminManagerEmailContext = {
      webAppUrl: this.webAppUrl,
      destination: {
        bcc: await union(
          await allAdmins(this.idcService),
          await allManagers(this.idcService),
        ),
      },
    };

    switch (eventType) {
      case "BudgetExceeded":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byBudgetUser(
            parsedEvent as LeaseTerminatedEvent<"BudgetExceeded">,
            userEmailContext,
          ),
        );
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byBudgetAdminManager(
            parsedEvent as LeaseTerminatedEvent<"BudgetExceeded">,
            adminManagerEmailContext,
          ),
        );
        break;
      case "Expired":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byDurationUser(
            parsedEvent as LeaseTerminatedEvent<"Expired">,
            userEmailContext,
          ),
        );
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byDurationAdminManager(
            parsedEvent as LeaseTerminatedEvent<"Expired">,
            adminManagerEmailContext,
          ),
        );
        break;
      case "ManuallyTerminated":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byManuallyTerminatedUser(
            parsedEvent as LeaseTerminatedEvent<"ManuallyTerminated">,
            userEmailContext,
          ),
        );
        break;
      case "AccountQuarantined":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byAccountQuarantinedUser(
            parsedEvent as LeaseTerminatedEvent<"AccountQuarantined">,
            userEmailContext,
          ),
        );
        break;
      case "Ejected":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byEjectedUser(
            parsedEvent as LeaseTerminatedEvent<"Ejected">,
            userEmailContext,
          ),
        );
        break;
      case "ProvisioningFailed":
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byProvisioningFailedUser(
            parsedEvent as LeaseTerminatedEvent<"ProvisioningFailed">,
            userEmailContext,
          ),
        );
        await this.sendEmail(
          EmailTemplates.LeaseTerminated.byProvisioningFailedAdminManager(
            parsedEvent as LeaseTerminatedEvent<"ProvisioningFailed">,
            adminManagerEmailContext,
          ),
        );
        break;
      default:
        assertNever(eventType);
    }
  }

  async sendEmail(email: SynthesizedEmail) {
    try {
      await this.batchSendEmail(email);
    } catch (error) {
      await this.handleSendEmailExceptions(error, email);
    }
  }

  private async handleBisectableSendEmailException(
    error: Error,
    email: SynthesizedEmail,
  ) {
    const allRecipients = [...(email.to ?? []), ...(email.bcc ?? [])];
    if (allRecipients.length === 1) {
      this.logger.error(
        `${AppInsightsLogPatterns.EmailSendingError.pattern} to ${allRecipients[0]}`,
        error,
      );
    } else {
      await this.retryBisectSendEmail(email);
    }
  }

  private async handleSendEmailExceptions(
    error: unknown,
    email: SynthesizedEmail,
  ) {
    if (error instanceof SESServiceException) {
      switch (error.name) {
        case "AccountSendingPausedException":
        case "ConfigurationSetDoesNotExistException":
        case "ConfigurationSetSendingPausedException":
          this.logger.error(
            AppInsightsLogPatterns.EmailSendingError.pattern,
            error,
          );
          throw error;
        case "InvalidParameterValueException":
        default:
          await this.handleBisectableSendEmailException(error, email);
          break;
      }
    } else {
      await this.handleBisectableSendEmailException(error as Error, email);
    }
  }

  private async retryBisectSendEmail(email: SynthesizedEmail) {
    const isBcc = email.bcc !== undefined;
    if (isBcc) {
      const mid = Math.floor(email.bcc!.length / 2);
      await this.sendEmail({
        ...email,
        bcc: email.bcc!.slice(0, mid),
      });
      await this.sendEmail({
        ...email,
        bcc: email.bcc!.slice(mid),
      });
    } else {
      const mid = Math.floor(email.to!.length / 2);
      await this.sendEmail({
        ...email,
        to: email.to!.slice(0, mid),
      });
      await this.sendEmail({
        ...email,
        to: email.to!.slice(mid),
      });
    }
  }

  private async batchSendEmail(email: SynthesizedEmail) {
    const sendEmailCommand = new SendEmailCommand({
      Source: this.fromAddress,
      Destination: {
        ToAddresses: email.to,
        BccAddresses: email.bcc,
      },
      Message: {
        Subject: {
          Data: email.subject,
        },
        Body: {
          Text: {
            Data: email.textBody,
          },
          Html: {
            Data: email.htmlBody,
          },
        },
      },
    });
    await this.sesClient.send(sendEmailCommand);
  }
}
