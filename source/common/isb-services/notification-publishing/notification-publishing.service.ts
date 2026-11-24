// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PublishCommand } from "@aws-sdk/client-sns";

import {
  NOTIFICATION_SCHEMA_VERSION,
  NotificationPublishingServiceProps,
  NotificationPublishMessage,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-publishing.types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  getNotificationErrorNames,
  NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
  NotificationFailureMetricLog,
} from "@amzn/innovation-sandbox-commons/observability/notification-metrics.js";

/** SNS's hard limit on the `Subject` field: one line, at most 100 characters. */
const SNS_SUBJECT_MAX_LENGTH = 100;

/**
 * Collapses a subject to the single-line, <=100-character shape SNS's
 * `Publish` API requires. Each line is trimmed and blank lines are dropped,
 * then survivors are joined with a single space, so a multi-line subject
 * degrades to one readable line instead of being cut mid-word. Linear in
 * the input length -- deliberately avoids a `\s*\n\s*` style regex, whose
 * unanchored quantified whitespace runs can backtrack quadratically on
 * long whitespace-heavy input.
 */
function normalizeSnsSubject(subject: string): string {
  const singleLine = subject
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return singleLine.length > SNS_SUBJECT_MAX_LENGTH
    ? singleLine.slice(0, SNS_SUBJECT_MAX_LENGTH)
    : singleLine;
}

/** Context for one failed SNS audience dispatch attempt; excludes message content and recipients. */
export interface NotificationFailureContext {
  isbNamespace: string;
  notificationType: string;
  leaseId?: string;
  awsAccountId?: string;
}

/**
 * Builds the SNS message attributes for one publish: the four always-stamped
 * routing attributes plus the two conditional attributes (`awsAccountId`,
 * `leaseUuid`), included only when the message carries them.
 */
function buildMessageAttributes(
  message: NotificationPublishMessage,
): NonNullable<PublishCommand["input"]["MessageAttributes"]> {
  const attributes: NonNullable<PublishCommand["input"]["MessageAttributes"]> =
    {
      notificationType: {
        DataType: "String",
        StringValue: message.notificationType,
      },
      recipientPersona: {
        DataType: "String",
        StringValue: message.recipientPersona,
      },
      recipientEmails: {
        // SNS needs the array type to evaluate subscription filters on this message.
        DataType: "String.Array",
        StringValue: JSON.stringify(message.recipientEmails),
      },
      schemaVersion: {
        DataType: "String",
        StringValue: NOTIFICATION_SCHEMA_VERSION,
      },
    };
  if (message.awsAccountId !== undefined) {
    attributes.awsAccountId = {
      DataType: "String",
      StringValue: message.awsAccountId,
    };
  }
  if (message.leaseUuid !== undefined) {
    attributes.leaseUuid = {
      DataType: "String",
      StringValue: message.leaseUuid,
    };
  }
  return attributes;
}

/** The JSON body carried in the SNS `Message` field: the notification's own content, distinct from the routing message attributes. */
function buildMessageBody(message: NotificationPublishMessage): string {
  return JSON.stringify({
    subject: message.subject,
    body: message.textBody,
    htmlBody: message.htmlBody,
  });
}

/**
 * Publishes one notification message to the shared SNS integration topic.
 * Never throws to the caller -- a failed SNS publish must never block the
 * independent SES channel. Retries are the SNS client's own `maxAttempts`
 * configuration (see `IsbClients.sns`), not an application-level retry loop;
 * this function makes exactly one `send()` call. Once that budget is
 * exhausted, the `.catch` below logs one `NotificationFailed` line for this
 * audience dispatch attempt (never the message body or `recipientEmails`, which
 * carry recipient PII) instead of propagating.
 */
export async function publish(
  message: NotificationPublishMessage,
  failureContext: NotificationFailureContext,
  props: NotificationPublishingServiceProps,
): Promise<void> {
  const normalizedSubject = normalizeSnsSubject(message.subject);
  await Promise.resolve()
    .then(() =>
      props.snsClient.send(
        new PublishCommand({
          TopicArn: props.topicArn,
          // SNS Subject is optional; omit it when normalization yields an empty
          // value rather than sending an empty string.
          ...(normalizedSubject.length > 0
            ? { Subject: normalizedSubject }
            : {}),
          Message: buildMessageBody(message),
          MessageAttributes: buildMessageAttributes(message),
        }),
      ),
    )
    .catch((error) => {
      const log: NotificationFailureMetricLog = {
        notificationMetricType: NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
        isbNamespace: failureContext.isbNamespace,
        channel: "SNS",
        notificationType: failureContext.notificationType,
        ...(failureContext.leaseId === undefined
          ? {}
          : { leaseId: failureContext.leaseId }),
        ...(failureContext.awsAccountId === undefined
          ? {}
          : { awsAccountId: failureContext.awsAccountId }),
        errorNames: getNotificationErrorNames([error]),
      };
      props.logger.error(LogPatterns.NotificationFailed.pattern, log);
    });
}
