// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiGatewayV2WebSocketToSqs } from "@aws-solutions-constructs/aws-apigatewayv2websocket-sqs";
import { Aws, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnGuardrail, CfnResourcePolicy } from "aws-cdk-lib/aws-bedrock";
import { CfnMemory, CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";

import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import path from "node:path";

import { type AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import { AGENT_MEMORY_NAMESPACES } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { AgentWorkerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/agent-worker-lambda-environment.js";
import { AgentConnectLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/connect-lambda-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { guardrailVersionForDeployment } from "@amzn/innovation-sandbox-infrastructure/components/sandbox-agent/agent-guardrail-version";
import {
  agentRuntimeSourceHash,
  privateImageReference,
} from "@amzn/innovation-sandbox-infrastructure/components/sandbox-agent/agent-runtime-image";
import { McpGateway } from "@amzn/innovation-sandbox-infrastructure/components/sandbox-agent/mcp-gateway";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import {
  IntermediateRole,
  getIdcRoleArn,
  getSandboxAccountRoleName,
  getSandboxAgentRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { getCustomUserAgent } from "@amzn/innovation-sandbox-infrastructure/helpers/manifest-reader";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadOnlyToRole,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

const WORKER_TIMEOUT = Duration.minutes(15);

export interface SandboxAgentProps {
  namespace: string;
  cognitoUserPoolId: string;
  cognitoAppClientId: string;
  idcAccountId: string;
  idcConfigParamArn: string;
  principalTable: string;
}

/**
 * Sandbox Spaces infrastructure: WebSocket API→SQS, Connections table,
 * AgentCore Memory (user + admin), CfnRuntime, Memory Access Role, Bedrock
 * Guardrail, and warm-up cron.
 */
export class SandboxAgent extends Construct {
  public readonly webSocketCallbackUrl: string;
  public readonly webSocketUrl: string;
  public readonly webSocketExecuteApiArn: string;
  public readonly agentQueue: Queue;
  public readonly connectionsTable: Table;
  public readonly userMemoryId: string;
  public readonly userMemoryArn: string;
  public readonly agentRuntime: CfnRuntime;
  public readonly memoryAccessRole: Role;
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  /** MCP endpoint IDE clients connect to. */
  public readonly gatewayUrl: string;
  public readonly gatewayIdentifier: string;
  /**
   * Exposed so the REST API target can be attached after `RestApi` is created —
   * the agent's own `/sandboxAgent/*` routes live on that API, so it cannot exist
   * before this construct.
   */
  public readonly mcpGateway: McpGateway;
  public readonly webSocketStage: WebSocketStage;

  constructor(scope: Construct, id: string, props: SandboxAgentProps) {
    super(scope, id);

    const {
      namespace,
      cognitoUserPoolId,
      cognitoAppClientId,
      idcAccountId,
      idcConfigParamArn,
      principalTable,
    } = props;
    const { sandboxSpacesUsageTable, leaseTable, configTableName } =
      IsbComputeStack.sharedSpokeConfig.data;
    const kmsKey = IsbKmsKeys.get(scope, namespace);
    const devMode = isDevMode(scope);
    const tableRemovalPolicy = devMode
      ? RemovalPolicy.DESTROY
      : RemovalPolicy.RETAIN;

    // WebSocket API → SQS FIFO. CMK-encrypted, 960s visibility timeout,
    // sendMessage custom route, DLQ maxReceiveCount 3.
    // Create table and Lambda first so they can be passed into webSocketApiProps.

    // Stores connectionId → { actorId, role, email, protocolVersion } with 2h TTL.
    this.connectionsTable = new Table(this, "ConnectionsTable", {
      partitionKey: { name: "connectionId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: kmsKey,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });
    addCfnGuardSuppression(this.connectionsTable, [
      "DYNAMODB_TABLE_ENCRYPTED_KMS",
    ]);

    // Connect Lambda — handles $connect and $disconnect.
    const connectLambda = new IsbLambdaFunction(this, "ConnectLambda", {
      description:
        "WebSocket connect/disconnect handler: JWT validation and connection context store",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "sandbox-agent",
        "agent-connect",
        "src",
        "connect-handler.ts",
      ),
      handler: "handler",
      namespace,
      envSchema: AgentConnectLambdaEnvironmentSchema,
      environment: {
        CONNECTIONS_TABLE_NAME: this.connectionsTable.tableName,
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        COGNITO_APP_CLIENT_ID: cognitoAppClientId,
        ISB_NAMESPACE: namespace,
      },
      logGroup: IsbComputeResources.globalLogGroup,
    });

    this.connectionsTable.grantReadWriteData(connectLambda.lambdaFunction);

    const webSocketToSqs = new ApiGatewayV2WebSocketToSqs(
      this,
      "AgentWebSocketToSqs",
      {
        encryptionKey: kmsKey,
        queueProps: {
          queueName: `ISB-${namespace}-SandboxAgentQueue.fifo`,
          enforceSSL: true,
          visibilityTimeout: WORKER_TIMEOUT.plus(Duration.seconds(60)),
        },
        deployDeadLetterQueue: true,
        deadLetterQueueProps: {
          queueName: `ISB-${namespace}-SandboxAgentDLQ.fifo`,
          encryptionMasterKey: kmsKey,
          enforceSSL: true,
        },
        maxReceiveCount: 3,
        customRouteName: "sendMessage",
        defaultIamAuthorization: false,
        logGroupProps: { removalPolicy: tableRemovalPolicy },
        // Override the default VTL template to use the connection id as MessageGroupId.
        // It is set by API Gateway, so a caller cannot target another user's group.
        defaultRouteRequestTemplate: {
          sendMessage: [
            "Action=SendMessage",
            "&MessageGroupId=$util.urlEncode($context.connectionId)",
            "&MessageDeduplicationId=$context.requestId",
            "&MessageAttribute.1.Name=connectionId",
            "&MessageAttribute.1.Value.StringValue=$context.connectionId",
            "&MessageAttribute.1.Value.DataType=String",
            "&MessageAttribute.2.Name=requestId",
            "&MessageAttribute.2.Value.StringValue=$context.requestId",
            "&MessageAttribute.2.Value.DataType=String",
            String.raw`&MessageBody=$util.urlEncode($input.json($util.escapeJavaScript('$').replaceAll("\\'","'")))`,
          ].join(""),
        },
        webSocketApiProps: {
          description: `Innovation Sandbox on AWS Agent WebSocket API`,
          connectRouteOptions: {
            integration: new WebSocketLambdaIntegration(
              "ConnectIntegration",
              connectLambda.lambdaFunction,
            ),
            authorizer: new WebSocketIamAuthorizer(),
          },
          disconnectRouteOptions: {
            integration: new WebSocketLambdaIntegration(
              "DisconnectIntegration",
              connectLambda.lambdaFunction,
            ),
          },
        },
      },
    );

    this.agentQueue = webSocketToSqs.sqsQueue;
    this.webSocketStage = webSocketToSqs.webSocketStage;
    this.webSocketCallbackUrl = webSocketToSqs.webSocketStage.callbackUrl;
    this.webSocketUrl = webSocketToSqs.webSocketStage.url;
    // ARN pattern for execute-api:Invoke on all routes of this WebSocket API
    this.webSocketExecuteApiArn = `arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${webSocketToSqs.webSocketApi.apiId}/${webSocketToSqs.webSocketStage.stageName}/*`;

    addCfnGuardSuppression(webSocketToSqs.sqsQueue, [
      "SQS_QUEUE_ENCRYPTED_KMS",
    ]);
    if (webSocketToSqs.deadLetterQueue) {
      addCfnGuardSuppression(webSocketToSqs.deadLetterQueue.queue, [
        "SQS_QUEUE_ENCRYPTED_KMS",
      ]);
    }

    // Assumed with a per-lease session policy by the history API (one actor's
    // STM, read-only) and lease-termination cleanup (every actor's LTM on the
    // lease). Each caller adds its own role to the trust policy.
    this.memoryAccessRole = new Role(this, "MemoryAccessRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Assumed with a per-lease session policy for scoped AgentCore User Memory access.",
    });

    const guardrail = new CfnGuardrail(this, "AgentGuardrail", {
      name: `ISB-${namespace}-SandboxAgentGuardrail`,
      description:
        "Prompt-attack, harmful-content, and secret filters for Sandbox Agent",
      blockedInputMessaging:
        "Your request was blocked by the content safety guardrail. Please rephrase and try again.",
      blockedOutputsMessaging:
        "The agent response was blocked by the content safety guardrail.",
      // AWS-managed default key: the guardrail is applied cross-account from
      // sandbox accounts, which cannot be granted use of a hub customer CMK.
      contentPolicyConfig: {
        filtersConfig: [
          {
            type: "PROMPT_ATTACK",
            inputStrength: "HIGH",
            outputStrength: "NONE",
          },
          { type: "HATE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          {
            type: "INSULTS",
            inputStrength: "MEDIUM",
            outputStrength: "MEDIUM",
          },
          { type: "SEXUAL", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "VIOLENCE", inputStrength: "LOW", outputStrength: "LOW" },
          {
            type: "MISCONDUCT",
            inputStrength: "LOW",
            outputStrength: "MEDIUM",
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          {
            type: "EMAIL",
            action: "ANONYMIZE",
            inputEnabled: false,
            outputEnabled: true,
            outputAction: "ANONYMIZE",
          },
          // Masked on input too, so a pasted secret or a CLI result such as
          // `iam create-access-key` never reaches the model. ANONYMIZE rather
          // than BLOCK: input is the whole conversation, so blocking would
          // fail every later turn once a secret is in the history.
          ...["PASSWORD", "AWS_ACCESS_KEY", "AWS_SECRET_KEY"].map((type) => ({
            type,
            action: "ANONYMIZE",
            inputEnabled: true,
            inputAction: "ANONYMIZE",
            outputEnabled: true,
            outputAction: "ANONYMIZE",
          })),
        ],
      },
    });

    this.guardrailId = guardrail.attrGuardrailId;
    // A change to the guardrail above publishes a new version on deploy.
    this.guardrailVersion = guardrailVersionForDeployment(
      this,
      "AgentGuardrailVersion",
      guardrail,
    );

    // Lets sandbox-account principals apply this hub-owned guardrail
    // cross-account; the PrincipalOrgID condition confines the grant to this org.
    const { organizationId } = IsbComputeStack.sharedSpokeConfig.accountPool;
    new CfnResourcePolicy(this, "AgentGuardrailResourcePolicy", {
      resourceArn: guardrail.attrGuardrailArn,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowSandboxOrgGuardrailUse",
            Effect: "Allow",
            Principal: "*",
            Action: ["bedrock:GetGuardrail", "bedrock:ApplyGuardrail"],
            Resource: guardrail.attrGuardrailArn,
            Condition: {
              StringEquals: { "aws:PrincipalOrgID": organizationId },
            },
          },
        ],
      },
    });

    const mcpGateway = new McpGateway(this, "McpGateway", {
      namespace,
      kmsKey,
    });
    this.mcpGateway = mcpGateway;
    this.gatewayUrl = mcpGateway.gatewayUrl;
    this.gatewayIdentifier = mcpGateway.gatewayIdentifier;

    // 30-day STM: sized to the realistic user return-gap (~5 days).
    // The 30-day expiry is how STM is deleted; lease termination deletes only LTM.
    const userMemory = new CfnMemory(this, "UserMemory", {
      name: `ISB_${namespace}_UserMemory`,
      description:
        "User memory: lease-scoped STM (30-day) + LTM semantic extraction",
      encryptionKeyArn: kmsKey.keyArn,
      eventExpiryDuration: 30,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: "UserSemanticStrategy",
            description: "Per-lease user conversation extraction",
            namespaceTemplates: [AGENT_MEMORY_NAMESPACES.USER_LEASE],
          },
        },
      ],
    });

    this.userMemoryId = userMemory.attrMemoryId;
    this.userMemoryArn = Stack.of(this).formatArn({
      service: "bedrock-agentcore",
      resource: "memory",
      resourceName: userMemory.attrMemoryId,
    });

    this.memoryAccessRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:ListMemoryRecords",
          "bedrock-agentcore:BatchDeleteMemoryRecords",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock-agentcore",
            resource: "memory",
            resourceName: userMemory.attrMemoryId,
          }),
        ],
      }),
    );

    addCfnGuardSuppression(
      this.memoryAccessRole.node.findChild("DefaultPolicy"),
      ["IAM_NO_INLINE_POLICY_CHECK"],
    );

    // AgentCore Memory is encrypted with the ISB KMS key.
    // The Memory Access Role needs encrypt/decrypt to read events and memory records.
    kmsKey.grantEncryptDecrypt(this.memoryAccessRole);
    kmsKey.grant(this.memoryAccessRole, "kms:DescribeKey");

    // Grants STS AssumeRole (to reach the sandbox role for inference) and
    // AgentCore Memory I/O.
    const runtimeExecutionRole = new Role(this, "RuntimeExecutionRole", {
      assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description:
        "CfnRuntime execution role: STS AssumeRole to IntermediateRole (to assume the sandbox role for inference) and AgentCore Memory I/O (STM + LTM)",
    });

    IntermediateRole.addTrustedRole(runtimeExecutionRole);

    // Allow the runtime container to assume IntermediateRole
    runtimeExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
        resources: [IntermediateRole.getRoleArn()],
      }),
    );

    kmsKey.grantDecrypt(runtimeExecutionRole);

    const { accountTable } = IsbComputeStack.sharedSpokeConfig.data;
    grantIsbDbReadOnlyToRole(
      this,
      runtimeExecutionRole,
      leaseTable,
      accountTable,
    );

    addCfnGuardSuppression(
      runtimeExecutionRole.node.findChild("DefaultPolicy"),
      ["IAM_NO_INLINE_POLICY_CHECK"],
    );

    const imageTag = getContextFromMapping(this, "publicEcrTag");

    const sandboxAgentRuntimeEcrRepo = scope.node.tryGetContext(
      "privateSandboxAgentRuntimeEcrRepo",
    );
    // Set by scripts/cdk/deploy.sh from the image under the current source's tag.
    const sandboxAgentRuntimeImageDigest: string | undefined =
      scope.node.tryGetContext("sandboxAgentRuntimeImageDigest");
    const containerUri = sandboxAgentRuntimeEcrRepo
      ? `${Aws.ACCOUNT_ID}.dkr.ecr.${Aws.REGION}.${Aws.URL_SUFFIX}/${sandboxAgentRuntimeEcrRepo}${privateImageReference(sandboxAgentRuntimeImageDigest)}`
      : `${getContextFromMapping(this, "publicEcrRegistry")}/${getContextFromMapping(this, "solutionName")}-sandbox-agent-runtime:${imageTag}`;

    if (sandboxAgentRuntimeEcrRepo) {
      runtimeExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
          ],
          resources: [
            Stack.of(this).formatArn({
              service: "ecr",
              resource: "repository",
              resourceName: sandboxAgentRuntimeEcrRepo,
            }),
          ],
        }),
      );
      runtimeExecutionRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          // GetAuthorizationToken does not support resource-level permissions.
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"],
        }),
      );
    }
    // Minimal AgentCore Memory KMS permission set for the runtime container:
    // Encrypt, Decrypt, GenerateDataKey*, DescribeKey.
    runtimeExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        resources: [kmsKey.keyArn],
      }),
    );

    // Allow the runtime container to persist and retrieve conversation history
    // via AgentCore Memory (STM). Used by AgentCoreMemoryStore in the runtime.
    // Scoped to the User memory resource only.
    runtimeExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:GetEvent",
          "bedrock-agentcore:RetrieveMemoryRecords",
          "bedrock-agentcore:ListMemoryRecords",
        ],
        resources: [this.userMemoryArn],
      }),
    );

    runtimeExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/ISB_${namespace}_SandboxAgentRuntime*`,
        ],
      }),
    );

    runtimeExecutionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // X-Ray trace and sampling actions do not support resource-level permissions.
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      }),
    );

    this.agentRuntime = new CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName: `ISB_${namespace}_SandboxAgentRuntime`,
      description: "ISB Sandbox Spaces agent runtime.",
      roleArn: runtimeExecutionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri },
      },
      networkConfiguration: { networkMode: "PUBLIC" },
      // Pin the platform version so every install runs the same version.
      platformVersion: "V2",
      environmentVariables: {
        ...({
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          SANDBOX_AGENT_ROLE_NAME: getSandboxAgentRoleName(namespace),
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          USER_AGENT_EXTRA: getCustomUserAgent(),
          AWS_REGION: Aws.REGION,
          LEASE_TABLE_NAME: leaseTable,
          ACCOUNT_TABLE_NAME: accountTable,
          // Cross-account apply from the sandbox account needs the hub-qualified ARN.
          GUARDRAIL_ID: guardrail.attrGuardrailArn,
          GUARDRAIL_VERSION: this.guardrailVersion,
        } satisfies AgentRuntimeEnvironment),
        // Consumed by the container image and ADOT rather than application code,
        // so they are not part of the schema above.
        SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
        MEMORY_ID: userMemory.attrMemoryId,
        USER_MEMORY_ID: userMemory.attrMemoryId,
        PORT: "8080",
        NODE_ENV: "production",
        UNIFIED_TRACES_DESTINATION_ENABLED: "false",
        AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT: "true",
        AGENT_RUNTIME_SOURCE_HASH: agentRuntimeSourceHash(),
      },
    });

    this.agentRuntime.node.addDependency(runtimeExecutionRole);

    const runtimeApplicationLogGroup = LogGroup.fromLogGroupName(
      this,
      "RuntimeApplicationLogGroup",
      `/aws/bedrock-agentcore/runtimes/${this.agentRuntime.attrAgentRuntimeId}-DEFAULT`,
    );

    // Runtime's `flushMemory` emits a JSON log with `message =
    // "MemoryWriteFailure"` when a turn cannot be persisted to STM
    // (`MemoryManager.flush()` threw after retries). The alarm below fires
    // on this metric.
    const memoryWriteFailureFilter = new MetricFilter(
      this,
      "MemoryWriteFailureMetricFilter",
      {
        logGroup: runtimeApplicationLogGroup,
        filterPattern: FilterPattern.stringValue(
          "$.message",
          "=",
          "MemoryWriteFailure",
        ),
        metricNamespace: "ISB/SandboxAgent",
        metricName: "MemoryWriteFailure",
        defaultValue: 0,
      },
    );
    memoryWriteFailureFilter.node.addDependency(this.agentRuntime);

    new Alarm(this, "MemoryWriteFailureAlarm", {
      alarmDescription:
        "Sandbox Agent runtime failed to persist a turn to AgentCore Memory (MemoryManager.flush error) — conversation history for that turn is lost.",
      metric: memoryWriteFailureFilter.metric({
        statistic: "sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // A period with no failures produces no data points, not zero — do
      // not fire on absence.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // DLQ depth alarm — fires once a message has used all 3 receives (worker
    // crash or throttling). The Worker acknowledges handled failures,
    // so only these reach the DLQ.
    if (webSocketToSqs.deadLetterQueue) {
      new Alarm(this, "SandboxAgentDLQAlarm", {
        alarmDescription:
          "Sandbox Agent Worker DLQ has messages — unprocessable SQS records detected.",
        metric:
          webSocketToSqs.deadLetterQueue.queue.metricApproximateNumberOfMessagesVisible(
            { period: Duration.minutes(5) },
          ),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // Missing data is normal — the DLQ is empty most of the time.
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }

    // The Worker settles a character-based estimate and keeps serving turns
    // when the runtime reports no usage. Repeats mean the usage contract
    // between runtime and Worker is broken, so alarm on a burst instead.
    const turnMeteringFailedFilter = new MetricFilter(
      this,
      "AgentTurnMeteringFailedMetricFilter",
      {
        logGroup: IsbComputeResources.globalLogGroup,
        filterPattern: FilterPattern.stringValue(
          "$.logDetailType",
          "=",
          "AgentTurnMeteringFailed",
        ),
        metricNamespace: `ISB/SandboxAgent/${namespace}`,
        metricName: "AgentTurnMeteringFailed",
        metricValue: "1",
      },
    );
    new Alarm(this, "AgentTurnMeteringFailedAlarm", {
      alarmDescription:
        "Sandbox Agent Worker settled 3 or more turns in a single 15-minute period without reported token usage " +
        "(charged a character-based estimate instead). Investigate the Agent Worker Lambda logs " +
        "(logDetailType=AgentTurnMeteringFailed) in the ISB global log group and the " +
        "runtime's complete-event usage payload.",
      metric: turnMeteringFailedFilter.metric({
        statistic: "sum",
        period: Duration.minutes(15),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // No failures emit no data points; do not fire on absence.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // The Worker acknowledges a turn whose usage write failed every retry, so no
    // Lambda error or DLQ message exposes it. Alarm on any such drop.
    const usageRecordingFailedFilter = new MetricFilter(
      this,
      "SandboxSpacesUsageRecordingFailedMetricFilter",
      {
        logGroup: IsbComputeResources.globalLogGroup,
        filterPattern: FilterPattern.stringValue(
          "$.logDetailType",
          "=",
          "SandboxSpacesUsageRecordingFailed",
        ),
        metricNamespace: `ISB/SandboxAgent/${namespace}`,
        metricName: "SandboxSpacesUsageRecordingFailed",
        metricValue: "1",
      },
    );
    new Alarm(this, "SandboxSpacesUsageRecordingFailedAlarm", {
      alarmDescription:
        "Sandbox Agent Worker could not record a turn's usage after every retry, so that turn's usage is missing. " +
        "Investigate the Agent Worker Lambda logs (logDetailType=SandboxSpacesUsageRecordingFailed) " +
        "in the ISB global log group and the Sandbox Spaces usage table.",
      metric: usageRecordingFailedFilter.metric({
        statistic: "sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Worker Lambda — SQS consumer, batchSize 1, reserved concurrency 10, 15 min timeout.
    // Owns: persona routing, lease validation, Sandbox Spaces usage settlement,
    // memory read/write, and runtime invocation.
    const workerLambda = new IsbLambdaFunction(this, "AgentWorkerLambda", {
      description:
        "Sandbox Agent worker: SQS consumer that routes messages, settles Sandbox Spaces usage, and streams runtime responses over WebSocket",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "sandbox-agent",
        "agent-worker",
        "src",
        "worker-handler.ts",
      ),
      handler: "handler",
      namespace,
      timeout: WORKER_TIMEOUT,
      reservedConcurrentExecutions: 10,
      envSchema: AgentWorkerLambdaEnvironmentSchema,
      environment: {
        CONNECTIONS_TABLE_NAME: this.connectionsTable.tableName,
        LEASE_TABLE_NAME: leaseTable,
        PRINCIPAL_TABLE_NAME: principalTable,
        SANDBOX_SPACES_USAGE_TABLE_NAME: sandboxSpacesUsageTable,
        CONFIG_TABLE_NAME: configTableName,
        BEDROCK_REGIONAL_PRICE_TABLE_NAME:
          IsbComputeResources.bedrockPriceTable.tableName,
        ACCOUNT_POOL_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns
            .accountPoolConfigParamArn,
        IDC_ROLE_ARN: getIdcRoleArn(scope, namespace, idcAccountId),
        IDC_CONFIG_PARAM_ARN: idcConfigParamArn,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        WEBSOCKET_API_ENDPOINT: this.webSocketCallbackUrl,
        AGENT_RUNTIME_ARN: this.agentRuntime.attrAgentRuntimeArn,
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        COGNITO_APP_CLIENT_ID: cognitoAppClientId,
        ISB_NAMESPACE: namespace,
      },
      logGroup: IsbComputeResources.globalLogGroup,
    });

    workerLambda.lambdaFunction.addEventSource(
      new SqsEventSource(this.agentQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    this.connectionsTable.grantReadData(workerLambda.lambdaFunction);
    grantIsbDbReadOnly(
      scope,
      workerLambda,
      leaseTable,
      configTableName,
      principalTable,
    );
    grantIsbDbReadWrite(scope, workerLambda, sandboxSpacesUsageTable);
    // Prices a turn from the Bedrock regional price table, read by key. A price
    // that is missing or stale is fetched from the pricing APIs.
    IsbComputeResources.bedrockPriceTable.grant(
      workerLambda.lambdaFunction,
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
    );
    workerLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "pricing:GetProducts",
          "bedrock:ListFoundationModelAgreementOffers",
        ],
        resources: ["*"],
      }),
    );
    kmsKey.grantEncryptDecrypt(workerLambda.lambdaFunction);
    grantIsbSsmParameterRead(
      workerLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbSsmParameterRead(
      workerLambda.lambdaFunction.role! as Role,
      idcConfigParamArn,
    );

    // Allow Worker to assume IdcRole (via IntermediateRole) to call SSO Admin
    // APIs for permission set policy resolution.
    workerLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [IntermediateRole.getRoleArn()],
      }),
    );

    workerLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          this.agentRuntime.attrAgentRuntimeArn,
          `${this.agentRuntime.attrAgentRuntimeArn}/runtime-endpoint/*`,
        ],
      }),
    );

    // Allow Worker to post responses back to WebSocket clients.
    workerLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${webSocketToSqs.webSocketApi.apiId}/${webSocketToSqs.webSocketStage.stageName}/POST/@connections/*`,
        ],
      }),
    );
  }
}
