// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { SNSClient } from "@aws-sdk/client-sns";

import type { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/** Message-attribute contract version, stamped on every publish. Bumped by hand when the published message shape changes. */
export const NOTIFICATION_SCHEMA_VERSION = "1";

/**
 * Which audience a published message is for. Derived from the shared
 * `IsbRole` so this can never drift from the roles the rest of the system
 * recognizes. `admin` and `manager` are distinct audiences: most
 * manager-audience events resolve to the combined admins+managers union,
 * but four events (see `notification-message-synthesis.ts`) are
 * admin-only.
 */
export type RecipientPersona = Lowercase<IsbRole>;

/**
 * The wire message published to the shared SNS integration topic.
 * `awsAccountId` and `leaseUuid` are conditional -- present only when the
 * triggering event carries that context.
 */
export interface NotificationPublishMessage {
  subject: string;
  textBody: string;
  htmlBody?: string;
  notificationType: string;
  recipientPersona: RecipientPersona;
  recipientEmails: string[];
  awsAccountId?: string;
  leaseUuid?: string;
}

/** Dependencies `publish()` needs to send one message to the integration topic. */
export interface NotificationPublishingServiceProps {
  snsClient: SNSClient;
  topicArn: string;
  logger: Logger;
}
