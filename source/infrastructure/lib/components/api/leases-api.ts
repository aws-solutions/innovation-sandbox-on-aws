// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class LeasesApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId,
      leaseTemplateTable,
      leaseTable,
      accountTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const { sandboxOuId } = IsbComputeStack.sharedSpokeConfig.accountPool;

    const leasesLambdaFunction = new IsbLambdaFunction(
      scope,
      "LeasesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for leases resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "leases",
          "src",
          "leases-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId},`,
          ISB_NAMESPACE: props.namespace,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          SANDBOX_OU_ID: sandboxOuId,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            props.namespace,
            props.idcAccountId,
          ),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
        },
        logGroup: restApi.logGroup,
        envSchema: LeaseLambdaEnvironmentSchema,
      },
    );

    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbDbReadWrite(
      scope,
      leasesLambdaFunction,
      leaseTable,
      leaseTemplateTable,
      accountTable,
    );
    grantIsbAppConfigRead(
      scope,
      leasesLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    grantIsbAppConfigRead(
      scope,
      leasesLambdaFunction,
      reportingConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(leasesLambdaFunction);

    props.isbEventBus.grantPutEventsTo(leasesLambdaFunction.lambdaFunction);

    IntermediateRole.addTrustedRole(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    const leasesResource = restApi.root.addResource("leases", {
      defaultIntegration: new LambdaIntegration(
        leasesLambdaFunction.lambdaFunction,
        {
          allowTestInvoke: true,
          proxy: true,
        },
      ),
    });
    leasesResource.addMethod("GET");
    leasesResource.addMethod("POST");

    const leaseIdResource = leasesResource.addResource("{leaseId}");
    leaseIdResource.addMethod("GET");
    leaseIdResource.addMethod("PATCH");

    const leaseReviewResource = leaseIdResource.addResource("review");
    leaseReviewResource.addMethod("POST");

    const leaseFreezeResource = leaseIdResource.addResource("freeze");
    leaseFreezeResource.addMethod("POST");

    const leaseUnfreezeResource = leaseIdResource.addResource("unfreeze");
    leaseUnfreezeResource.addMethod("POST");

    const leaseTerminateResource = leaseIdResource.addResource("terminate");
    leaseTerminateResource.addMethod("POST");
  }
}
