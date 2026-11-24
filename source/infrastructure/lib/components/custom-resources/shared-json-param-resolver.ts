// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";
import path from "node:path";

import { SharedJsonParamEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import { SharedJsonParamArns } from "@amzn/innovation-sandbox-shared-json-param-parser/src/shared-json-param-parser-handler.js";
import { Fn } from "aws-cdk-lib";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";

export type SharedJsonParamResolverProps = SharedJsonParamArns & {
  namespace: string;
  forceConfigurationUpdate: string;
};

export class SharedJsonParamResolver extends Construct {
  //Idc
  public readonly identityStoreId: string;
  public readonly ssoInstanceArn: string;
  public readonly adminGroupId: string;
  public readonly managerGroupId: string;
  public readonly userGroupId: string;
  public readonly adminPermissionSetArn: string;
  public readonly managerPermissionSetArn: string;
  public readonly userPermissionSetArn: string;
  public readonly idcSolutionVersion: string;
  public readonly idcSupportedSchemas: string;
  //AccountPool
  public readonly organizationId: string;
  public readonly sandboxOuId: string;
  public readonly availableOuId: string;
  public readonly activeOuId: string;
  public readonly frozenOuId: string;
  public readonly cleanupOuId: string;
  public readonly quarantineOuId: string;
  public readonly entryOuId: string;
  public readonly exitOuId: string;
  public readonly accountPoolSolutionVersion: string;
  public readonly accountPoolSupportedSchemas: string;
  public readonly isbManagedRegions: string; // JSON string, parsed at runtime
  //Data
  public readonly configApplicationId: string;
  public readonly configEnvironmentId: string;
  public readonly configTableName: string;
  public readonly nukeConfigConfigurationProfileId: string;
  public readonly validatorExclusionConfigConfigurationProfileId: string;
  public readonly accountTable: string;
  public readonly leaseTemplateTable: string;
  public readonly leaseTable: string;
  public readonly blueprintTable: string;
  public readonly principalTable: string;
  public readonly cleanupReportTable: string;
  public readonly sandboxSpacesUsageTable: string;
  public readonly leaseCostHistoryTable: string;
  public readonly tableKmsKeyId: string;
  public readonly dataSolutionVersion: string;
  public readonly dataSupportedSchemas: string;
  public readonly cognitoUserPoolId: string;
  public readonly cognitoUserPoolArn: string;
  public readonly cognitoAppClientId: string;
  public readonly cognitoMcpClientId: string;
  public readonly cognitoIdentityPoolId: string;
  public readonly cognitoDomain: string;
  public readonly awsAccessPortalUrl: string;
  public readonly identityPoolAdminRoleName: string;
  public readonly identityPoolManagerRoleName: string;
  public readonly identityPoolUserRoleName: string;

  constructor(
    scope: Construct,
    id: string,
    props: SharedJsonParamResolverProps,
  ) {
    super(scope, id);

    const { forceConfigurationUpdate, ...resourceProps } = props;

    const sharedJsonParamCR = new IsbLambdaFunctionCustomResource(
      this,
      "ParseJsonConfiguration",
      {
        description: "Parses configuration passed in JSON format",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "shared-json-param-parser",
          "src",
          "shared-json-param-parser-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        envSchema: SharedJsonParamEnvironmentSchema,
        environment: {},
        customResourceType: "Custom::ParseJsonConfiguration",
        customResourceProperties: {
          ...resourceProps,
          // Synth time re-reads on every new template; the parameter covers same-template updates.
          forceUpdate: Fn.join("-", [
            String(Date.now()),
            forceConfigurationUpdate,
          ]),
        },
      },
    );

    const ssmReadPolicy = new Policy(scope, "SharedParamReaderSsmReadPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            props.idcConfigParamArn,
            props.accountPoolConfigParamArn,
            props.dataConfigParamArn,
          ],
        }),
      ],
    });

    sharedJsonParamCR.lambdaFunction.role?.attachInlinePolicy(ssmReadPolicy);

    //Idc
    this.identityStoreId =
      sharedJsonParamCR.customResource.getAttString("identityStoreId");
    this.ssoInstanceArn =
      sharedJsonParamCR.customResource.getAttString("ssoInstanceArn");
    this.adminGroupId =
      sharedJsonParamCR.customResource.getAttString("adminGroupId");
    this.managerGroupId =
      sharedJsonParamCR.customResource.getAttString("managerGroupId");
    this.userGroupId =
      sharedJsonParamCR.customResource.getAttString("userGroupId");
    this.adminPermissionSetArn = sharedJsonParamCR.customResource.getAttString(
      "adminPermissionSetArn",
    );
    this.managerPermissionSetArn =
      sharedJsonParamCR.customResource.getAttString("managerPermissionSetArn");
    this.userPermissionSetArn = sharedJsonParamCR.customResource.getAttString(
      "userPermissionSetArn",
    );
    this.idcSolutionVersion =
      sharedJsonParamCR.customResource.getAttString("idcSolutionVersion");
    this.idcSupportedSchemas = sharedJsonParamCR.customResource.getAttString(
      "idcSupportedSchemas",
    );
    //AccountPool
    this.organizationId =
      sharedJsonParamCR.customResource.getAttString("organizationId");
    this.sandboxOuId =
      sharedJsonParamCR.customResource.getAttString("sandboxOuId");
    this.availableOuId =
      sharedJsonParamCR.customResource.getAttString("availableOuId");
    this.activeOuId =
      sharedJsonParamCR.customResource.getAttString("activeOuId");
    this.frozenOuId =
      sharedJsonParamCR.customResource.getAttString("frozenOuId");
    this.cleanupOuId =
      sharedJsonParamCR.customResource.getAttString("cleanupOuId");
    this.quarantineOuId =
      sharedJsonParamCR.customResource.getAttString("quarantineOuId");
    this.entryOuId = sharedJsonParamCR.customResource.getAttString("entryOuId");
    this.exitOuId = sharedJsonParamCR.customResource.getAttString("exitOuId");
    this.accountPoolSolutionVersion =
      sharedJsonParamCR.customResource.getAttString(
        "accountPoolSolutionVersion",
      );
    this.accountPoolSupportedSchemas =
      sharedJsonParamCR.customResource.getAttString(
        "accountPoolSupportedSchemas",
      );
    this.isbManagedRegions =
      sharedJsonParamCR.customResource.getAttString("isbManagedRegions");
    //Data
    this.configApplicationId = sharedJsonParamCR.customResource.getAttString(
      "configApplicationId",
    );
    this.configEnvironmentId = sharedJsonParamCR.customResource.getAttString(
      "configEnvironmentId",
    );
    this.configTableName =
      sharedJsonParamCR.customResource.getAttString("configTableName");
    this.nukeConfigConfigurationProfileId =
      sharedJsonParamCR.customResource.getAttString(
        "nukeConfigConfigurationProfileId",
      );
    this.validatorExclusionConfigConfigurationProfileId =
      sharedJsonParamCR.customResource.getAttString(
        "validatorExclusionConfigConfigurationProfileId",
      );
    this.accountTable =
      sharedJsonParamCR.customResource.getAttString("accountTable");
    this.leaseTemplateTable =
      sharedJsonParamCR.customResource.getAttString("leaseTemplateTable");
    this.leaseTable =
      sharedJsonParamCR.customResource.getAttString("leaseTable");
    this.blueprintTable =
      sharedJsonParamCR.customResource.getAttString("blueprintTable");
    this.principalTable =
      sharedJsonParamCR.customResource.getAttString("principalTable");
    this.cleanupReportTable =
      sharedJsonParamCR.customResource.getAttString("cleanupReportTable");
    this.sandboxSpacesUsageTable =
      sharedJsonParamCR.customResource.getAttString("sandboxSpacesUsageTable");
    this.leaseCostHistoryTable = sharedJsonParamCR.customResource.getAttString(
      "leaseCostHistoryTable",
    );
    this.tableKmsKeyId =
      sharedJsonParamCR.customResource.getAttString("tableKmsKeyId");
    this.dataSolutionVersion = sharedJsonParamCR.customResource.getAttString(
      "dataSolutionVersion",
    );
    this.dataSupportedSchemas = sharedJsonParamCR.customResource.getAttString(
      "dataSupportedSchemas",
    );
    this.cognitoUserPoolId =
      sharedJsonParamCR.customResource.getAttString("cognitoUserPoolId");
    this.cognitoUserPoolArn =
      sharedJsonParamCR.customResource.getAttString("cognitoUserPoolArn");
    this.cognitoAppClientId =
      sharedJsonParamCR.customResource.getAttString("cognitoAppClientId");
    this.cognitoMcpClientId =
      sharedJsonParamCR.customResource.getAttString("cognitoMcpClientId");
    this.cognitoIdentityPoolId = sharedJsonParamCR.customResource.getAttString(
      "cognitoIdentityPoolId",
    );
    this.cognitoDomain =
      sharedJsonParamCR.customResource.getAttString("cognitoDomain");
    this.awsAccessPortalUrl =
      sharedJsonParamCR.customResource.getAttString("awsAccessPortalUrl");
    this.identityPoolAdminRoleName =
      sharedJsonParamCR.customResource.getAttString(
        "identityPoolAdminRoleName",
      );
    this.identityPoolManagerRoleName =
      sharedJsonParamCR.customResource.getAttString(
        "identityPoolManagerRoleName",
      );
    this.identityPoolUserRoleName =
      sharedJsonParamCR.customResource.getAttString("identityPoolUserRoleName");
  }
}
