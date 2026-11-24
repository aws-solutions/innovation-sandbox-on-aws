// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnMapping, CfnOutput, Fn, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  addParameterGroup,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbDataResources } from "@amzn/innovation-sandbox-infrastructure/isb-data-resources";

export class IsbDataStack extends Stack {
  public static readonly cfnMapping: CfnMapping;
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const namespaceParam = new NamespaceParam(this);

    const samlMetadataUrlParam = new ParameterWithLabel(
      this,
      "SamlMetadataUrl",
      {
        label: "SAML Metadata URL",
        description: "The SAML metadata URL from the IDC SAML 2.0 application",
        allowedPattern: "^https://.*$",
        constraintDescription:
          "Must be a valid HTTPS URL (e.g., https://portal.sso.us-east-1.amazonaws.com/saml/metadata/...)",
      },
    );
    samlMetadataUrlParam.overrideLogicalId("SamlMetadataUrl");

    const awsAccessPortalUrlParam = new ParameterWithLabel(
      this,
      "AwsAccessPortalUrl",
      {
        label: "AWS Access Portal URL",
        description:
          "The AWS Access Portal URL for IAM Identity Center SSO (e.g. https://d-xxxxxxxxxx.awsapps.com/start). " +
          "If you change it on an existing deployment, update the Compute stack with a new ForceConfigurationUpdate value.",
        allowedPattern: "^https://.*$",
        constraintDescription:
          "Must be a valid HTTPS URL (e.g., https://d-xxxxxxxxxx.awsapps.com/start)",
      },
    );
    awsAccessPortalUrlParam.overrideLogicalId("AwsAccessPortalUrl");

    addParameterGroup(this, {
      label: "Data Stack Configuration",
      parameters: [
        namespaceParam,
        samlMetadataUrlParam,
        awsAccessPortalUrlParam,
      ],
    });

    const dataResources = new IsbDataResources(this, {
      namespace: namespaceParam.valueAsString,
      samlMetadataUrl: samlMetadataUrlParam.valueAsString,
      awsAccessPortalUrl: awsAccessPortalUrlParam.valueAsString,
    });

    applyIsbTag(this, `${namespaceParam.valueAsString}`);

    new CfnOutput(this, "ConfigApplicationIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-ConfigApplicationId`,
      key: `ConfigApplicationId`,
      value: dataResources.config.application.applicationId,
    });

    new CfnOutput(this, "ConfigEnvironmentIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-ConfigEnvironmentId`,
      key: `ConfigEnvironmentId`,
      value: dataResources.config.environment.environmentId,
    });

    new CfnOutput(this, "ConfigDeploymentStrategyIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-ConfigDeploymentStrategyId`,
      key: `ConfigDeploymentStrategyId`,
      value: dataResources.config.deploymentStrategy.deploymentStrategyId,
    });

    new CfnOutput(this, "NukeConfigConfigurationProfileIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-NukeConfigConfigurationProfileId`,
      key: `NukeConfigConfigurationProfileId`,
      value:
        dataResources.config.nukeConfigHostedConfiguration
          .configurationProfileId,
    });

    new CfnOutput(this, "ValidatorExclusionConfigConfigurationProfileIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-ValidatorExclusionConfigConfigurationProfileId`,
      key: `ValidatorExclusionConfigConfigurationProfileId`,
      value:
        dataResources.config.validatorExclusionConfigHostedConfiguration
          .configurationProfileId,
    });

    new CfnOutput(this, "SandboxAccountTableOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-SandboxAccountTable`,
      key: `SandboxAccountTable`,
      value: dataResources.sandboxAccountTable.tableName,
    });

    new CfnOutput(this, "LeaseTemplateTableOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-LeaseTemplateTable`,
      key: `LeaseTemplateTable`,
      value: dataResources.leaseTemplateTable.tableName,
    });

    new CfnOutput(this, "LeaseTableOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-LeaseTable`,
      key: `LeaseTable`,
      value: dataResources.leaseTable.tableName,
    });

    new CfnOutput(this, "PrincipalTableOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-PrincipalTable`,
      key: `PrincipalTable`,
      value: dataResources.principalTable.tableName,
    });

    new CfnOutput(this, "CleanupReportTableOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CleanupReportTable`,
      key: `CleanupReportTable`,
      value: dataResources.cleanupReportTable.tableName,
    });

    new CfnOutput(this, "CognitoUserPoolIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoUserPoolId`,
      key: `CognitoUserPoolId`,
      value: dataResources.userPool.userPoolId,
    });

    new CfnOutput(this, "CognitoAppClientIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoAppClientId`,
      key: `CognitoAppClientId`,
      value: dataResources.userPoolClient.userPoolClientId,
    });

    new CfnOutput(this, "CognitoMcpClientIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoMcpClientId`,
      key: `CognitoMcpClientId`,
      value: dataResources.mcpUserPoolClient.userPoolClientId,
    });

    new CfnOutput(this, "CognitoIdentityPoolIdOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoIdentityPoolId`,
      key: `CognitoIdentityPoolId`,
      value: dataResources.identityPool.ref,
    });

    new CfnOutput(this, "CognitoDomainOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoDomain`,
      key: `CognitoDomain`,
      value: dataResources.cognitoDomainPrefix,
    });

    new CfnOutput(this, "CognitoAcsUrlOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoAcsUrl`,
      key: `CognitoAcsUrl`,
      value: Fn.join("", [
        "https://",
        dataResources.cognitoDomainPrefix,
        ".auth.",
        this.region,
        ".amazoncognito.com/saml2/idpresponse",
      ]),
    });

    new CfnOutput(this, "CognitoAudienceOut", {
      exportName: `${this.stackName}-${namespaceParam.valueAsString}-CognitoAudience`,
      key: `CognitoAudience`,
      value: Fn.join("", [
        "urn:amazon:cognito:sp:",
        dataResources.userPool.userPoolId,
      ]),
    });
  }
}
