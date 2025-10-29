// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { EventBridgeEvent } from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
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
  // Early exit if email notifications are not configured
  const {
    notification: { emailFrom },
    auth: { webAppUrl },
  } = context.globalConfig;
  if (!emailFrom || emailFrom.trim() === "") {
    logger.warn("Email notifications are disabled - emailFrom not configured");
    return;
  }

  const emailService = IsbServices.emailService(context.env, {
    fromAddress: emailFrom,
    webAppUrl,
    logger,
  });

  const eventDetailType = event["detail-type"];
  if (!isSubscribedEmailEvent(eventDetailType)) {
    throw new Error(`Unsupported event detail type: ${eventDetailType}`);
  }

  await emailService.sendNotificationEmail(
    eventDetailType as EmailEventName,
    event.detail,
  );
}
