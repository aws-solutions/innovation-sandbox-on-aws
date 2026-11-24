// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnCondition, Duration, Fn, Stack, Token } from "aws-cdk-lib";
import { CfnStackSet } from "aws-cdk-lib/aws-cloudformation";
import { PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "node:path";

import {
  OBSERVABILITY_SHARED_RESOURCE_TYPES,
  OBSERVABILITY_SINK_TAG,
  OBSERVABILITY_SINKS_RESOURCE_TYPE,
  SINK_ID_MAPPING_KEY,
  SINK_IDS_JSON_ATTRIBUTE,
} from "@amzn/innovation-sandbox-commons/data/observability-sink-config/observability-sink-config.js";
import { ObservabilitySinksEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/observability-sinks-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

/** Only Bedrock metrics cross the link; the resource type pin keeps out everything else. */
const BEDROCK_METRICS_LINK_FILTER = "Namespace IN ('AWS/Bedrock')";

const SINK_IDS_PLACEHOLDER = "__ISB_SINK_IDS__";

export interface ObservabilitySinksProps {
  readonly namespace: string;
  readonly orgMgtAccountId: string;
}

/**
 * Shares Bedrock metrics from every sandbox account with the hub through
 * CloudWatch cross-account observability: a custom resource joins, or creates,
 * the one sink per managed region that every namespace in this account shares,
 * and a service-managed StackSet links
 * every account under the pool OU to the sink of its region. A member-account
 * hub creates that StackSet as a delegated administrator, which the custom
 * resource registers through OrgMgtRole.
 */
export class ObservabilitySinks extends Construct {
  /** Region -> `{"Id": <sink id>}`, as the custom resource returns it. */
  readonly sinkIdsJson: string;

  constructor(scope: Construct, id: string, props: ObservabilitySinksProps) {
    super(scope, id);
    const { organizationId, sandboxOuId, isbManagedRegions } =
      IsbComputeStack.sharedSpokeConfig.accountPool;
    // typed as a string by the resolver, delivered as a list
    const regions = Token.asList(isbManagedRegions);
    const solutionVersion = getContextFromMapping(this, "version");
    const sinkTag = OBSERVABILITY_SINK_TAG;

    const sinks = new IsbLambdaFunctionCustomResource(
      this,
      "ObservabilitySinks",
      {
        description:
          "Custom resource lambda that creates the observability sink in every managed region",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "observability-sinks",
          "src",
          "observability-sinks-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
        },
        envSchema: ObservabilitySinksEnvironmentSchema,
        timeout: Duration.minutes(5),
        customResourceType: OBSERVABILITY_SINKS_RESOURCE_TYPE,
        customResourceProperties: {
          namespace: props.namespace,
          organizationId,
          sandboxOuId,
          managedRegions: regions,
          hubAccountId: Aws.ACCOUNT_ID,
          orgMgtAccountId: props.orgMgtAccountId,
          partition: Aws.PARTITION,
          sinkTag,
          solutionVersion,
        },
      },
    );
    this.sinkIdsJson = sinks.customResource.getAttString(
      SINK_IDS_JSON_ATTRIBUTE,
    );
    IntermediateRole.addTrustedRole(sinks.lambdaFunction.role! as Role);
    // The shared sink is solution-owned; unrelated regional sinks remain out of scope.
    const anySink = Stack.of(this).formatArn({
      service: "oam",
      region: "*",
      resource: "sink",
      resourceName: "*",
    });
    sinks.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["oam:CreateSink"],
        resources: ["*"], // no resource-level permissions for this action
        conditions: {
          StringEquals: { [`aws:RequestTag/${sinkTag.key}`]: sinkTag.value },
        },
      }),
    );
    // tagging on create is authorized as TagResource on the new sink
    sinks.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["oam:TagResource"],
        resources: [anySink],
        conditions: {
          StringEquals: { [`aws:RequestTag/${sinkTag.key}`]: sinkTag.value },
        },
      }),
    );
    sinks.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["oam:DeleteSink", "oam:GetSinkPolicy", "oam:PutSinkPolicy"],
        resources: [anySink],
        conditions: {
          StringEquals: { [`aws:ResourceTag/${sinkTag.key}`]: sinkTag.value },
        },
      }),
    );
    sinks.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["oam:ListSinks"],
        resources: ["*"], // no resource-level permissions for this action
      }),
    );

    const hubIsManagementAccount = new CfnCondition(
      this,
      "HubIsManagementAccount",
      {
        expression: Fn.conditionEquals(props.orgMgtAccountId, Aws.ACCOUNT_ID),
      },
    );

    // The sink map is baked into the template because parameter overrides do
    // not reach auto-deployed accounts. The placeholder becomes the custom
    // resource attribute, joined in by CloudFormation at deploy time. The
    // version in Metadata changes the template once per release, which is
    // what makes StackSets retry instances that failed earlier.
    const linkTemplateBody = JSON.stringify({
      Description:
        "Innovation Sandbox observability link to the hub sink in this region",
      Mappings: { SinkIds: SINK_IDS_PLACEHOLDER },
      Resources: {
        BedrockMetricsLink: {
          Type: "AWS::Oam::Link",
          Metadata: { SolutionVersion: solutionVersion },
          Properties: {
            SinkIdentifier: {
              "Fn::Sub": [
                `arn:\${AWS::Partition}:oam:\${AWS::Region}:${Aws.ACCOUNT_ID}:sink/\${SinkId}`,
                {
                  SinkId: {
                    "Fn::FindInMap": [
                      "SinkIds",
                      { Ref: "AWS::Region" },
                      SINK_ID_MAPPING_KEY,
                    ],
                  },
                },
              ],
            },
            LabelTemplate: "$AccountName",
            ResourceTypes: OBSERVABILITY_SHARED_RESOURCE_TYPES,
            LinkConfiguration: {
              MetricConfiguration: { Filter: BEDROCK_METRICS_LINK_FILTER },
            },
          },
        },
      },
    })
      .split(`"${SINK_IDS_PLACEHOLDER}"`)
      .join(this.sinkIdsJson);

    const linkStackSet = new CfnStackSet(this, "LinkStackSet", {
      stackSetName: `Isb-${props.namespace}-ObservabilityLinks`,
      permissionModel: "SERVICE_MANAGED",
      // The management account creates service-managed StackSets natively; a
      // member account only as a delegated administrator.
      callAs: Fn.conditionIf(
        hubIsManagementAccount.logicalId,
        "SELF",
        "DELEGATED_ADMIN",
      ).toString(),
      description:
        "StackSet linking every Innovation Sandbox account to the observability sink of its region",
      autoDeployment: {
        enabled: true,
        retainStacksOnAccountRemoval: false,
      },
      stackInstancesGroup: [
        {
          deploymentTargets: { organizationalUnitIds: [sandboxOuId] },
          regions,
        },
      ],
      // one account that cannot link must not block the fleet
      operationPreferences: {
        concurrencyMode: "SOFT_FAILURE_TOLERANCE",
        failureTolerancePercentage: 100,
        maxConcurrentPercentage: 100,
        regionConcurrencyType: "PARALLEL",
      },
      managedExecution: { Active: true },
      templateBody: linkTemplateBody,
    });
    // the GetAtt already orders them; stated so a later TemplateURL keeps it
    linkStackSet.node.addDependency(sinks.customResource);
  }
}
