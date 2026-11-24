// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ensureDirSync } from "fs-extra";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
import { IsbIdcStack } from "@amzn/innovation-sandbox-infrastructure/isb-idc-stack";
import { IsbM2mClientStack } from "@amzn/innovation-sandbox-infrastructure/isb-m2m-client-stack";
import { IsbSandboxAccountStack } from "@amzn/innovation-sandbox-infrastructure/isb-sandbox-account-stack";
import { AssetCode, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISource, Source } from "aws-cdk-lib/aws-s3-deployment";

// Prevent real npm installs / file ops during synth.
vi.mock("child_process", () => ({
  execSync: vi.fn().mockImplementation(() => Buffer.from("mocked execSync")),
}));

vi.mock("fs-extra", () => ({
  moveSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  ensureDirSync: vi.fn(),
}));

function normalizeNonDeterministicTemplate(template: Template) {
  const lambdas = template.findResources("AWS::Lambda::Function");
  const layers = template.findResources("AWS::Lambda::LayerVersion");
  const bucketDeployments = template.findResources(
    "Custom::CDKBucketDeployment",
  );
  const spokeConfigParserCustomResources = template.findResources(
    "Custom::ParseJsonConfiguration",
  );
  const cognitoPostDeployCustomResources = template.findResources(
    "Custom::CognitoPostDeployConfigurer",
  );
  const tagActivationTriggerCustomResources = template.findResources(
    "Custom::TagActivationTrigger",
  );
  const stackSets = template.findResources("AWS::CloudFormation::StackSet");

  // Clone so normalization doesn't mutate the Template shared with render assertions.
  const templateJson = structuredClone(template.toJSON());

  for (const lambda in lambdas) {
    templateJson["Resources"][lambda]["Properties"]["Code"] =
      "Omitted to remove snapshot dependency on hash";
  }

  for (const layer in layers) {
    templateJson["Resources"][layer]["Properties"]["Content"] =
      "Omitted to remove snapshot dependency on hash";
  }

  for (const bucketDeployment in bucketDeployments) {
    templateJson["Resources"][bucketDeployment]["Properties"][
      "SourceObjectKeys"
    ] = "Omitted to remove snapshot dependency on hash";
  }

  for (const cr in spokeConfigParserCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  for (const cr in cognitoPostDeployCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  for (const cr in tagActivationTriggerCustomResources) {
    templateJson["Resources"][cr]["Properties"]["forceUpdate"] =
      "Omitted to remove snapshot dependency on generated auto incrementing id";
  }

  const agentRuntimes = template.findResources(
    "AWS::BedrockAgentCore::Runtime",
  );
  for (const runtime in agentRuntimes) {
    const variables =
      templateJson["Resources"][runtime]["Properties"]["EnvironmentVariables"];
    if (variables && "AGENT_RUNTIME_SOURCE_HASH" in variables) {
      variables["AGENT_RUNTIME_SOURCE_HASH"] =
        "Omitted to remove snapshot dependency on hash";
    }
  }

  for (const stackSet in stackSets) {
    if ("TemplateURL" in templateJson["Resources"][stackSet]["Properties"]) {
      templateJson["Resources"][stackSet]["Properties"]["TemplateURL"] =
        "Omitted to remove snapshot dependency on hash";
    }
  }

  // The private agent runtime image tag embeds the source hash.
  return JSON.parse(
    JSON.stringify(templateJson).replaceAll(
      /source-[a-f0-9]{64}/g,
      "source-<omitted to remove snapshot dependency on hash>",
    ),
  );
}

function toFullDepthSnapshot(templateJson: Record<string, any>): string {
  return JSON.stringify(templateJson, null, 2);
}

const DDB_READ_ONLY_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:Query",
  "dynamodb:Scan",
  "dynamodb:ConditionCheckItem",
  "dynamodb:BatchGetItem",
];

const DDB_READ_WRITE_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:Query",
  "dynamodb:Scan",
  "dynamodb:ConditionCheckItem",
  "dynamodb:BatchGetItem",
  "dynamodb:BatchWriteItem",
];

/**
 * The action sets one Lambda's inline policies grant over one table, matched by
 * the shared-spoke-config attribute its ARN resolves from. One array per matching
 * statement, so an extra statement or an extra action fails the comparison rather
 * than widening a grant unnoticed.
 */
function dynamoActionSetsFor(
  template: Template,
  policyLogicalIdPrefix: string,
  tableAttribute: string,
): string[][] {
  return Object.entries(template.findResources("AWS::IAM::Policy"))
    .filter(([logicalId]) => logicalId.startsWith(policyLogicalIdPrefix))
    .flatMap(([, resource]) =>
      (resource.Properties.PolicyDocument.Statement as any[]).filter(
        (statement) =>
          JSON.stringify(statement.Resource).includes(`"${tableAttribute}"`),
      ),
    )
    .map((statement) => statement.Action as string[]);
}

/** Fails on any table synthesized without deletion protection in prod mode. */
function expectDeletionProtectionOnEveryTable(template: Template) {
  const tables = Object.values(template.findResources("AWS::DynamoDB::Table"));
  expect(tables).not.toHaveLength(0);
  for (const table of tables) {
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
  }
}

beforeAll(async () => {
  vi.spyOn(Code, "fromAsset").mockImplementation(() => {
    const mockCode = new AssetCode("/mock/path");
    mockCode.bind = () => ({
      s3Location: {
        bucketName: "mock-bucket",
        objectKey: "mock-key",
      },
    });
    mockCode.bindToResource = vi.fn();

    return mockCode;
  });

  vi.spyOn(Source, "asset").mockImplementation((path) => {
    const mockBucket = {
      bucketName: "mock-source-bucket",
    } as IBucket;

    return {
      bind: () => ({
        bucket: mockBucket,
        zipObjectKey: "mock-source-key",
        deployTime: true,
        objectKey: "mock-object-key",
      }),
      bindToStackSynthesizer: vi.fn(),
      path: path || "/mock/asset/path",
    } as ISource;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("IsbComputeStack Snapshot", () => {
  // Synthesized once and shared, so the grant assertions below can run against
  // the same template as the snapshot test.
  let template: Template;

  beforeAll(() => {
    ensureDirSync(path.join(__dirname, "..", "..", "frontend", "dist"));
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbComputeStack(app, "IsbComputeStack");
    template = Template.fromStack(stack);
  });

  it("grants Lease Monitoring read-write on the lease cost history table", () => {
    expect(
      dynamoActionSetsFor(template, "LeaseMonitoring", "leaseCostHistoryTable"),
    ).toEqual([DDB_READ_WRITE_ACTIONS]);
  });

  it("grants Lease Monitoring read-only on the config table", () => {
    expect(
      dynamoActionSetsFor(template, "LeaseMonitoring", "configTableName"),
    ).toEqual([DDB_READ_ONLY_ACTIONS]);
  });

  it("grants Lease Monitoring no access to the Sandbox Spaces usage table", () => {
    expect(
      dynamoActionSetsFor(
        template,
        "LeaseMonitoring",
        "sandboxSpacesUsageTable",
      ),
    ).toEqual([]);
  });

  it("grants the Leases API read-only on the lease cost history table", () => {
    expect(
      dynamoActionSetsFor(
        template,
        "LeasesLambdaFunction",
        "leaseCostHistoryTable",
      ),
    ).toEqual([DDB_READ_ONLY_ACTIONS]);
  });

  it("creates the WebSocket stage only after the API Gateway account logging role is set", () => {
    const [accountId] = Object.keys(
      template.findResources("AWS::ApiGateway::Account"),
    );
    const stages = Object.values(
      template.findResources("AWS::ApiGatewayV2::Stage"),
    );
    expect(accountId).toBeDefined();
    expect(stages).toHaveLength(1);
    expect(stages[0]!.DependsOn).toContain(accountId);
  });

  it("grants the Configurations API region-scoped Bedrock model lookups", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: "bedrock:GetFoundationModel",
            Effect: "Allow",
            Resource: {
              "Fn::Join": [
                "",
                Match.arrayWith([
                  Match.stringLikeRegexp("::foundation-model/\\*$"),
                ]),
              ],
            },
          },
          {
            Action: "bedrock:GetInferenceProfile",
            Effect: "Allow",
            Resource: {
              "Fn::Join": [
                "",
                Match.arrayWith([
                  Match.stringLikeRegexp(":inference-profile/\\*$"),
                ]),
              ],
            },
          },
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp(
            "^ConfigurationsLambdaFunctionFunctionRole",
          ),
        },
      ]),
    });
  });

  it("deletes the recoverable Bedrock price cache with the Compute stack", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        DeletionProtectionEnabled: false,
        KeySchema: [
          { AttributeName: "modelId", KeyType: "HASH" },
          { AttributeName: "region", KeyType: "RANGE" },
        ],
      }),
      UpdateReplacePolicy: "Delete",
      DeletionPolicy: "Delete",
    });
  });

  it("deletes the recoverable WebSocket connections with the Compute stack", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        DeletionProtectionEnabled: false,
        KeySchema: [{ AttributeName: "connectionId", KeyType: "HASH" }],
      }),
      UpdateReplacePolicy: "Delete",
      DeletionPolicy: "Delete",
    });
  });

  it("matches the snapshot", () => {
    const templateJson = normalizeNonDeterministicTemplate(template);
    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbDataStack Snapshot", () => {
  // Synthesize once and share: IsbDataStack binds a shared singleton to its
  // App, so instantiating it a second time in another App throws
  // CannotReferenceAcrossApps. Built in beforeAll so the top-level asset mocks
  // are already applied.
  let template: Template;

  beforeAll(() => {
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbDataStack(app, "IsbDataStack");
    template = Template.fromStack(stack);
  });

  it("enables deletion protection on every DynamoDB table", () => {
    expectDeletionProtectionOnEveryTable(template);
  });

  it("grants the config migrator role dynamodb:BatchGetItem and dynamodb:PutItem", () => {
    // The migrator's destination-first idempotency check calls getAllSections()
    // (BatchGetItem) before the migration write (PutItem). Both must be granted
    // or the custom resource fails with AccessDeniedException on deploy. This
    // asserts against the synthesized IAM policy because unit tests mock
    // DynamoDB and never exercise IAM. Runs before the snapshot test, which
    // mutates the template JSON in place.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith([
              "dynamodb:BatchGetItem",
              "dynamodb:PutItem",
            ]),
          }),
        ]),
      },
    });
  });

  it("creates the lease cost history table with CMK encryption, TTL, deletion protection and no GSI", () => {
    const keySchema = [
      { AttributeName: "leaseUuid", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ];

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: keySchema,
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      SSESpecification: {
        SSEEnabled: true,
        SSEType: "KMS",
        KMSMasterKeyId: Match.anyValue(),
      },
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });

    // A GSI key attribute rejects a null, and the store writes nulls
    // deliberately, so the absence of an index is a constraint rather than a
    // simplification.
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { KeySchema: keySchema },
    });
    expect(Object.keys(tables)).toHaveLength(1);
    expect(
      Object.values(tables)[0]!.Properties.GlobalSecondaryIndexes,
    ).toBeUndefined();
  });

  it("matches the snapshot", () => {
    const templateJson = normalizeNonDeterministicTemplate(template);
    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbAccountPoolStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbAccountPoolStack(app, "IsbAccountPoolStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IdcStack Snapshot", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbIdcStack(app, "IsbIdcStack");
    template = Template.fromStack(stack);
  });

  it("grants the IdcRole permission-set read actions scoped to the SSO instance and its permission sets", () => {
    // A focused assertion prevents a snapshot update from masking an overbroad grant.
    const permissionSetArn = {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":sso:::permissionSet/",
          {
            "Fn::Select": [
              1,
              { "Fn::Split": ["/", { Ref: "SsoInstanceArn" }] },
            ],
          },
          "/*",
        ],
      ],
    };

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith([
              "sso:ListManagedPoliciesInPermissionSet",
              "sso:GetPermissionsBoundaryForPermissionSet",
            ]),
            // Exact resources prevent accidental grant widening.
            Resource: [{ Ref: "SsoInstanceArn" }, permissionSetArn],
          }),
        ]),
      },
    });
  });

  it.each([
    "sso:ListManagedPoliciesInPermissionSet",
    "sso:GetPermissionsBoundaryForPermissionSet",
  ])("does not grant %s on a wildcard resource", (action) => {
    const overBroadStatements = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).flatMap((policy) =>
      (policy.Properties.PolicyDocument.Statement as any[]).filter(
        (statement) =>
          ([] as string[]).concat(statement.Action).includes(action) &&
          ([] as unknown[]).concat(statement.Resource).includes("*"),
      ),
    );
    expect(overBroadStatements).toEqual([]);
  });

  it("matches the snapshot", () => {
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("SandboxAccountStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbSandboxAccountStack(app, "IsbSandboxAccountStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});

describe("IsbM2mClientStack Snapshot", () => {
  it("matches the snapshot", () => {
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbM2mClientStack(app, "IsbM2mClientStack");
    const template = Template.fromStack(stack);
    const templateJson = normalizeNonDeterministicTemplate(template);

    expect(toFullDepthSnapshot(templateJson)).toMatchSnapshot();
  });
});
