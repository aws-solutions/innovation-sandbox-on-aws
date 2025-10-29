// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LogLevelSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment";
import { readManifest } from "@amzn/innovation-sandbox-infrastructure/helpers/manifest-reader";
import { CfnMapping, Stack } from "aws-cdk-lib";
import { Construct, Node } from "constructs";
import z from "zod";

const solutionManifest = readManifest();

// these are the allowed values - https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html#cfn-logs-loggroup-retentionindays
const CloudWatchLogRetentionInDaysSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.literal(60),
  z.literal(90),
  z.literal(120),
  z.literal(150),
  z.literal(180),
  z.literal(365),
  z.literal(400),
  z.literal(545),
  z.literal(731),
  z.literal(1096),
  z.literal(1827),
  z.literal(2192),
  z.literal(2557),
  z.literal(2922),
  z.literal(3288),
  z.literal(3653),
]);

export const SolutionContextSchema = z
  .object({
    solutionName: z.string().default(solutionManifest.name),
    solutionId: z.string().default(solutionManifest.id),
    version: z.string().default(solutionManifest.version),
    distOutputBucket: z.string().optional(),
    publicEcrRegistry: z.string().default("public.ecr.aws/aws-solutions"),
    publicEcrTag: z.string().default(solutionManifest.version),
    privateEcrRepo: z.string().optional(),
    nukeConfigFilePath: z.string().optional(),
    logLevel: LogLevelSchema.default("INFO"),
    deploymentMode: z.string().default("prod"),
    cloudWatchLogRetentionInDays:
      CloudWatchLogRetentionInDaysSchema.default(90),
    s3LogsArchiveRetentionInDays: z.coerce.number().default(365),
    s3LogsGlacierRetentionInDays: z.coerce.number().default(7 * 365),
    apiThrottlingRateLimit: z.coerce.number().default(100),
    apiThrottlingBurstLimit: z.coerce.number().default(200),
  })
  .transform((context) => {
    const { solutionName, version, distOutputBucket } = context;

    return {
      ...context,
      bucketPrefix: distOutputBucket
        ? `${solutionName}/${version}/asset.`
        : undefined,
    };
  });

export type SolutionContext = z.infer<typeof SolutionContextSchema>;

export function getSolutionContext(node: Node) {
  const solutionContext: SolutionContext = node.getAllContext();
  return SolutionContextSchema.parse(solutionContext);
}

export class IsbMapping {
  private static instances: { [key: string]: CfnMapping } = {};
  public static getCfnMapping(scope: Construct): CfnMapping {
    const stack = Stack.of(scope);
    const stackName = stack.stackName;
    if (!IsbMapping.instances[stackName]) {
      IsbMapping.instances[stackName] = new CfnMapping(stack, "Mapping", {
        mapping: {
          context: getSolutionContext(stack.node),
        },
      });
    }
    return IsbMapping.instances[stackName];
  }
}

export function getContextFromMapping<T extends keyof SolutionContext>(
  scope: Construct,
  key: T,
): string {
  return IsbMapping.getCfnMapping(scope).findInMap("context", key, "");
}
