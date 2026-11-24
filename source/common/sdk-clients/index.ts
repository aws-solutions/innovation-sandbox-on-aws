// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { AccessAnalyzerClient } from "@aws-sdk/client-accessanalyzer";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { AppConfigClient } from "@aws-sdk/client-appconfig";
import { AppConfigDataClient } from "@aws-sdk/client-appconfigdata";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { OAMClient } from "@aws-sdk/client-oam";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { PricingClient } from "@aws-sdk/client-pricing";
import { RAMClient } from "@aws-sdk/client-ram";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@aws-sdk/types";
import { IsbEventBridgeClient } from "./event-bridge-client.js";
import { IsbSecretsManagerClient } from "./secrets-manager-client.js";

let cachedAccessAnalyzerClient: AccessAnalyzerClient | null = null;
let cachedDynamoClient: DynamoDBDocumentClient | null = null;
let cachedSecretsManagerClient: IsbSecretsManagerClient | null = null;
let cachedStepFunctionsClient: SFNClient | null = null;
let cachedEC2Client: EC2Client | null = null;
let cachedSTSClient: STSClient | null = null;
let cachedAppConfigClient: AppConfigClient | null = null;
let cachedAppConfigDataClient: AppConfigDataClient | null = null;
let cachedOrgsClient: OrganizationsClient | null = null;
let cachedResourceGroupsTaggingApiClient: ResourceGroupsTaggingAPIClient | null =
  null;
let cachedIamClient: IAMClient | null = null;
let cachedIdentitystoreClient: IdentitystoreClient | null = null;
let cachedSSOAdminClient: SSOAdminClient | null = null;
let cachedCostExplorerClient: CostExplorerClient | null = null;
let cachedApiGatewayManagementClient: ApiGatewayManagementApiClient | null =
  null;
let cachedSESClient: SESClient | null = null;
let cachedSNSClient: SNSClient | null = null;
let cachedS3Client: S3Client | null = null;
let cachedCWLogsClient: CloudWatchLogsClient | null = null;
let cachedCloudWatchClient: CloudWatchClient | null = null;
let cachedCloudFormationClient: CloudFormationClient | null = null;
let cachedRamClient: RAMClient | null = null;
let cachedCodeBuildClient: CodeBuildClient | null = null;
let cachedCognitoIdpClient: CognitoIdentityProviderClient | null = null;
let cachedLambdaClient: LambdaClient | null = null;
let cachedSSMProvider: SSMProvider | null = null;
let cachedBedrockAgentCoreClient: BedrockAgentCoreClient | null = null;
let cachedBedrockClient: BedrockClient | null = null;
let cachedBedrockRuntimeClient: BedrockRuntimeClient | null = null;
let cachedPricingClient: PricingClient | null = null;

const tracer = new Tracer();

export class IsbClients {
  private constructor() {
    //static class. Shouldn't be constructable
  }

  public static accessAnalyzer(env: {
    USER_AGENT_EXTRA: string;
  }): AccessAnalyzerClient {
    cachedAccessAnalyzerClient ??= tracer.captureAWSv3Client(
      new AccessAnalyzerClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedAccessAnalyzerClient;
  }

  public static dynamo(env: {
    USER_AGENT_EXTRA: string;
  }): DynamoDBDocumentClient {
    cachedDynamoClient ??= tracer.captureAWSv3Client(
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          customUserAgent: env.USER_AGENT_EXTRA,
        }),
      ),
    );

    return cachedDynamoClient;
  }

  public static eventBridge(
    props: {
      eventSource: string;
    },
    env: {
      USER_AGENT_EXTRA: string;
      ISB_EVENT_BUS: string;
    },
  ): IsbEventBridgeClient {
    const client = new IsbEventBridgeClient(
      {
        Source: props.eventSource,
        EventBusName: env.ISB_EVENT_BUS,
      },
      {
        customUserAgent: env.USER_AGENT_EXTRA,
      },
    );
    return tracer.captureAWSv3Client(client);
  }

  public static secretsManager(env: {
    USER_AGENT_EXTRA: string;
  }): IsbSecretsManagerClient {
    cachedSecretsManagerClient ??= tracer.captureAWSv3Client(
      new IsbSecretsManagerClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedSecretsManagerClient;
  }

  public static stepFunctions(env: { USER_AGENT_EXTRA: string }): SFNClient {
    cachedStepFunctionsClient ??= tracer.captureAWSv3Client(
      new SFNClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedStepFunctionsClient;
  }

  public static ec2(env: { USER_AGENT_EXTRA: string }): EC2Client {
    cachedEC2Client ??= tracer.captureAWSv3Client(
      new EC2Client({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedEC2Client;
  }

  public static sts(env: { USER_AGENT_EXTRA: string }): STSClient {
    cachedSTSClient ??= tracer.captureAWSv3Client(
      new STSClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedSTSClient;
  }

  public static appConfig(env: { USER_AGENT_EXTRA: string }): AppConfigClient {
    //intentionally not traced in x-ray as this is typically loaded before X-ray has initialized and thus causes errors
    cachedAppConfigClient ??= new AppConfigClient({
      customUserAgent: env.USER_AGENT_EXTRA,
    });
    return cachedAppConfigClient;
  }

  public static appConfigData(env: {
    USER_AGENT_EXTRA: string;
  }): AppConfigDataClient {
    //intentionally not traced in x-ray as this is typically loaded before X-ray has initialized and thus causes errors
    cachedAppConfigDataClient ??= new AppConfigDataClient({
      customUserAgent: env.USER_AGENT_EXTRA,
    });
    return cachedAppConfigDataClient;
  }

  public static orgs(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): OrganizationsClient {
    cachedOrgsClient ??= tracer.captureAWSv3Client(
      new OrganizationsClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedOrgsClient;
  }

  public static iam(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): IAMClient {
    cachedIamClient ??= tracer.captureAWSv3Client(
      new IAMClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedIamClient;
  }

  public static identityStore(
    env: {
      USER_AGENT_EXTRA: string;
    },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): IdentitystoreClient {
    cachedIdentitystoreClient ??= tracer.captureAWSv3Client(
      new IdentitystoreClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedIdentitystoreClient;
  }

  public static ssoAdmin(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): SSOAdminClient {
    cachedSSOAdminClient ??= tracer.captureAWSv3Client(
      new SSOAdminClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedSSOAdminClient;
  }

  public static resourceGroupsTaggingApi(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): ResourceGroupsTaggingAPIClient {
    cachedResourceGroupsTaggingApiClient ??= tracer.captureAWSv3Client(
      new ResourceGroupsTaggingAPIClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedResourceGroupsTaggingApiClient;
  }

  public static costExplorer(
    env: {
      USER_AGENT_EXTRA: string;
    },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): CostExplorerClient {
    cachedCostExplorerClient ??= tracer.captureAWSv3Client(
      new CostExplorerClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        credentials,
      }),
    );
    return cachedCostExplorerClient;
  }

  public static ses(env: { USER_AGENT_EXTRA: string }): SESClient {
    cachedSESClient ??= tracer.captureAWSv3Client(
      new SESClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedSESClient;
  }

  // maxAttempts: 3 is the initial attempt plus up to two SDK retries.
  public static sns(env: { USER_AGENT_EXTRA: string }): SNSClient {
    cachedSNSClient ??= tracer.captureAWSv3Client(
      new SNSClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        maxAttempts: 3,
      }),
    );
    return cachedSNSClient;
  }

  public static s3(env: { USER_AGENT_EXTRA: string }): S3Client {
    cachedS3Client ??= tracer.captureAWSv3Client(
      new S3Client({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedS3Client;
  }

  public static cloudWatchLogs(env: {
    USER_AGENT_EXTRA: string;
  }): CloudWatchLogsClient {
    cachedCWLogsClient ??= tracer.captureAWSv3Client(
      new CloudWatchLogsClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedCWLogsClient;
  }

  public static cloudWatch(env: {
    USER_AGENT_EXTRA: string;
  }): CloudWatchClient {
    cachedCloudWatchClient ??= tracer.captureAWSv3Client(
      new CloudWatchClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedCloudWatchClient;
  }

  public static cloudFormation(env: {
    USER_AGENT_EXTRA: string;
  }): CloudFormationClient {
    cachedCloudFormationClient ??= tracer.captureAWSv3Client(
      new CloudFormationClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedCloudFormationClient;
  }

  public static ram(env: { USER_AGENT_EXTRA: string }): RAMClient {
    cachedRamClient ??= tracer.captureAWSv3Client(
      new RAMClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedRamClient;
  }

  public static cognitoIdp(env: {
    USER_AGENT_EXTRA: string;
  }): CognitoIdentityProviderClient {
    cachedCognitoIdpClient ??= tracer.captureAWSv3Client(
      new CognitoIdentityProviderClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedCognitoIdpClient;
  }

  public static ssmProvider(env: { USER_AGENT_EXTRA: string }): SSMProvider {
    cachedSSMProvider ??= new SSMProvider({
      clientConfig: {
        customUserAgent: env.USER_AGENT_EXTRA,
      },
    });
    return cachedSSMProvider;
  }

  public static codeBuild(env: { USER_AGENT_EXTRA: string }): CodeBuildClient {
    cachedCodeBuildClient ??= tracer.captureAWSv3Client(
      new CodeBuildClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedCodeBuildClient;
  }

  public static lambda(env: { USER_AGENT_EXTRA: string }): LambdaClient {
    cachedLambdaClient ??= tracer.captureAWSv3Client(
      new LambdaClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedLambdaClient;
  }

  public static apiGatewayManagement(env: {
    WEBSOCKET_API_ENDPOINT: string;
    USER_AGENT_EXTRA: string;
  }): ApiGatewayManagementApiClient {
    cachedApiGatewayManagementClient ??= tracer.captureAWSv3Client(
      new ApiGatewayManagementApiClient({
        endpoint: env.WEBSOCKET_API_ENDPOINT,
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedApiGatewayManagementClient;
  }

  public static bedrock(env: { USER_AGENT_EXTRA: string }): BedrockClient {
    cachedBedrockClient ??= tracer.captureAWSv3Client(
      new BedrockClient({ customUserAgent: env.USER_AGENT_EXTRA }),
    );
    return cachedBedrockClient;
  }

  public static bedrockRuntime(env: {
    USER_AGENT_EXTRA: string;
  }): BedrockRuntimeClient {
    // Bounds each call so a hung request can't stall a chat turn.
    cachedBedrockRuntimeClient ??= tracer.captureAWSv3Client(
      new BedrockRuntimeClient({
        customUserAgent: env.USER_AGENT_EXTRA,
        maxAttempts: 2,
        requestHandler: { requestTimeout: 15_000 },
      }),
    );
    return cachedBedrockRuntimeClient;
  }

  /**
   * AWS Pricing client for `pricing:GetProducts` (non-EULA model rates).
   * pricing:GetProducts is a global service — the client always targets us-east-1.
   */
  public static pricing(env: { USER_AGENT_EXTRA: string }): PricingClient {
    cachedPricingClient ??= tracer.captureAWSv3Client(
      new PricingClient({
        region: "us-east-1",
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedPricingClient;
  }

  /**
   * BedrockAgentCore client for Memory and runtime calls.
   * When credentials are provided (scoped Memory sessions), the client is NOT cached —
   * each scoped session gets a fresh client. Without credentials, the cached Lambda-role
   * client is returned (used for InvokeAgentRuntime).
   */
  public static bedrockAgentCore(
    env: { USER_AGENT_EXTRA: string },
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ): BedrockAgentCoreClient {
    if (credentials) {
      // Scoped credentials — never cache, credentials are per-request.
      return tracer.captureAWSv3Client(
        new BedrockAgentCoreClient({
          customUserAgent: env.USER_AGENT_EXTRA,
          credentials,
        }),
      );
    }
    cachedBedrockAgentCoreClient ??= tracer.captureAWSv3Client(
      new BedrockAgentCoreClient({
        customUserAgent: env.USER_AGENT_EXTRA,
      }),
    );
    return cachedBedrockAgentCoreClient;
  }

  /** One client per region: Bedrock token metrics are regional and the poll iterates the managed regions. */
  public static regionalCloudWatch(
    env: { USER_AGENT_EXTRA: string },
    region: string,
  ): CloudWatchClient {
    return tracer.captureAWSv3Client(
      new CloudWatchClient({ region, customUserAgent: env.USER_AGENT_EXTRA }),
    );
  }

  /** One client per region: Bedrock's model and agreement-offer listings are regional and the poll prices each region's models. */
  public static regionalBedrock(
    env: { USER_AGENT_EXTRA: string },
    region: string,
  ): BedrockClient {
    return tracer.captureAWSv3Client(
      new BedrockClient({ region, customUserAgent: env.USER_AGENT_EXTRA }),
    );
  }

  /** One client per region: sinks are regional and the caller iterates the managed regions. */
  public static oam(
    env: { USER_AGENT_EXTRA: string },
    region: string,
  ): OAMClient {
    return tracer.captureAWSv3Client(
      new OAMClient({ region, customUserAgent: env.USER_AGENT_EXTRA }),
    );
  }
}
