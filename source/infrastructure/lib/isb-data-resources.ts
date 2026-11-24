// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Duration, Fn, RemovalPolicy, Token, aws_ssm } from "aws-cdk-lib";
import {
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  CfnUserPoolClient,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
  UserPoolIdentityProviderSaml,
  UserPoolIdentityProviderSamlMetadata,
} from "aws-cdk-lib/aws-cognito";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { FederatedPrincipal, Role } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import { DataConfig } from "@amzn/innovation-sandbox-commons/data/data-stack-config/data-stack-config.js";
import {
  identityPoolAdminRoleName,
  identityPoolManagerRoleName,
  identityPoolUserRoleName,
  sharedDataSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Config } from "@amzn/innovation-sandbox-infrastructure/components/config/config";
import { ConfigMigrator } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/config-migrator";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { UniqueStackIdPart } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  MCP_CLIENT_CALLBACK_URLS,
  isDevMode,
} from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

const supportedSchemas = ["1"];

export interface IsbDataResourcesProps {
  readonly namespace: string;
  readonly samlMetadataUrl: string;
  readonly awsAccessPortalUrl: string;
}
export class IsbDataResources {
  tableKmsKey: Key;
  config: Config;
  sandboxAccountTable: Table;
  leaseTemplateTable: Table;
  leaseTable: Table;
  blueprintTable: Table;
  principalTable: Table;
  cleanupReportTable: Table;
  configTable: Table;
  sandboxSpacesUsageTable: Table;
  leaseCostHistoryTable: Table;
  userPool: UserPool;
  userPoolClient: UserPoolClient;
  /** Public client for MCP/IDE sign-in, separate from the web console client. */
  mcpUserPoolClient: UserPoolClient;
  userPoolDomain: UserPoolDomain;
  cognitoDomainPrefix: string;
  identityPool: CfnIdentityPool;

  constructor(scope: Construct, props: IsbDataResourcesProps) {
    this.tableKmsKey = IsbKmsKeys.get(scope, props.namespace);

    this.config = new Config(scope, "Config", {
      namespace: props.namespace,
    });

    const devMode = isDevMode(scope);
    const tableRemovalPolicy = devMode
      ? RemovalPolicy.DESTROY
      : RemovalPolicy.RETAIN;
    this.sandboxAccountTable = new Table(scope, "SandboxAccountTable", {
      partitionKey: { name: "awsAccountId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      encryptionKey: this.tableKmsKey,
      encryption: TableEncryption.CUSTOMER_MANAGED,
    });

    this.leaseTemplateTable = new Table(scope, "LeaseTemplateTable", {
      partitionKey: { name: "uuid", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      encryptionKey: this.tableKmsKey,
      encryption: TableEncryption.CUSTOMER_MANAGED,
    });

    this.leaseTemplateTable.addGlobalSecondaryIndex({
      indexName: "blueprintId-index",
      partitionKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    this.leaseTable = new Table(scope, "LeaseTable", {
      partitionKey: { name: "userEmail", type: AttributeType.STRING },
      sortKey: { name: "uuid", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });
    this.leaseTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: {
        name: "status",
        type: AttributeType.STRING,
      },
      sortKey: {
        name: "originalLeaseTemplateUuid",
        type: AttributeType.STRING,
      },
    });

    this.blueprintTable = new Table(scope, "BlueprintTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING }, // "bp#{blueprintId}"
      sortKey: { name: "SK", type: AttributeType.STRING }, // "blueprint" | "stackset#{stackSetId}" | "deployment#{timestamp}#{operationId}"
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl", // For deployment history cleanup (90 days)
    });

    this.blueprintTable.addGlobalSecondaryIndex({
      indexName: "itemType-blueprintId-index",
      partitionKey: { name: "itemType", type: AttributeType.STRING }, // "BLUEPRINT"
      sortKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.principalTable = new Table(scope, "PrincipalTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING }, // "user#<userId>" | "group#<groupId>"
      sortKey: { name: "sk", type: AttributeType.STRING }, // "lease#<leaseId>" | "groupMembership"
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });

    this.principalTable.addGlobalSecondaryIndex({
      indexName: "LeaseIndex",
      partitionKey: { name: "leaseId", type: AttributeType.STRING },
      sortKey: { name: "pk", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.principalTable.addGlobalSecondaryIndex({
      indexName: "GroupIndex",
      partitionKey: { name: "groupId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    this.cleanupReportTable = new Table(scope, "CleanupReportTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });

    // Sandbox Spaces Usage table — Tracks per-user monthly token budget counters for Sandbox Spaces.
    this.sandboxSpacesUsageTable = new Table(scope, "SandboxSpacesUsageTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });

    // Lease cost history — per-lease time series of cost observations, breach
    // records and Bedrock token rows, keyed by { leaseUuid, sk: "<PREFIX>#<iso8601>" }.
    this.leaseCostHistoryTable = new Table(scope, "LeaseCostHistoryTable", {
      partitionKey: { name: "leaseUuid", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });

    // One item per configuration section, keyed by { section, sk: "current" }.
    // No explicit tableName — CloudFormation generates one so a retry after a
    // rolled-back deploy does not collide with a RETAINed table of the same name.
    this.configTable = new Table(scope, "ConfigTable", {
      partitionKey: { name: "section", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
    });

    // Cognito User Pool
    this.userPool = new UserPool(scope, "UserPool", {
      userPoolName: `${props.namespace}-isb-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
    });

    const samlProvider = new UserPoolIdentityProviderSaml(
      scope,
      "SamlIdentityProvider",
      {
        userPool: this.userPool,
        name: "IAMIdentityCenter",
        metadata: UserPoolIdentityProviderSamlMetadata.url(
          props.samlMetadataUrl,
        ),
      },
    );

    this.userPoolClient = this.userPool.addClient("AppClient", {
      userPoolClientName: `${props.namespace}-isb-web`,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        // Placeholders — updated by a custom resource in the Compute stack with the resolved target/CloudFront URL
        callbackUrls: ["https://localhost/callback"],
        logoutUrls: ["https://localhost/logout"],
      },
      supportedIdentityProviders: [
        {
          name: samlProvider.providerName,
        },
      ],
    });

    // Token validity via L1 escape hatch — CDK's L2 rejects token-based Duration values,
    // but we want these in the CFN mapping so operators can edit the template directly.
    const applyTokenValidity = (client: UserPoolClient) => {
      const cfnClient = client.node.defaultChild as CfnUserPoolClient;
      cfnClient.accessTokenValidity = Token.asNumber(
        getContextFromMapping(scope, "cognitoAccessTokenValidityMinutes"),
      );
      cfnClient.idTokenValidity = Token.asNumber(
        getContextFromMapping(scope, "cognitoIdTokenValidityMinutes"),
      );
      cfnClient.refreshTokenValidity = Token.asNumber(
        getContextFromMapping(scope, "cognitoRefreshTokenValidityDays"),
      );
      cfnClient.tokenValidityUnits = {
        accessToken: "minutes",
        idToken: "minutes",
        refreshToken: "days",
      };
    };
    applyTokenValidity(this.userPoolClient);

    // Separate public client for MCP/IDE sign-in
    this.mcpUserPoolClient = this.userPool.addClient("McpClient", {
      userPoolClientName: `${props.namespace}-isb-mcp`,
      generateSecret: false,
      enableTokenRevocation: true,
      refreshTokenRotationGracePeriod: Duration.seconds(60),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: MCP_CLIENT_CALLBACK_URLS,
      },
      supportedIdentityProviders: [
        {
          name: samlProvider.providerName,
        },
      ],
    });
    applyTokenValidity(this.mcpUserPoolClient);
    // No native or custom sign-in flows (SRP, password, custom, choice-based): this
    // client is used only through the hosted UI's authorization-code + PKCE flow.
    const cfnMcpClient = this.mcpUserPoolClient.node
      .defaultChild as CfnUserPoolClient;
    cfnMcpClient.explicitAuthFlows = [];

    // Cognito Domain — uses region + stack ID suffix (not namespace) because Cognito
    // domain prefixes must be lowercase and the Namespace parameter allows uppercase.
    const stackIdSuffix = Fn.select(0, Fn.split("-", UniqueStackIdPart));
    this.cognitoDomainPrefix = Fn.join("-", ["isb", Aws.REGION, stackIdSuffix]);

    this.userPoolDomain = this.userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix: this.cognitoDomainPrefix,
      },
    });

    // Cognito Identity Pool — bridges Cognito tokens to temporary IAM credentials for SigV4 signing
    this.identityPool = new CfnIdentityPool(scope, "IsbIdentityPool", {
      identityPoolName: `${props.namespace}-isb-identity-pool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
        {
          clientId: this.mcpUserPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    const identityPoolTrustPrincipal = new FederatedPrincipal(
      "cognito-identity.amazonaws.com",
      {
        StringEquals: {
          "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
        },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "authenticated",
        },
      },
      "sts:AssumeRoleWithWebIdentity",
    );

    // execute-api:Invoke is attached in the Compute stack, scoped to the API Gateway ARN.
    // Explicit role names are required so the Compute stack can resolve them via
    // Role.fromRoleName without a cross-stack export — suppress the cfn-guard rule.
    const adminRole = new Role(scope, "IsbIdentityPoolAdminRole", {
      roleName: identityPoolAdminRoleName(props.namespace),
      assumedBy: identityPoolTrustPrincipal,
    });
    addCfnGuardSuppression(adminRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

    const managerRole = new Role(scope, "IsbIdentityPoolManagerRole", {
      roleName: identityPoolManagerRoleName(props.namespace),
      assumedBy: identityPoolTrustPrincipal,
    });
    addCfnGuardSuppression(managerRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

    const userRole = new Role(scope, "IsbIdentityPoolUserRole", {
      roleName: identityPoolUserRoleName(props.namespace),
      assumedBy: identityPoolTrustPrincipal,
    });
    addCfnGuardSuppression(userRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

    // The custom:isb_roles claim is a JSON-encoded array string (e.g. `["Admin","User"]`).
    // Match against the quoted token (`"Admin"`) rather than the bare name so a future role
    // whose name shares a substring with another (e.g. SuperManager) can't silently match
    // the lower-tier rule.
    const isbRoleRules = {
      rules: [
        {
          claim: "custom:isb_roles",
          matchType: "Contains",
          value: '"Admin"',
          roleArn: adminRole.roleArn,
        },
        {
          claim: "custom:isb_roles",
          matchType: "Contains",
          value: '"Manager"',
          roleArn: managerRole.roleArn,
        },
        {
          claim: "custom:isb_roles",
          matchType: "Contains",
          value: '"User"',
          roleArn: userRole.roleArn,
        },
      ],
    };

    new CfnIdentityPoolRoleAttachment(scope, "IsbIdentityPoolRoleAttachment", {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: userRole.roleArn,
      },
      roleMappings: {
        cognitoProvider: {
          type: "Rules",
          ambiguousRoleResolution: "Deny",
          identityProvider: `${this.userPool.userPoolProviderName}:${this.userPoolClient.userPoolClientId}`,
          rulesConfiguration: isbRoleRules,
        },
        mcpCognitoProvider: {
          type: "Rules",
          ambiguousRoleResolution: "Deny",
          identityProvider: `${this.userPool.userPoolProviderName}:${this.mcpUserPoolClient.userPoolClientId}`,
          rulesConfiguration: isbRoleRules,
        },
      },
    });

    // One-time AppConfig-to-DynamoDB Upgrade Migrator. Runs during the
    // create/update phase; CloudFormation deletes the removed AppConfig profiles
    // only afterward, so no explicit DependsOn is needed.
    new ConfigMigrator(scope, "ConfigMigrator", {
      namespace: props.namespace,
      appConfigApplicationId: this.config.application.applicationId,
      appConfigApplicationArn: this.config.application.applicationArn,
      appConfigEnvironmentId: this.config.environment.environmentId,
      configTableName: this.configTable.tableName,
      configTableArn: this.configTable.tableArn,
      tableKmsKeyId: this.tableKmsKey.keyId,
    });

    new aws_ssm.StringParameter(scope, "DataConfiguration", {
      parameterName: sharedDataSsmParamName(props.namespace),
      description: "The configuration of the data stack of Innovation Sandbox",
      stringValue: JSON.stringify({
        configApplicationId: this.config.application.applicationId,
        configEnvironmentId: this.config.environment.environmentId,
        configTableName: this.configTable.tableName,
        nukeConfigConfigurationProfileId:
          this.config.nukeConfigHostedConfiguration.configurationProfileId,
        validatorExclusionConfigConfigurationProfileId:
          this.config.validatorExclusionConfigHostedConfiguration
            .configurationProfileId,
        accountTable: this.sandboxAccountTable.tableName,
        leaseTemplateTable: this.leaseTemplateTable.tableName,
        leaseTable: this.leaseTable.tableName,
        blueprintTable: this.blueprintTable.tableName,
        principalTable: this.principalTable.tableName,
        cleanupReportTable: this.cleanupReportTable.tableName,
        sandboxSpacesUsageTable: this.sandboxSpacesUsageTable.tableName,
        leaseCostHistoryTable: this.leaseCostHistoryTable.tableName,
        tableKmsKeyId: this.tableKmsKey.keyId,
        solutionVersion: getContextFromMapping(scope, "version"),
        supportedSchemas: JSON.stringify(supportedSchemas),
        cognitoUserPoolId: this.userPool.userPoolId,
        cognitoUserPoolArn: this.userPool.userPoolArn,
        cognitoAppClientId: this.userPoolClient.userPoolClientId,
        cognitoMcpClientId: this.mcpUserPoolClient.userPoolClientId,
        cognitoIdentityPoolId: this.identityPool.ref,
        cognitoDomain: this.cognitoDomainPrefix,
        awsAccessPortalUrl: props.awsAccessPortalUrl,
        identityPoolAdminRoleName: adminRole.roleName,
        identityPoolManagerRoleName: managerRole.roleName,
        identityPoolUserRoleName: userRole.roleName,
      } satisfies DataConfig),
      simpleName: true,
    });
  }
}
