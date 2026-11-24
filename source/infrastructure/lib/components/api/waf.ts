// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ArnFormat,
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
} from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { IKey } from "aws-cdk-lib/aws-kms";
import { CfnResourcePolicy, LogGroup } from "aws-cdk-lib/aws-logs";
import {
  CfnIPSet,
  CfnLoggingConfiguration,
  CfnWebACL,
  CfnWebACLAssociation,
} from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import {
  WAF_HUMAN_CALLS_METRIC_NAME,
  WAF_M2M_CALLS_METRIC_NAME,
} from "@amzn/innovation-sandbox-commons/observability/waf-auth-metrics";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";

export interface WafProps {
  namespace: string;
  resourceArn: string;
  allowListedCidr: string[];
  kmsKey: IKey;
}

export class Waf extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly wafLogGroup: LogGroup;
  public readonly blockedRequestsAlarm: Alarm;

  constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    const ipSet = new CfnIPSet(this, "IPSet", {
      addresses: props.allowListedCidr.map((cidr) => cidr.trim()),
      ipAddressVersion: "IPV4",
      scope: "REGIONAL",
    });

    this.webAcl = new CfnWebACL(this, "WebAcl", {
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
                    // Requests traverse the solution CloudFront distribution and API Gateway's
                    // edge-optimized CloudFront. LAST therefore selects an AWS CloudFront
                    // origin-facing IP, not the original client IP or any customer-configured
                    // proxy's egress IP.
                    // Note: FIRST is client-supplied and therefore spoofable; treat this
                    // allow-list as defense-in-depth behind JWT auth + RBAC.
                    position: "FIRST",
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IsbAllowListRuleMetric",
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
                  // Valid JSON bodies can exceed 8 KB; terms of service allows 10,000 characters.
                  name: "SizeRestrictions_BODY",
                },
                {
                  // Opaque continuation tokens have no 2 KB contract limit.
                  name: "SizeRestrictions_QUERYSTRING",
                },
                {
                  // Legitimate free text can resemble XSS, causing false-positive blocks.
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
        // Caller-mix telemetry. Count is non-terminating and sits after the
        // block rules, so CountedRequests tallies only WAF-allowed traffic.
        // Human carries x-isb-identity; m2m is the exact complement.
        {
          name: "IsbHumanApiCallsRule",
          priority: 5,
          action: { count: {} },
          statement: {
            sizeConstraintStatement: {
              fieldToMatch: { singleHeader: { Name: IDENTITY_HEADER } },
              comparisonOperator: "GE",
              size: 1,
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: WAF_HUMAN_CALLS_METRIC_NAME,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "IsbM2mApiCallsRule",
          priority: 6,
          action: { count: {} },
          statement: {
            notStatement: {
              statement: {
                sizeConstraintStatement: {
                  fieldToMatch: { singleHeader: { Name: IDENTITY_HEADER } },
                  comparisonOperator: "GE",
                  size: 1,
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: WAF_M2M_CALLS_METRIC_NAME,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: props.resourceArn,
      webAclArn: this.webAcl.attrArn,
    });

    this.wafLogGroup = new LogGroup(this, "WafLogGroup", {
      logGroupName: `aws-waf-logs-isb-${props.namespace}-blocked-requests`,
      encryptionKey: props.kmsKey,
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      retention: Token.asNumber(
        getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
      ),
    });
    addCfnGuardSuppression(this.wafLogGroup, [
      "CW_LOGGROUP_RETENTION_PERIOD_CHECK",
    ]); // Retention period is defined in CfnMapping and evades the CFN Guard check

    this.wafLogGroup.grantWrite(new ServicePrincipal("wafv2.amazonaws.com"));

    // Namespace grantWrite's auto-named (construct-id-derived) Logs resource policy so
    // multiple ISB instances in one account/region don't collide on the policy name.
    const wafLogGroupPolicy = this.wafLogGroup.node.findChild("Policy").node
      .defaultChild as CfnResourcePolicy;
    wafLogGroupPolicy.policyName = `${props.namespace}-IsbWafLogGroupPolicy`;

    new CfnLoggingConfiguration(this, "WafLoggingConfiguration", {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          service: "logs",
          resource: "log-group",
          resourceName: this.wafLogGroup.logGroupName,
        }),
      ],
      loggingFilter: {
        DefaultBehavior: "DROP",
        Filters: [
          {
            Behavior: "KEEP",
            Conditions: [
              {
                ActionCondition: {
                  Action: "BLOCK",
                },
              },
            ],
            Requirement: "MEETS_ANY",
          },
        ],
      },
      redactedFields: [
        {
          singleHeader: {
            Name: "Authorization",
          },
        },
        {
          singleHeader: {
            Name: "x-amz-security-token",
          },
        },
        {
          singleHeader: {
            Name: IDENTITY_HEADER,
          },
        },
      ],
    });

    const blockedRequestsMetric = new Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        Rule: "ALL",
        WebACL: this.webAcl.webAclRef.webAclName,
        Region: Aws.REGION,
      },
      statistic: "Sum",
      period: Duration.minutes(1),
    });

    this.blockedRequestsAlarm = new Alarm(this, "WafBlockedRequestsAlarm", {
      alarmDescription:
        "Alert when WAF blocks requests to the Innovation Sandbox API - may indicate misconfigured WAF rules blocking legitimate users",
      metric: blockedRequestsMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
