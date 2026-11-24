// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { EventBridgeEvent } from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  publish,
  SynthesizedAudienceMessage,
  synthesizeNotificationMessages,
  toPublishMessage,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/index.js";
import {
  EmailEventName,
  isSubscribedEmailEvent,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import {
  EmailNotificationEnvironment,
  EmailNotificationEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  getNotificationErrorNames,
  NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
  NotificationFailureMetricLog,
} from "@amzn/innovation-sandbox-commons/observability/notification-metrics.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { isSesNotificationEnabled } from "@amzn/innovation-sandbox-shared/types/configuration.js";

const serviceName = "EmailNotificationHandler";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: EmailNotificationEnvironmentSchema,
  moduleName: "email-notification",
})
  .use(isbConfigMiddleware())
  .handler(eventHandler);

async function eventHandler(
  event: EventBridgeEvent<string, unknown>,
  context: IsbLambdaContext<EmailNotificationEnvironment> & ContextWithConfig,
) {
  const {
    notification: { emailFrom, snsIntegrationTopicEnabled },
  } = context.globalConfig;
  const webAppUrl = context.env.WEB_APP_URL;
  const eventDetailType = event["detail-type"];

  const sesActive = isSesNotificationEnabled(context.globalConfig.notification);
  const snsActive = snsIntegrationTopicEnabled;

  if (!sesActive && !snsActive) {
    // Exits before validating detail-type, so an unrecognized event with no
    // active channel exits quietly rather than throwing.
    logger.warn(LogPatterns.NotificationNoChannelEnabled.pattern, {
      notificationType: eventDetailType,
    });
    return;
  }

  if (!isSubscribedEmailEvent(eventDetailType)) {
    throw new Error(`Unsupported event detail type: ${eventDetailType}`);
  }
  const emailEventName = eventDetailType;

  // Shared by every active channel to resolve recipients. listIsbAdmins/
  // listIsbManagers cache module-globally (idc-cache.ts) for 5 minutes.
  const idcService = IsbServices.idcService(
    context.env,
    fromTemporaryIsbIdcCredentials(context.env),
  );

  // Not wrapped in try/catch: a resolution/synthesis failure here is a
  // shared prerequisite for every active channel, so it must propagate for
  // EventBridge retry rather than being caught or relabeled as one
  // channel's failure. Only failures after this call succeeds (SES's send,
  // SNS's publish) are adapter-isolated below.
  const sharedMessages = await synthesizeNotificationMessages(
    emailEventName,
    event.detail,
    { webAppUrl, idcService },
  );

  if (sesActive && snsActive) {
    const emailService = IsbServices.emailService(context.env, {
      fromAddress: emailFrom,
      logger,
      sesIdentityArn: context.env.SES_IDENTITY_ARN,
    });
    // EmailService logs its own failures before rejecting, so only the SNS
    // result needs inspection here. publish() logs expected SNS send failures;
    // this catches unexpected failures outside that boundary.
    const [, snsResult] = await Promise.allSettled([
      emailService.sendNotificationEmail(emailEventName, sharedMessages),
      publishToSns(emailEventName, sharedMessages, context.env),
    ]);
    if (snsResult.status === "rejected") {
      logUnexpectedSnsRejection(
        snsResult.reason,
        emailEventName,
        context.env.ISB_NAMESPACE,
      );
    }
  } else if (sesActive) {
    const emailService = IsbServices.emailService(context.env, {
      fromAddress: emailFrom,
      logger,
      sesIdentityArn: context.env.SES_IDENTITY_ARN,
    });
    await emailService.sendNotificationEmail(emailEventName, sharedMessages);
  } else {
    await publishToSns(emailEventName, sharedMessages, context.env);
  }
}

function logUnexpectedSnsRejection(
  error: unknown,
  notificationType: EmailEventName,
  isbNamespace: string,
): void {
  const log: NotificationFailureMetricLog = {
    notificationMetricType: NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
    isbNamespace,
    channel: "SNS",
    notificationType,
    errorNames: getNotificationErrorNames([error]),
  };
  logger.error(LogPatterns.NotificationFailed.pattern, log);
}

/** Publishes every non-empty audience to the SNS integration topic. */
async function publishToSns(
  emailEventName: EmailEventName,
  messages: SynthesizedAudienceMessage[],
  env: EmailNotificationEnvironment,
): Promise<void> {
  const snsClient = IsbClients.sns(env);
  const topicArn = env.SNS_INTEGRATION_TOPIC_ARN;
  await Promise.all(
    messages
      .filter((message) => message.recipientEmails.length > 0)
      .map((message) =>
        publish(
          toPublishMessage(emailEventName, message),
          {
            isbNamespace: env.ISB_NAMESPACE,
            notificationType: emailEventName,
            leaseId: message.leaseUuid,
            awsAccountId: message.awsAccountId,
          },
          { snsClient, topicArn, logger },
        ),
      ),
  );
}
