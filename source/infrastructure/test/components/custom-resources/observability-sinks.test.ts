// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AssetCode, Code } from "aws-cdk-lib/aws-lambda";
import yaml from "js-yaml";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  OBSERVABILITY_SINK_TAG,
  ObservabilitySinksPropertiesSchema,
  SINK_ID_MAPPING_KEY,
  SINK_IDS_JSON_ATTRIBUTE,
  STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
} from "@amzn/innovation-sandbox-commons/data/observability-sink-config/observability-sink-config.js";
import { ValidatorExclusionConfigSchema } from "@amzn/innovation-sandbox-commons/data/validator-exclusion-config/validator-exclusion-config.js";
import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

// Prevent real bundling / file ops during synth.
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

const CONSTRUCT_PREFIX = "ObservabilitySinks";
const HUB_ACCOUNT_FIXTURE = "111111111111";
const VERSION_FIXTURE = "1.2.3";
const VALIDATOR_EXCLUSIONS = path.resolve(
  __dirname,
  "../../../lib/components/config/validator-exclusion-config.yaml",
);

type CfnResourceJson = {
  Type: string;
  Condition?: string;
  DependsOn?: string[];
  Properties: Record<string, any>;
};

beforeAll(() => {
  vi.spyOn(Code, "fromAsset").mockImplementation(() => {
    const mockCode = new AssetCode("/mock/path");
    mockCode.bind = () => ({
      s3Location: { bucketName: "mock-bucket", objectKey: "mock-key" },
    });
    mockCode.bindToResource = vi.fn();
    return mockCode;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

// The inline policy CDK attaches to one role, as a list of statements.
function statementsOf(template: Template, roleId: string): any[] {
  const policies = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ).filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleId));
  expect(policies, roleId).toHaveLength(1);
  return policies[0]!.Properties.PolicyDocument.Statement;
}

function roleIdNamed(template: Template, nameFragment: string): string {
  const [id] = Object.entries(template.findResources("AWS::IAM::Role")).find(
    ([, r]) =>
      JSON.stringify(r.Properties.RoleName ?? "").includes(nameFragment),
  )!;
  return id;
}

describe("Observability sinks and link StackSet in the Compute stack", () => {
  let template: Template;
  let resources: Record<string, CfnResourceJson>;
  let sinks: CfnResourceJson;
  let sinksId: string;
  let linkStackSet: CfnResourceJson;

  // The link template is a Join of literal JSON around three tokens: the sink
  // id map in Mappings, the solution version, and this account's id inside
  // the Fn::Sub string.
  function linkTemplateWith(sinkIdsJson: string) {
    const body = linkStackSet.Properties.TemplateBody["Fn::Join"][1]
      .map((part: any) => {
        if (typeof part === "string") {
          return part;
        }
        if (part["Fn::GetAtt"]) {
          return sinkIdsJson;
        }
        return part["Fn::FindInMap"] ? VERSION_FIXTURE : HUB_ACCOUNT_FIXTURE;
      })
      .join("");
    return JSON.parse(body);
  }

  beforeAll(() => {
    // the Compute stack stages the frontend bundle as an asset, which CI has not built yet
    mkdirSync(path.resolve(__dirname, "../../../../frontend/dist"), {
      recursive: true,
    });
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    template = Template.fromStack(new IsbComputeStack(app, "IsbComputeStack"));
    resources = template.toJSON().Resources;
    [sinksId, sinks] = Object.entries(
      template.findResources("Custom::ObservabilitySinks"),
    )[0] as [string, CfnResourceJson];
    linkStackSet = Object.values(
      template.findResources("AWS::CloudFormation::StackSet"),
    )[0] as CfnResourceJson;
  });

  it("declares exactly one StackSet and hands the custom resource every property its schema names", () => {
    expect(
      Object.keys(template.findResources("AWS::CloudFormation::StackSet")),
    ).toHaveLength(1);
    const handed = Object.keys(sinks.Properties).filter(
      (key) => key !== "ServiceToken",
    );
    expect(handed.sort()).toEqual(
      Object.keys(ObservabilitySinksPropertiesSchema.shape).sort(),
    );
  });

  it("hands the custom resource the pool OU, the managed regions and both account ids", () => {
    expect(sinks.Properties).toMatchObject({
      namespace: { Ref: "Namespace" },
      hubAccountId: { Ref: "AWS::AccountId" },
      orgMgtAccountId: { Ref: "OrgMgtAccountId" },
      partition: { Ref: "AWS::Partition" },
      solutionVersion: expect.anything(),
    });
    // every namespace in the account shares the sink, so its tag names none
    expect(sinks.Properties.sinkTag).toEqual(OBSERVABILITY_SINK_TAG);
    expect(JSON.stringify(sinks.Properties.sandboxOuId)).toMatch(
      /"Fn::GetAtt":\["IsbSpokeConfigJsonParamResolver.*","sandboxOuId"\]/,
    );
    // The org id comes from the AccountPool stack, so the handler needs no
    // DescribeOrganization call.
    expect(JSON.stringify(sinks.Properties.organizationId)).toMatch(
      /"Fn::GetAtt":\["IsbSpokeConfigJsonParamResolver.*","organizationId"\]/,
    );
    expect(JSON.stringify(sinks.Properties.managedRegions)).toMatch(
      /^\{"Fn::GetAtt":\["IsbSpokeConfigJsonParamResolver\w+","isbManagedRegions"\]\}$/,
    );
    expect(sinks.Condition).toBeUndefined();
  });

  it("lets the Lambda manage sinks in this account and reach OrgMgtRole through IntermediateRole", () => {
    const functionId = Object.keys(resources).find(
      (id) =>
        id.startsWith(`${CONSTRUCT_PREFIX}Function`) &&
        resources[id]!.Type === "AWS::Lambda::Function",
    )!;
    const lambda = resources[functionId]!;
    const roleId = lambda.Properties.Role["Fn::GetAtt"][0];
    const statements = statementsOf(template, roleId);
    const resourceOf = (action: string) =>
      JSON.stringify(
        statements.find((s) => [s.Action].flat().includes(action))!.Resource,
      );

    expect(lambda.Properties.Timeout).toBe(300);
    expect(
      JSON.stringify(lambda.Properties.Environment.Variables.ORG_MGT_ROLE_ARN),
    ).toContain('{"Ref":"OrgMgtAccountId"},":role/InnovationSandbox-"');
    expect(
      JSON.stringify(
        lambda.Properties.Environment.Variables.INTERMEDIATE_ROLE_ARN,
      ),
    ).toContain('"Fn::GetAtt":["IntermediateRole');
    expect(resourceOf("sts:AssumeRole")).toContain(
      '"Fn::GetAtt":["IntermediateRole',
    );
    // CreateSink takes no resource ARN; the request-tag condition scopes it
    expect(resourceOf("oam:CreateSink")).toBe('"*"');
    expect(resourceOf("oam:DeleteSink")).toContain(
      ':oam:*:",{"Ref":"AWS::AccountId"},":sink/*"',
    );
    expect(resourceOf("oam:PutSinkPolicy")).toBe(resourceOf("oam:DeleteSink"));
    expect(resourceOf("oam:GetSinkPolicy")).toBe(resourceOf("oam:DeleteSink"));
    expect(resourceOf("oam:ListSinks")).toBe('"*"');
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(
      actions.filter((a) => /^(oam|organizations):/.test(a)).sort(),
    ).toEqual([
      "oam:CreateSink",
      "oam:DeleteSink",
      "oam:GetSinkPolicy",
      "oam:ListSinks",
      "oam:PutSinkPolicy",
      "oam:TagResource",
    ]);
    // creates only sinks carrying the shared tag and manages only those, so
    // every namespace's role reaches the one shared sink and nothing else
    const conditionOf = (action: string) =>
      statements.find((s) => [s.Action].flat().includes(action))!.Condition;
    const tagCondition = (kind: "RequestTag" | "ResourceTag") => ({
      StringEquals: {
        [`aws:${kind}/${OBSERVABILITY_SINK_TAG.key}`]:
          OBSERVABILITY_SINK_TAG.value,
      },
    });
    for (const action of ["oam:CreateSink", "oam:TagResource"]) {
      expect(conditionOf(action), action).toEqual(tagCondition("RequestTag"));
    }
    expect(resourceOf("oam:TagResource")).toBe(resourceOf("oam:DeleteSink"));
    for (const action of [
      "oam:DeleteSink",
      "oam:GetSinkPolicy",
      "oam:PutSinkPolicy",
    ]) {
      expect(conditionOf(action), action).toEqual(tagCondition("ResourceTag"));
    }
  });

  it("creates the link StackSet from this account as itself or as a delegated administrator", () => {
    const [conditionId, condition] = Object.entries(
      template.findConditions("*"),
    ).find(([id]) => /HubIsManagementAccount/.test(id))!;
    expect(condition).toEqual({
      "Fn::Equals": [{ Ref: "OrgMgtAccountId" }, { Ref: "AWS::AccountId" }],
    });

    expect(linkStackSet.Condition).toBeUndefined();
    expect(linkStackSet.Properties.PermissionModel).toBe("SERVICE_MANAGED");
    expect(linkStackSet.Properties.CallAs).toEqual({
      "Fn::If": [conditionId, "SELF", "DELEGATED_ADMIN"],
    });
    expect(linkStackSet.Properties.AutoDeployment).toEqual({
      Enabled: true,
      RetainStacksOnAccountRemoval: false,
    });
    expect(linkStackSet.Properties.StackInstancesGroup).toEqual([
      {
        DeploymentTargets: {
          OrganizationalUnitIds: [sinks.Properties.sandboxOuId],
        },
        Regions: sinks.Properties.managedRegions,
      },
    ]);
    expect(linkStackSet.Properties.OperationPreferences).toEqual({
      ConcurrencyMode: "SOFT_FAILURE_TOLERANCE",
      FailureTolerancePercentage: 100,
      MaxConcurrentPercentage: 100,
      RegionConcurrencyType: "PARALLEL",
    });
    expect(linkStackSet.Properties.ManagedExecution).toEqual({ Active: true });
    expect(linkStackSet.Properties.TemplateURL).toBeUndefined();
    expect(JSON.stringify(linkStackSet.Properties.StackSetName)).toContain(
      '{"Ref":"Namespace"}',
    );
  });

  it("orders sinks before links by building the link template from the custom resource", () => {
    expect(JSON.stringify(linkStackSet.Properties.TemplateBody)).toContain(
      `"Fn::GetAtt":["${sinksId}","${SINK_IDS_JSON_ATTRIBUTE}"]`,
    );
    expect(JSON.stringify(linkStackSet.Properties.TemplateBody)).toContain(
      '{"Ref":"AWS::AccountId"}',
    );
    expect(linkStackSet.DependsOn).toEqual([sinksId]);
  });

  it("assembles a parameterless link template pinned to Bedrock metrics", () => {
    const linkTemplate = linkTemplateWith(
      JSON.stringify({ "us-east-1": { [SINK_ID_MAPPING_KEY]: "abc-123" } }),
    );
    const link = linkTemplate.Resources.BedrockMetricsLink;
    const [arnPattern, variables] = link.Properties.SinkIdentifier["Fn::Sub"];
    const [mapName, regionRef, key] = variables.SinkId["Fn::FindInMap"];

    // parameter overrides never reach auto-deployed accounts, so there are none
    expect(linkTemplate.Parameters).toBeUndefined();
    expect(Object.keys(linkTemplate.Resources)).toEqual(["BedrockMetricsLink"]);
    expect(link.Type).toBe("AWS::Oam::Link");
    // a new release changes the template, which re-drives failed instances
    expect(link.Metadata.SolutionVersion).toBe(VERSION_FIXTURE);
    expect(arnPattern).toBe(
      `arn:\${AWS::Partition}:oam:\${AWS::Region}:${HUB_ACCOUNT_FIXTURE}:sink/\${SinkId}`,
    );
    expect(regionRef).toEqual({ Ref: "AWS::Region" });
    expect(linkTemplate.Mappings[mapName]["us-east-1"][key]).toBe("abc-123");
    expect(link.Properties.LabelTemplate).toBe("$AccountName");
    expect(link.Properties.ResourceTypes).toEqual(["AWS::CloudWatch::Metric"]);
    expect(link.Properties.LinkConfiguration).toEqual({
      MetricConfiguration: { Filter: "Namespace IN ('AWS/Bedrock')" },
    });
  });

  it("excludes the link from post-cleanup validation", () => {
    const exclusions = ValidatorExclusionConfigSchema.parse(
      yaml.load(readFileSync(VALIDATOR_EXCLUSIONS, "utf8")),
    );

    expect(exclusions.validation.excludedArnPatterns).toContain(
      "arn:aws:oam:*:*:link/*",
    );
  });
});

describe("OrgMgtRole permissions for the observability sink custom resource", () => {
  let template: Template;
  let statements: any[];

  beforeAll(() => {
    const app = new App();
    template = Template.fromStack(
      new IsbAccountPoolStack(app, "IsbAccountPoolStack"),
    );
    // OrgMgtRole carries more than one inline policy
    const roleId = roleIdNamed(template, "-OrgMgtRole");
    statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
  });

  const withAction = (action: string) =>
    statements.filter((s) => [s.Action].flat().includes(action));

  it("walks the organization tree and registers only the hub, only for StackSets", () => {
    // The org id arrives through the shared config, so no unscoped read.
    expect(withAction("organizations:DescribeOrganization")).toHaveLength(0);
    const [listDelegated] = withAction(
      "organizations:ListDelegatedAdministrators",
    );
    expect(listDelegated.Resource).toBe("*");
    expect(listDelegated.Condition).toEqual({
      StringEquals: {
        "organizations:ServicePrincipal":
          STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
      },
    });
    expect(
      JSON.stringify(withAction("organizations:ListParents")[0]!.Resource),
    ).toMatch(
      /:organizations::",\{"Ref":"AWS::AccountId"\},":ou\/",\{"Fn::Select"/,
    );

    const [register] = withAction(
      "organizations:RegisterDelegatedAdministrator",
    );
    expect(JSON.stringify(register.Resource)).toMatch(
      /":account\/",\{"Fn::Select".*,"\/",\{"Ref":"HubAccountId"\}/,
    );
    expect(register.Condition).toEqual({
      StringEquals: {
        "organizations:ServicePrincipal":
          STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL,
      },
    });
  });

  it("keeps the oam-denying SCP attached to the pool OU, where every sandbox account lives", () => {
    const nukeScp = Object.values(
      template.findResources("AWS::Organizations::Policy"),
    ).find((p) => JSON.stringify(p.Properties.Name).includes("NukeSupported"))!;
    expect(nukeScp.Properties.TargetIds).toEqual([
      { "Fn::GetAtt": ["InnovationSandboxAccountPoolOu", "Id"] },
    ]);
  });

  it("carries no observability resources of its own", () => {
    const json = JSON.stringify(template.toJSON().Resources);
    expect(json).not.toContain("ObservabilityLinks");
    expect(json).not.toContain("AWS::Oam::");
  });
});
