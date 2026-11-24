// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Aws, Stack } from "aws-cdk-lib";
import { IRestApi } from "aws-cdk-lib/aws-apigateway";
import {
  CfnGateway,
  CfnGatewayTarget,
  CfnPolicy,
  CfnPolicyEngine,
} from "aws-cdk-lib/aws-bedrockagentcore";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { IKey } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  type HttpMethod,
  resolveAllowedRoles,
} from "@amzn/innovation-sandbox-commons/lambda/authorization-map.js";
import {
  identityPoolAdminRoleName,
  identityPoolManagerRoleName,
  identityPoolUserRoleName,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { isExcludedApiPath } from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import type { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const REST_API_TARGET_NAME = "isb-rest-api";
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Derives each tier's MCP tool names from the OpenAPI operations and REST
 * authorization map, keeping runtime discovery, Cedar, and API RBAC aligned.
 */
export function mcpToolNamesByRole(
  paths: Record<string, unknown>,
): Record<IsbRole, string[]> {
  const byRole: Record<IsbRole, string[]> = {
    Admin: [],
    Manager: [],
    User: [],
  };
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(
      pathItem as Record<string, { operationId?: string }>,
    )) {
      // Path items can also contain metadata such as `parameters` and `summary`.
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      const { toolName, roles } = mcpToolAccess(rawPath, method, operation);
      for (const role of roles) byRole[role].push(toolName);
    }
  }
  for (const role of Object.keys(byRole) as IsbRole[]) byRole[role].sort(); // NOSONAR typescript:S2871: Keep generated Cedar tool lists in deterministic UTF-16 order.
  return byRole;
}

function mcpToolAccess(
  rawPath: string,
  method: string,
  operation: { operationId?: string } | null | undefined,
) {
  // Both gaps indicate a contract or authorization bug, so fail synthesis.
  const operationId = operation?.operationId;
  if (!operationId) {
    throw new Error(
      `OpenAPI operation ${method.toUpperCase()} ${rawPath} has no operationId; ` +
        `it cannot be exposed as an MCP tool or authorized by Cedar.`,
    );
  }
  const roles = resolveAllowedRoles(
    rawPath,
    method.toUpperCase() as HttpMethod,
  );
  if (roles.length === 0) {
    throw new Error(
      `Operation ${operationId} (${method.toUpperCase()} ${rawPath}) resolves to no roles ` +
        `in authorizationMap; it would be exposed as a tool no tier can invoke. ` +
        `Add it to the authorization map (or exclude it from the gateway target).`,
    );
  }

  const toolName = `${REST_API_TARGET_NAME}___${operationId}`;
  return { toolName, roles };
}

/** Converts the shared role/tool mapping into Cedar action identifiers. */
export function cedarActionsByRole(
  paths: Record<string, unknown>,
): Record<IsbRole, string[]> {
  const toolNamesByRole = mcpToolNamesByRole(paths);
  return Object.fromEntries(
    (Object.keys(toolNamesByRole) as IsbRole[]).map((role) => [
      role,
      toolNamesByRole[role].map(
        (toolName) => `AgentCore::Action::"${toolName}"`,
      ),
    ]),
  ) as Record<IsbRole, string[]>;
}

const MCP_OPENAPI_SCHEMA = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "docs",
  "openapi",
  "innovation-sandbox-api.json",
);

/** Validates and sanitizes the OpenAPI contract used by the gateway target. */
export const McpOpenApiContractSchema = z
  .looseObject({
    openapi: z.string().min(1),
    paths: z
      .record(z.string(), z.unknown())
      .refine((paths) => Object.keys(paths).length > 0, {
        error:
          "OpenAPI contract defines no paths, so the gateway would expose no tools",
      }),
    security: z.unknown().optional(),
    components: z
      .looseObject({ securitySchemes: z.unknown().optional() })
      .optional(),
  })
  .transform(({ security: _security, components, paths, ...rest }) => {
    const runtimePaths = Object.fromEntries(
      Object.entries(paths).filter(
        ([pathName]) => !isExcludedApiPath(pathName),
      ),
    );
    if (components) {
      const { securitySchemes: _schemes, ...componentsWithoutSchemes } =
        components;
      return {
        ...rest,
        paths: runtimePaths,
        components: componentsWithoutSchemes,
      };
    }
    return { ...rest, paths: runtimePaths };
  });

export interface McpGatewayProps {
  namespace: string;
  kmsKey: IKey;
}

/**
 * AgentCore Gateway exposing ISB REST API operations as MCP tools for IDE
 * clients (Kiro, Claude Code).
 */
export class McpGateway extends Construct {
  public readonly gatewayUrl: string;
  public readonly gatewayArn: string;
  public readonly gatewayIdentifier: string;
  public readonly executionRole: Role;

  private readonly namespace: string;
  private readonly kmsKey: IKey;
  private readonly gateway: CfnGateway;
  private readonly openApiContract: Record<string, unknown>;

  constructor(scope: Construct, id: string, props: McpGatewayProps) {
    super(scope, id);

    const { namespace, kmsKey } = props;
    this.namespace = namespace;
    this.kmsKey = kmsKey;

    const parsed = McpOpenApiContractSchema.safeParse(
      JSON.parse(readFileSync(MCP_OPENAPI_SCHEMA, "utf8")),
    );
    if (!parsed.success) {
      throw new Error(
        `MCP gateway OpenAPI contract at ${MCP_OPENAPI_SCHEMA} is not a valid contract: ${z.prettifyError(parsed.error)}`,
      );
    }
    this.openApiContract = parsed.data;

    this.executionRole = new Role(this, "GatewayExecutionRole", {
      assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": Stack.of(this).formatArn({
              service: "bedrock-agentcore",
              resource: "gateway",
              resourceName: "*",
            }),
          },
        },
      }),
      description:
        "AgentCore Gateway execution role: invokes ISB REST API operations exposed as MCP tools.",
    });

    const kmsGrant = kmsKey.grantEncryptDecrypt(this.executionRole);

    const gateway = new CfnGateway(this, "Gateway", {
      name: `ISB-${namespace}-SandboxAgentGateway`,
      description: "ISB Sandbox Spaces MCP gateway.",
      roleArn: this.executionRole.roleArn,
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
      kmsKeyArn: kmsKey.keyArn,
      exceptionLevel: isDevMode(this) ? "DEBUG" : undefined,
    });

    kmsGrant.applyBefore(gateway);

    this.gateway = gateway;
    this.gatewayUrl = gateway.attrGatewayUrl;
    this.gatewayArn = gateway.attrGatewayArn;
    this.gatewayIdentifier = gateway.attrGatewayIdentifier;
  }

  /**
   * Returns the stable `AgentCore::IamEntity` identifier exposed by an AWS_IAM
   * gateway: the STS assumed-role ARN without a session suffix.
   *
   * See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-conditions.html
   */
  private assumedRoleArn(roleName: string): string {
    return Stack.of(this).formatArn({
      service: "sts",
      region: "",
      resource: "assumed-role",
      resourceName: roleName,
    });
  }

  /**
   * Exposes the OpenAPI operations as MCP tools.
   */
  public addRestApiTarget(restApi: IRestApi, stage: string): CfnGatewayTarget {
    const openApi: Record<string, unknown> = {
      ...this.openApiContract,
      servers: [
        {
          url: `https://${restApi.restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}/${stage}`,
        },
      ],
    };

    const target = new CfnGatewayTarget(this, "IsbRestApiTarget", {
      gatewayIdentifier: this.gatewayIdentifier,
      name: REST_API_TARGET_NAME,
      description: "ISB REST API operations exposed as MCP tools.",
      targetConfiguration: {
        mcp: { openApiSchema: { inlinePayload: JSON.stringify(openApi) } },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
          credentialProvider: {
            iamCredentialProvider: { service: "execute-api" },
          },
        },
      ],
      metadataConfiguration: {
        // This permits forwarding; callers must still supply the token.
        allowedRequestHeaders: [IDENTITY_HEADER],
      },
    });

    // The target and SpecRestApi use the same contract, so this stage contains
    // only routes exposed by the gateway. Cedar and API RBAC authorize each tool.
    this.executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["execute-api:Invoke"],
        resources: [
          Stack.of(this).formatArn({
            service: "execute-api",
            resource: restApi.restApiId,
            resourceName: `${stage}/*/*`,
          }),
        ],
      }),
    );

    this.addCedarAuthorization(
      target,
      openApi.paths as Record<string, unknown>,
    );

    return target;
  }

  /**
   * Adds default-deny Cedar authorization: each Identity Pool role (tier)
   * gets a permit policy for its tier's actions. ENFORCE mode also filters
   * tools/list to the caller's authorized actions.
   */
  private addCedarAuthorization(
    target: CfnGatewayTarget,
    paths: Record<string, unknown>,
  ): void {
    const engine = new CfnPolicyEngine(this, "PolicyEngine", {
      name: `ISB_${this.namespace}_SandboxAgentPolicyEngine`,
      description: "Per-tier Cedar authorization for ISB Sandbox Spaces tools.",
      encryptionKeyArn: this.kmsKey.keyArn,
    });

    // ENFORCE also filters tools/list to the actions authorized for the caller.
    this.gateway.policyEngineConfiguration = {
      arn: engine.attrPolicyEngineArn,
      mode: "ENFORCE",
    };

    // Custom gateway roles need explicit permission to read and evaluate the
    // policy engine. Authorization actions apply to both engine and gateway.
    // See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-permissions.html
    this.executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock-agentcore:GetPolicyEngine"],
        resources: [engine.attrPolicyEngineArn],
      }),
    );
    // A concrete gateway ARN would create a dependency cycle because the gateway
    // already references this role. Scope the wildcard to this account and region.
    const anyGatewayInAccount = Stack.of(this).formatArn({
      service: "bedrock-agentcore",
      resource: "gateway",
      resourceName: "*",
    });
    this.executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "bedrock-agentcore:AuthorizeAction",
          "bedrock-agentcore:PartiallyAuthorizeActions",
        ],
        resources: [engine.attrPolicyEngineArn, anyGatewayInAccount],
      }),
    );

    const gatewayResource = `AgentCore::Gateway::"${this.gatewayArn}"`;
    const actionsByRole = cedarActionsByRole(paths);

    // Create one permit policy per STS assumed-role principal.
    const policySpecs = [
      {
        id: "CedarUserPolicy",
        principalArn: this.assumedRoleArn(
          identityPoolUserRoleName(this.namespace),
        ),
        actions: actionsByRole.User,
      },
      {
        id: "CedarManagerPolicy",
        principalArn: this.assumedRoleArn(
          identityPoolManagerRoleName(this.namespace),
        ),
        actions: actionsByRole.Manager,
      },
      {
        id: "CedarAdminPolicy",
        principalArn: this.assumedRoleArn(
          identityPoolAdminRoleName(this.namespace),
        ),
        actions: actionsByRole.Admin,
      },
    ];

    // AgentCore requires policies for one engine to stabilize sequentially.
    let previousPolicy: CfnPolicy | undefined;
    for (const { id, principalArn, actions } of policySpecs) {
      // Skip principals with no actions rather than generating an empty policy.
      if (actions.length === 0) continue;
      const policy = new CfnPolicy(this, id, {
        name: `ISB_${this.namespace}_${id}`,
        policyEngineId: engine.attrPolicyEngineId,
        definition: {
          cedar: {
            statement: `permit(\n  principal == AgentCore::IamEntity::"${principalArn}",\n  action in [\n    ${actions.join(
              ",\n    ",
            )}\n  ],\n  resource == ${gatewayResource}\n);`,
          },
        },
      });
      if (previousPolicy) policy.node.addDependency(previousPolicy);
      previousPolicy = policy;

      // Cedar validates action names against tools generated by the target.
      policy.node.addDependency(target);
    }
  }
}
