// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
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
    privateAccountCleanerEcrRepo: z.string().optional(),
    privateSandboxAgentRuntimeEcrRepo: z.string().optional(),
    nukeConfigFilePath: z.string().optional(),
    scpDirectoryPath: z.string().optional(),
    deploymentMode: z.string().default("prod"),
    stackPrefix: z.string().default("InnovationSandbox"),
    cloudWatchLogRetentionInDays:
      CloudWatchLogRetentionInDaysSchema.default(90),
    s3LogsArchiveRetentionInDays: z.coerce.number().default(365),
    s3LogsGlacierRetentionInDays: z.coerce.number().default(7 * 365),
    apiThrottlingRateLimit: z.coerce.number().default(100),
    apiThrottlingBurstLimit: z.coerce.number().default(200),
    // Cognito token validity — https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_TokenValidityUnitsType.html
    cognitoAccessTokenValidityMinutes: z.coerce
      .number()
      .min(5)
      .max(1440)
      .default(60),
    // Floor at 60 — Identity Pool's enhanced auth flow vends 1-hour AWS
    // credentials regardless of role MaxSessionDuration
    // (https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flow.html).
    // A shorter ID token creates a window where the IAM credentials are
    // still valid but the x-isb-identity header has expired, 401-ing every
    // API call until Amplify's next fetchAuthSession() near credential expiry.
    cognitoIdTokenValidityMinutes: z.coerce
      .number()
      .min(60)
      .max(1440)
      .default(60),
    cognitoRefreshTokenValidityDays: z.coerce
      .number()
      .min(1)
      .max(3650)
      .default(7),
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
  private static readonly instances: { [key: string]: CfnMapping } = {};
  public static getCfnMapping(scope: Construct): CfnMapping {
    const stack = Stack.of(scope);
    const stackName = stack.stackName;
    IsbMapping.instances[stackName] ??= new CfnMapping(stack, "Mapping", {
      mapping: {
        context: getSolutionContext(stack.node),
      },
    });
    return IsbMapping.instances[stackName];
  }
}

export function getContextFromMapping<T extends keyof SolutionContext>(
  scope: Construct,
  key: T,
): string {
  return IsbMapping.getCfnMapping(scope).findInMap("context", key, "");
}
