// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ServiceEnv } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import type { SynthesizedAudienceMessage } from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-message-synthesis.js";
import { EmailEventName } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import { EmailDestination } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import {
  isSenderAddressCoveredBySesIdentity,
  parseValidatedSesIdentityArn,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/ses-identity.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  getNotificationErrorNames,
  NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
  NotificationFailureMetricLog,
} from "@amzn/innovation-sandbox-commons/observability/notification-metrics.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { isSyntheticM2mEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
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

type EmailSendFailure = {
  error: unknown;
  recipient?: string;
};

type EmailSendResult = {
  failures: readonly EmailSendFailure[];
  fatal?: { error: unknown };
};

export interface EmailServiceProps {
  fromAddress: string;
  logger: Logger;
  /**
   * ARN of a delegated SES sender identity (cross-account SES delegated
   * sending). When set, used as `SourceArn` on the send instead of the
   * hub account's own identity.
   */
  sesIdentityArn?: string;
}

export class EmailService {
  private readonly sesClient: SESClient;
  private readonly fromAddress: string;
  private readonly sesIdentityArn?: string;
  private readonly isbNamespace: string;
  private readonly logger: Logger;

  constructor(env: ServiceEnv.emailService, props: EmailServiceProps) {
    this.sesClient = IsbClients.ses(env);
    this.fromAddress = props.fromAddress;
    this.sesIdentityArn = props.sesIdentityArn;
    this.isbNamespace = env.ISB_NAMESPACE;
    this.logger = props.logger;

    if (
      this.sesIdentityArn &&
      !isSenderAddressCoveredBySesIdentity(
        parseValidatedSesIdentityArn(this.sesIdentityArn),
        this.fromAddress,
      )
    ) {
      // Never log the sender or identity value.
      this.logger.warn(
        "Configured emailFrom is not covered by the configured delegated SES identity",
      );
    }
  }

  /** Sends each non-empty audience message through SES. */
  async sendNotificationEmail(
    emailEventName: EmailEventName,
    messages: SynthesizedAudienceMessage[],
  ) {
    this.logger.info(`Sending email for ${emailEventName}`);
    for (const message of messages) {
      if (message.recipientEmails.length === 0) {
        continue;
      }

      const result = await this.sendEmailAttempt(toSynthesizedEmail(message));
      if (result.failures.length > 0) {
        this.logNotificationDeliveryFailure(
          result.failures.map(({ error }) => error),
          emailEventName,
        );
      }
      if (result.fatal) {
        throw result.fatal.error;
      }
    }
  }

  async sendEmail(email: SynthesizedEmail) {
    const result = await this.sendEmailAttempt(email);
    for (const failure of result.failures) {
      this.logger.error(
        failure.recipient
          ? `${LogPatterns.EmailSendingError.pattern} to ${failure.recipient}`
          : LogPatterns.EmailSendingError.pattern,
        failure.error instanceof Error ? failure.error : String(failure.error),
      );
    }
    if (result.fatal) {
      throw result.fatal.error;
    }
  }

  private async sendEmailAttempt(
    email: SynthesizedEmail,
  ): Promise<EmailSendResult> {
    // Synthetic M2M recipients cannot receive mail and would hard-bounce.
    if (email.to !== undefined) {
      const to = email.to.filter((address) => !isSyntheticM2mEmail(address));
      if (to.length === 0) {
        this.logger.warn(
          "Skipping email send: all to recipients are M2M synthetic addresses; this may indicate legacy data or a bypass path",
        );
        return { failures: [] };
      }
      email = { ...email, to };
    }

    const recipientCount = (email.to?.length ?? 0) + (email.bcc?.length ?? 0);
    if (recipientCount === 0) {
      this.logger.warn("Skipping email send: no recipients");
      return { failures: [] };
    }

    try {
      await this.batchSendEmail(email);
      return { failures: [] };
    } catch (error) {
      return this.handleSendEmailException(error, email);
    }
  }

  private async handleBisectableSendEmailException(
    error: unknown,
    email: SynthesizedEmail,
  ): Promise<EmailSendResult> {
    const allRecipients = [...(email.to ?? []), ...(email.bcc ?? [])];
    if (allRecipients.length === 1) {
      return {
        failures: [{ error, recipient: allRecipients[0]! }],
      };
    }
    return this.retryBisectSendEmail(email);
  }

  private async handleSendEmailException(
    error: unknown,
    email: SynthesizedEmail,
  ): Promise<EmailSendResult> {
    if (error instanceof SESServiceException) {
      switch (error.name) {
        case "AccessDenied":
        case "AccountSendingPausedException":
        case "ConfigurationSetDoesNotExistException":
        case "ConfigurationSetSendingPausedException":
          return {
            failures: [{ error }],
            fatal: { error },
          };
        case "InvalidParameterValueException":
        default:
          return this.handleBisectableSendEmailException(error, email);
      }
    }
    return this.handleBisectableSendEmailException(error, email);
  }

  private logNotificationDeliveryFailure(
    errors: readonly unknown[],
    notificationType: EmailEventName,
  ): void {
    const log: NotificationFailureMetricLog = {
      notificationMetricType: NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
      isbNamespace: this.isbNamespace,
      channel: "SES",
      notificationType,
      errorNames: getNotificationErrorNames(errors),
    };
    this.logger.error(LogPatterns.NotificationFailed.pattern, log);
  }

  private async retryBisectSendEmail(
    email: SynthesizedEmail,
  ): Promise<EmailSendResult> {
    const isBcc = email.bcc !== undefined;
    const recipients = isBcc ? email.bcc : email.to;
    const mid = Math.floor(recipients.length / 2);
    const firstEmail = isBcc
      ? { ...email, bcc: recipients.slice(0, mid) }
      : { ...email, to: recipients.slice(0, mid) };
    const secondEmail = isBcc
      ? { ...email, bcc: recipients.slice(mid) }
      : { ...email, to: recipients.slice(mid) };

    const firstResult = await this.sendEmailAttempt(firstEmail);
    if (firstResult.fatal) {
      return firstResult;
    }

    const secondResult = await this.sendEmailAttempt(secondEmail);
    return {
      failures: [...firstResult.failures, ...secondResult.failures],
      ...(secondResult.fatal ? { fatal: secondResult.fatal } : {}),
    };
  }

  private async batchSendEmail(email: SynthesizedEmail) {
    const sendEmailCommand = new SendEmailCommand({
      Source: this.fromAddress,
      ...(this.sesIdentityArn ? { SourceArn: this.sesIdentityArn } : {}),
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

/**
 * Converts one shared-routing audience message into the shape `sendEmail`
 * expects: `persona="user"` addresses go in `to`; `persona="manager"` and
 * `persona="admin"` both go in `bcc`. Every `EmailTemplates` function pairs
 * its audience with exactly one of the two, so persona alone determines
 * which field is populated.
 */
function toSynthesizedEmail(
  message: SynthesizedAudienceMessage,
): SynthesizedEmail {
  const base = {
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody ?? "",
  };
  return message.persona === "user"
    ? { ...base, to: message.recipientEmails }
    : { ...base, bcc: message.recipientEmails };
}
