// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SubscribedEmailEvents } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events";
import { EmailNotificationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import { EventsToLambda } from "@amzn/innovation-sandbox-infrastructure/components/events-to-lambda";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Duration, Stack } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

export interface EmailNotificationLambdaProps {
  isbEventBus: EventBus;
  namespace: string;
  idcAccountId: string;
  webAppUrl: string;
}

export class EmailNotificationLambda extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: EmailNotificationLambdaProps,
  ) {
    super(scope, id);

    const { configTableName } = IsbComputeStack.sharedSpokeConfig.data;

    const lambda = new IsbLambdaFunction(this, id, {
      description: "consumes email notification messages and sends emails",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "notification",
        "email-notification",
        "src",
        "email-notification-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        CONFIG_TABLE_NAME: configTableName,
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        ISB_NAMESPACE: props.namespace,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        WEB_APP_URL: props.webAppUrl,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: EmailNotificationEnvironmentSchema,
      timeout: Duration.minutes(3),
    });

    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);
    grantIsbSsmParameterRead(
      lambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbDbReadOnly(scope, lambda, configTableName);

    const emailSendPolicy = new Policy(scope, "EmailNotificationSendPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [
            Stack.of(scope).formatArn({
              service: "ses",
              resource: "identity",
              resourceName: "*",
            }),
            Stack.of(scope).formatArn({
              service: "ses",
              resource: "configuration-set",
              resourceName: "*",
            }),
          ],
        }),
      ],
    });
    lambda.lambdaFunction.role?.attachInlinePolicy(emailSendPolicy);
    IsbKmsKeys.get(scope, props.namespace).grantDecrypt(lambda.lambdaFunction);

    new EventsToLambda(scope, "EmailEventsToLambda", {
      eventBus: props.isbEventBus,
      lambdaFunction: lambda.lambdaFunction,
      lambdaFunctionProps: {
        maxEventAge: Duration.hours(4),
        retryAttempts: 3,
      },
      ruleProps: {
        eventBus: props.isbEventBus,
        description: "Triggers email notification lambda",
        enabled: true,
        eventPattern: {
          detailType: SubscribedEmailEvents,
        },
      },
    });
  }
}
