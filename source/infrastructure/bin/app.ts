#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as cdk from "aws-cdk-lib";

import { getSolutionContext } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { IsbAccountPoolStack } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-stack";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { IsbDataStack } from "@amzn/innovation-sandbox-infrastructure/isb-data-stack";
import { IsbIdcStack } from "@amzn/innovation-sandbox-infrastructure/isb-idc-stack";
import { SolutionsEngineeringSynthesizer } from "@amzn/innovation-sandbox-infrastructure/stack-synthesizers/solutions-engineering-synthesizer";

const app = new cdk.App();

const context = getSolutionContext(app.node);

const synthesizer = new SolutionsEngineeringSynthesizer({
  generateBootstrapVersionRule: false,
  fileAssetsBucketName:
    context.distOutputBucket && `${context.distOutputBucket}-\${AWS::Region}`,
  bucketPrefix: context.bucketPrefix,
  outdir: app.outdir,
});

new IsbAccountPoolStack(app, "ISBAccountPool", {
  description: `(${context.solutionId}) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
});

new IsbIdcStack(app, "ISBIdc", {
  description: `(${context.solutionId}-IdcStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
});

new IsbDataStack(app, "ISBData", {
  description: `(${context.solutionId}-DataStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
});

new IsbComputeStack(app, "ISBCompute", {
  description: `(${context.solutionId}-ComputeStack) ${context.solutionName} ${context.version}`,
  synthesizer: synthesizer,
});
