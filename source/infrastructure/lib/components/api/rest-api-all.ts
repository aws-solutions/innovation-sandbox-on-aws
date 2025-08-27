// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, aws_iam, Duration, Token } from "aws-cdk-lib";
import {
  RestApi as ApiGatewayRestApi,
  AuthorizationType,
  IdentitySource,
  LogGroupLogDestination,
  RequestAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import path from "path";

import { AuthorizerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/authorizer-lambda-environment.js";
import { SECRET_NAME_PREFIX } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { AccountsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/accounts-api";
import { AuthApi } from "@amzn/innovation-sandbox-infrastructure/components/api/auth-api";
import { ConfigurationsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/configurations-api";
import { LeaseTemplatesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/lease-templates-api";
import { LeasesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/leases-api";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { grantIsbAppConfigRead } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import {
  CfnIPSet,
  CfnWebACL,
  CfnWebACLAssociation,
} from "aws-cdk-lib/aws-wafv2";

export interface RestApiProps {
  intermediateRole: Role;
  namespace: string;
  idcAccountId: string;
  orgMgtAccountId: string;
  isbEventBus: EventBus;
  allowListedCidr: string[];
}

export class RestApi extends ApiGatewayRestApi {
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: RestApiProps) {
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const authorizerLambdaFunction = new IsbLambdaFunction(
      scope,
      "AuthorizerLambdaFunction",
      {
        description:
          "Lambda function used for Innovation Sandbox on AWS API Authorization",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "authorizer",
          "src",
          "authorizer-handler.ts",
        ),
        handler: "handler",
        logGroup: IsbComputeResources.globalLogGroup,
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: `${SECRET_NAME_PREFIX}/${props.namespace}/Auth/JwtSecret`,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
        },
        envSchema: AuthorizerLambdaEnvironmentSchema,
      },
    );

    grantIsbAppConfigRead(
      scope,
      authorizerLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(authorizerLambdaFunction);

    const authorizer = new RequestAuthorizer(scope, "Authorizer", {
      handler: authorizerLambdaFunction.lambdaFunction,
      identitySources: [
        IdentitySource.header("Authorization"),
        IdentitySource.context("path"),
        IdentitySource.context("httpMethod"),
      ],
      resultsCacheTtl: Duration.minutes(5),
    });

    super(scope, id, {
      description: "Innovation Sandbox on AWS Rest API",
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(
          IsbComputeResources.globalLogGroup,
        ),
        tracingEnabled: true,
        throttlingRateLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingRateLimit"),
        ),
        throttlingBurstLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingBurstLimit"),
        ),
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.CUSTOM,
        authorizer: authorizer,
      },
    });

    addCfnGuardSuppression(this.deploymentStage, [
      "API_GW_CACHE_ENABLED_AND_ENCRYPTED",
    ]);

    const ipSet = new CfnIPSet(this, "IPSet", {
      addresses: props.allowListedCidr.map((cidr) => cidr.trim()),
      ipAddressVersion: "IPV4",
      scope: "REGIONAL",
    });

    const webAcl = new CfnWebACL(this, "WebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "IsbWebAclMetric",
        sampledRequestsEnabled: true,
      },
      customResponseBodies: {
        TooManyRequests: {
          contentType: "APPLICATION_JSON",
          content: JSON.stringify({
            message: "Too many requests",
          }),
        },
      },
      rules: [
        {
          name: "IsbAllowListRule",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            notStatement: {
              statement: {
                ipSetReferenceStatement: {
                  arn: ipSet.attrArn,
                  ipSetForwardedIpConfig: {
                    headerName: "X-Forwarded-For",
                    fallbackBehavior: "NO_MATCH",
                    position: "FIRST",
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IsbRateLimitRuleMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "IsbRateLimitRule",
          priority: 1,
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: "TooManyRequests",
              },
            },
          },
          statement: {
            rateBasedStatement: {
              evaluationWindowSec: 60,
              limit: 200,
              aggregateKeyType: "FORWARDED_IP",
              forwardedIpConfig: {
                headerName: "X-Forwarded-For",
                fallbackBehavior: "MATCH",
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IsbRateLimitRuleMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
              excludedRules: [
                {
                  name: "SizeRestrictions_BODY",
                },
                {
                  name: "CrossSiteScripting_BODY",
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSetMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesAmazonIpReputationList",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesAmazonIpReputationListMetric",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAnonymousIpList",
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesAnonymousIpList",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesAnonymousIpListMetric",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    this.logGroup = IsbComputeResources.globalLogGroup;

    const authApi = new AuthApi(this, scope, props);
    new LeasesApi(this, scope, props);
    new LeaseTemplatesApi(this, scope, props);
    new AccountsApi(this, scope, props);
    new ConfigurationsApi(this, scope, props);

    const secretAccessPolicy = new aws_iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      effect: aws_iam.Effect.ALLOW,
      resources: [authApi.jwtTokenSecretArn],
    });
    authorizerLambdaFunction.lambdaFunction.addToRolePolicy(secretAccessPolicy);
    kmsKey.grantEncryptDecrypt(authorizerLambdaFunction.lambdaFunction);
  }
}
