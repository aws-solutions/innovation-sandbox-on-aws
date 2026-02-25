// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnOutput, SecretValue } from "aws-cdk-lib";
import {
  AuthorizationType,
  LambdaIntegration,
} from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import path from "path";

import { SsoLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sso-lambda-environment.js";
import { SECRET_NAME_PREFIX } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import {
  RestApi as ApiGatewayRestApi,
  RestApiResourceProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  IntermediateRole,
  getIdcRoleArn,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class AuthApi {
  constructor(
    restApi: ApiGatewayRestApi,
    scope: Construct,
    props: RestApiResourceProps,
  ) {
    const idpCertSecretName = `${SECRET_NAME_PREFIX}/${props.namespace}/Auth/IdpCert`;
    const idpCertSecret = new Secret(scope, "IdpCert", {
      secretName: idpCertSecretName,
      description:
        "IAM Identity Center Certificate of the ISB SAML 2.0 custom app",
      encryptionKey: IsbKmsKeys.get(scope, props.namespace),
      secretStringValue: SecretValue.unsafePlainText(
        "Please paste the IAM Identity Center Certificate of the" +
          " Innovation Sandbox SAML 2.0 custom application here",
      ),
    });

    new CfnOutput(scope, "IdpCertArn", {
      value: idpCertSecret.secretArn,
      description: "The ARN of the created secret to store the IDP certificate",
    });
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const ssoLambda = new IsbLambdaFunction(scope, "SsoHandler", {
      description: "Handles SSO operations",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "source",
        "lambdas",
        "api",
        "sso-handler",
        "src",
        "index.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        JWT_SECRET_NAME: props.jwtSecret.secretName,
        IDP_CERT_SECRET_NAME: idpCertSecret.secretName,
        POWERTOOLS_SERVICE_NAME: "SsoHandler",
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        ISB_NAMESPACE: props.namespace,
        APP_CONFIG_APPLICATION_ID: configApplicationId,
        APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
        APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
        AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
      },
      logGroup: restApi.logGroup,
      envSchema: SsoLambdaEnvironmentSchema,
    });

    grantIsbSsmParameterRead(
      ssoLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbAppConfigRead(scope, ssoLambda, globalConfigConfigurationProfileId);
    addAppConfigExtensionLayer(ssoLambda);

    idpCertSecret.grantRead(ssoLambda.lambdaFunction);
    props.jwtSecret.grantRead(ssoLambda.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      ssoLambda.lambdaFunction,
    );

    IntermediateRole.addTrustedRole(ssoLambda.lambdaFunction.role! as Role);

    const ssoResource = restApi.root
      .addResource("auth", {
        defaultMethodOptions: {
          authorizationType: AuthorizationType.NONE,
          authorizer: undefined,
        },
      })
      .addResource("{action+}", {
        defaultIntegration: new LambdaIntegration(ssoLambda.lambdaFunction, {
          proxy: true,
          allowTestInvoke: true,
        }),
      });
    const methodGet = ssoResource.addMethod("GET");
    const methodPost = ssoResource.addMethod("POST");
    const methodOptions = ssoResource.addMethod("OPTIONS");

    addCfnGuardSuppression(ssoResource, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodGet, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodPost, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
    addCfnGuardSuppression(methodOptions, [
      "API_GW_METHOD_AUTHORIZATION_TYPE_RULE",
    ]);
  }
}
