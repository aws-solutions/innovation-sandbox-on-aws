// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Token } from "aws-cdk-lib";
import {
  ApiDefinition,
  CfnAccount,
  CfnRestApi,
  EndpointType,
  LogGroupLogDestination,
  RestApiMode,
  SpecRestApi,
} from "aws-cdk-lib/aws-apigateway";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { AccountsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/accounts-api";
import { BlueprintsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/blueprints-api";
import { ConfigurationsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/configurations-api";
import { LeaseTemplatesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/lease-templates-api";
import { LeasesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/leases-api";
import { PermissionSetsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/permission-sets-api";
import {
  API_DOMAINS,
  ApiDomain,
  DomainLambdaArns,
  prepareApiGatewaySpec,
  REST_API_ENDPOINT_ACCESS_MODE,
  REST_API_SECURITY_POLICY,
} from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";
import { PrincipalsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/principals-api";
import { SandboxAgentApi } from "@amzn/innovation-sandbox-infrastructure/components/api/sandbox-agent-api";
import { Waf } from "@amzn/innovation-sandbox-infrastructure/components/api/waf";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

import openApiContract from "../../../../../docs/openapi/innovation-sandbox-api.json";

export interface RestApiProps {
  intermediateRole: Role;
  namespace: string;
  idcAccountId: string;
  orgMgtAccountId: string;
  isbEventBus: EventBus;
  allowListedCidr: string[];
  durableCleanupFunctionArn: string;
  /** Resolved SesIdentityArn CFN parameter; empty when no delegated identity is configured. */
  sesIdentityArn: string;
}

export class RestApi extends SpecRestApi {
  public readonly wafWebAclName: string;

  constructor(scope: Construct, id: string, props: RestApiProps) {
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    // Create domain Lambdas first so their ARN tokens can be embedded in the
    // OpenAPI definition required by super().
    const domainLambdaFunctions = createDomainLambdaFunctions(scope, props);
    const lambdaArns = getDomainLambdaArns(domainLambdaFunctions);

    super(scope, id, {
      restApiName: "IsbRestApi",
      description: "Innovation Sandbox on AWS Rest API",
      apiDefinition: ApiDefinition.fromInline(
        prepareApiGatewaySpec(openApiContract, lambdaArns),
      ),
      mode: RestApiMode.OVERWRITE,
      // REST_API_SECURITY_POLICY is an edge-optimized policy.
      endpointTypes: [EndpointType.EDGE],
      failOnWarnings: true,
      parameters: {
        basepath: "ignore",
      },
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
        // Explicit false deletes the cache cluster that earlier versions created;
        // omitting the property leaves it running on upgraded stages.
        cacheClusterEnabled: false,
      },
    });

    // Replace only the physical RestApi while preserving the construct path and
    // the logical IDs of its Stage and surrounding resources. SpecRestApi applies
    // its description to the deployment, so set the RestApi description explicitly.
    const restApiResource = this.node.defaultChild as CfnRestApi;
    restApiResource.description = "Innovation Sandbox on AWS Rest API";
    restApiResource.overrideLogicalId("IsbOpenApiRestApi");
    restApiResource.securityPolicy = REST_API_SECURITY_POLICY;
    restApiResource.endpointAccessMode = REST_API_ENDPOINT_ACCESS_MODE;

    addCfnGuardSuppression(this.deploymentStage, [
      "API_GW_CACHE_ENABLED_AND_ENCRYPTED",
    ]);

    // Configure WAF with logging and alarms
    const waf = new Waf(this, "Waf", {
      namespace: props.namespace,
      resourceArn: this.deploymentStage.stageArn,
      allowListedCidr: props.allowListedCidr,
      kmsKey,
    });
    this.wafWebAclName = waf.webAcl.webAclRef.webAclName;

    this.grantApiGatewayInvoke(domainLambdaFunctions);
  }

  private grantApiGatewayInvoke(lambdaFunctions: DomainLambdaFunctions): void {
    for (const domain of API_DOMAINS) {
      const lambdaFunction = lambdaFunctions[domain];
      lambdaFunction.addPermission("ApiGatewayInvokeRoot", {
        principal: new ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: this.arnForExecuteApi("*", `/${domain}`),
      });
      lambdaFunction.addPermission("ApiGatewayInvokeDescendants", {
        principal: new ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: this.arnForExecuteApi("*", `/${domain}/*`),
      });
    }
  }

  public get cloudWatchAccountResource(): CfnAccount | undefined {
    return this.cloudWatchAccount;
  }
}

type DomainLambdaFunctions = Readonly<Record<ApiDomain, IFunction>>;

function createDomainLambdaFunctions(
  scope: Construct,
  props: RestApiProps,
): DomainLambdaFunctions {
  return {
    leases: new LeasesApi(scope, props).lambdaFunction,
    leaseTemplates: new LeaseTemplatesApi(scope, props).lambdaFunction,
    accounts: new AccountsApi(scope, props).lambdaFunction,
    blueprints: new BlueprintsApi(scope, props).lambdaFunction,
    configurations: new ConfigurationsApi(scope, props).lambdaFunction,
    permissionSets: new PermissionSetsApi(scope, props).lambdaFunction,
    principals: new PrincipalsApi(scope, props).lambdaFunction,
    sandboxAgent: new SandboxAgentApi(scope, props).lambdaFunction,
  };
}

function getDomainLambdaArns(
  lambdaFunctions: DomainLambdaFunctions,
): DomainLambdaArns {
  return {
    accounts: lambdaFunctions.accounts.functionArn,
    blueprints: lambdaFunctions.blueprints.functionArn,
    configurations: lambdaFunctions.configurations.functionArn,
    leases: lambdaFunctions.leases.functionArn,
    leaseTemplates: lambdaFunctions.leaseTemplates.functionArn,
    permissionSets: lambdaFunctions.permissionSets.functionArn,
    principals: lambdaFunctions.principals.functionArn,
    sandboxAgent: lambdaFunctions.sandboxAgent.functionArn,
  };
}
