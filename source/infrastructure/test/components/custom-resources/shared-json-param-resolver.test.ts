// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AssetCode, Code } from "aws-cdk-lib/aws-lambda";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

describe("SharedJsonParamResolver in the Compute stack", () => {
  let template: Template;

  beforeAll(() => {
    vi.spyOn(Code, "fromAsset").mockImplementation(() => {
      const mockCode = new AssetCode("/mock/path");
      mockCode.bind = () => ({
        s3Location: { bucketName: "mock-bucket", objectKey: "mock-key" },
      });
      mockCode.bindToResource = vi.fn();
      return mockCode;
    });
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
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("declares ForceConfigurationUpdate with default 0", () => {
    template.hasParameter("ForceConfigurationUpdate", {
      Type: "String",
      Default: "0",
      Description:
        "Leave unchanged on normal updates. To force this stack to update the configuration it " +
        "reads from the Account Pool, IDC, and Data stacks, change it to any new value, " +
        "for example after you change the Account Pool managed Regions or the Data stack AWS Access Portal URL.",
    });
  });

  it("labels ForceConfigurationUpdate", () => {
    const parameterLabels =
      template.toJSON().Metadata["AWS::CloudFormation::Interface"]
        .ParameterLabels;
    expect(parameterLabels.ForceConfigurationUpdate).toEqual({
      default: "Force configuration update (optional)",
    });
  });

  it("joins the synth time with ForceConfigurationUpdate in the resolver forceUpdate", () => {
    const resolvers = Object.values(
      template.findResources("Custom::ParseJsonConfiguration"),
    );
    expect(resolvers).toHaveLength(1);
    const properties = resolvers[0]!.Properties;

    const [separator, [synthTime, parameterRef]] =
      properties.forceUpdate["Fn::Join"];
    expect(separator).toBe("-");
    expect(synthTime).toMatch(/^\d+$/);
    expect(parameterRef).toEqual({ Ref: "ForceConfigurationUpdate" });
  });

  it("passes only the parser's known properties to the resolver", () => {
    const [resolver] = Object.values(
      template.findResources("Custom::ParseJsonConfiguration"),
    );
    expect(Object.keys(resolver!.Properties).sort()).toEqual(
      [
        "ServiceToken",
        "accountPoolConfigParamArn",
        "dataConfigParamArn",
        "forceUpdate",
        "idcConfigParamArn",
        "namespace",
      ].sort(),
    );
  });
});
