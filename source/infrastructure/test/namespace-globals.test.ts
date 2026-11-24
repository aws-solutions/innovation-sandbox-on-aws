// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the multi-deployment namespacing (CR-289471570): assert that every
// org/account/region-global physical name is rendered as `${namespace}-<suffix>` (a
// Fn::Join around {"Ref":"Namespace"}). These are deliberately kept OUT of the snapshot
// suite so a regression to a hardcoded constant fails a named, intention-revealing test
// rather than only showing up as a re-baselineable snapshot diff.
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ensureDirSync } from "fs-extra";
import path from "path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
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

  vi.spyOn(Source, "asset").mockImplementation((assetPath) => {
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
      path: assetPath || "/mock/asset/path",
    } as ISource;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

// A `${namespace}-<suffix>` physical name as rendered in the template.
const namespacedName = (suffix: string) => ({
  "Fn::Join": ["", [{ Ref: "Namespace" }, suffix]],
});

describe("IsbComputeStack namespaced globals", () => {
  let template: Template;

  beforeAll(() => {
    ensureDirSync(path.join(__dirname, "..", "..", "frontend", "dist"));
    // The sandbox agent runtime requires a private ECR repository name at synth time.
    const app = new App({
      context: {
        privateSandboxAgentRuntimeEcrRepo: "isb-sandbox-agent-runtime-test",
      },
    });
    const stack = new IsbComputeStack(app, "IsbComputeStack");
    template = Template.fromStack(stack);
  });

  it("namespaces the core EventBus name", () => {
    template.hasResourceProperties("AWS::Events::EventBus", {
      Name: namespacedName("-ISBEventBus"),
    });
  });

  it("namespaces the global and WAF Logs resource policy names", () => {
    template.hasResourceProperties("AWS::Logs::ResourcePolicy", {
      PolicyName: namespacedName("-ISBLogGroupPolicy"),
    });
    template.hasResourceProperties("AWS::Logs::ResourcePolicy", {
      PolicyName: namespacedName("-IsbWafLogGroupPolicy"),
    });
  });

  it("namespaces the CloudFront OAC, response headers policies, and functions", () => {
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        Name: namespacedName("-IsbCloudFrontDistributionOac"),
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: namespacedName("-IsbCloudFrontResponseHeadersPolicy"),
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: namespacedName("-IsbApiCloudFrontResponseHeadersPolicy"),
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::Function", {
      Name: namespacedName("-IsbPathRewriteCloudFrontFunction"),
    });
    template.hasResourceProperties("AWS::CloudFront::Function", {
      Name: namespacedName("-IsbS3OriginPathRedirectCloudFrontFunction"),
    });
  });
});

describe("IsbDataStack namespaced globals", () => {
  // Synthesize once and share: IsbDataStack binds a shared singleton to its App, so
  // instantiating it a second time in another App throws CannotReferenceAcrossApps.
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new IsbDataStack(app, "IsbDataStack");
    template = Template.fromStack(stack);
  });

  it("namespaces the AppConfig Application and DeploymentStrategy names", () => {
    template.hasResourceProperties("AWS::AppConfig::Application", {
      Name: namespacedName("-Config-Application"),
    });
    template.hasResourceProperties("AWS::AppConfig::DeploymentStrategy", {
      Name: namespacedName("-Config-DeploymentStrategy"),
    });
  });

  // Assert all 17 exports (stackName resolves to the "IsbDataStack" construct id at synth).
  it.each([
    "ConfigApplicationId",
    "ConfigEnvironmentId",
    "ConfigDeploymentStrategyId",
    "NukeConfigConfigurationProfileId",
    "ValidatorExclusionConfigConfigurationProfileId",
    "SandboxAccountTable",
    "LeaseTemplateTable",
    "LeaseTable",
    "PrincipalTable",
    "CleanupReportTable",
    "CognitoUserPoolId",
    "CognitoAppClientId",
    "CognitoMcpClientId",
    "CognitoIdentityPoolId",
    "CognitoDomain",
    "CognitoAcsUrl",
    "CognitoAudience",
  ])("namespaces the CFN export name %s", (key) => {
    template.hasOutput("*", {
      Export: {
        Name: {
          "Fn::Join": ["", ["IsbDataStack-", { Ref: "Namespace" }, `-${key}`]],
        },
      },
    });
  });
});

describe("IsbAccountPoolStack namespaced globals", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new IsbAccountPoolStack(app, "IsbAccountPoolStack");
    template = Template.fromStack(stack);
  });

  // The 5 SCP names are org-global (root cause of the original DuplicatePolicyException).
  it.each([
    "-InnovationSandboxAwsNukeSupportedServicesScp",
    "-InnovationSandboxRestrictionsScp",
    "-InnovationSandboxProtectISBResourcesScp",
    "-InnovationSandboxLimitRegionsScp",
    "-InnovationSandboxWriteProtectionScp",
  ])("namespaces the SCP name %s", (suffix) => {
    template.hasResourceProperties("AWS::Organizations::Policy", {
      Name: namespacedName(suffix),
    });
  });
});
