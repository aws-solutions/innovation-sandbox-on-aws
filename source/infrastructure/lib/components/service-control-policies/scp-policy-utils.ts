// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface ScpStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string[];
  NotAction?: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, any>>;
}

export interface ScpPolicy {
  Version: "2012-10-17";
  Statement: ScpStatement[];
}

export const PRINCIPAL_EXCEPTIONS_PLACEHOLDER =
  "${additionalPrincipalExceptions}";

/**
 * Loads an SCP JSON file from disk and performs placeholder substitution
 * for namespace and region list values.
 */
export function loadPolicyFromFile(
  fileName: string,
  namespace?: string,
  regionList?: string[],
  overrideDirectory?: string,
): ScpPolicy {
  try {
    const policyPath = path.join(overrideDirectory ?? __dirname, fileName);

    // Read the JSON file
    let processedContent = fs.readFileSync(policyPath, "utf8");

    // Replace namespace if provided
    if (namespace) {
      processedContent = processedContent.replaceAll("${namespace}", namespace);
    }

    // Replace region list if provided
    if (regionList) {
      processedContent = processedContent.replaceAll(
        "${isbManagedRegions}",
        regionList.toString(),
      );
    }

    // Parse and return the content
    return JSON.parse(processedContent) as ScpPolicy;
  } catch (error) {
    throw new Error(
      `Failed to load SCP policy from ${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Finds statements containing the ${additionalPrincipalExceptions} placeholder in their
 * aws:PrincipalARN array and replaces it with a Fn::If that conditionally appends
 * additional principals at deploy time.
 *
 * No-op if additionalPrincipalExceptions or conditionId are not provided.
 *
 * Note: '|' is used as the internal delimiter for Fn::Join/Fn::Split to build the array.
 * AllowedPattern guarantees no '|' in ARN values (only alphanumeric, _+=,.@/- and trailing *).
 */
export function injectPrincipalExceptions(
  policy: ScpPolicy,
  additionalPrincipalExceptions?: string[],
  hasAdditionalPrincipalExceptionsConditionId?: string,
): void {
  for (const statement of policy.Statement) {
    if (!statement.Condition?.ArnNotLike) continue;

    const principalArns = statement.Condition.ArnNotLike["aws:PrincipalARN"] as
      string[] | undefined;
    if (!principalArns || !Array.isArray(principalArns)) continue;

    // Check if this statement has the placeholder marker
    if (!principalArns.includes(PRINCIPAL_EXCEPTIONS_PLACEHOLDER)) continue;

    const basePrincipals = principalArns.filter(
      (arn) => arn !== PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
    );

    // If no exceptions provided, just strip the placeholder
    if (
      !additionalPrincipalExceptions ||
      !hasAdditionalPrincipalExceptionsConditionId
    ) {
      statement.Condition.ArnNotLike["aws:PrincipalARN"] = basePrincipals;
      continue;
    }

    // Replace with Fn::If intrinsic.
    // Note: '|' is used as the internal delimiter for Fn::Join/Fn::Split to build the array.
    // AllowedPattern guarantees no '|' in ARN values (only alphanumeric, _+=,.@/- and trailing *).
    statement.Condition.ArnNotLike["aws:PrincipalARN"] = {
      "Fn::If": [
        hasAdditionalPrincipalExceptionsConditionId,
        {
          "Fn::Split": [
            "|",
            {
              "Fn::Join": [
                "|",
                [
                  ...basePrincipals,
                  {
                    "Fn::Join": ["|", additionalPrincipalExceptions],
                  },
                ],
              ],
            },
          ],
        },
        basePrincipals,
      ],
    };
  }
}

/**
 * Conditionally adds `bedrock:InferenceProfileArn` to the DenyRegionAccess statement's
 * ArnNotLike condition using Fn::If.
 *
 * When parameter is empty: key is absent (Organizations rejects empty arrays as values).
 * When parameter is non-empty: key is present with the provided patterns.
 *
 * No-op if bedrockInferenceProfilePatterns or conditionId are not provided.
 */
export function injectBedrockInferenceProfilePatterns(
  policy: ScpPolicy,
  bedrockInferenceProfilePatterns?: string[],
  hasBedrockConditionId?: string,
): void {
  if (!bedrockInferenceProfilePatterns || !hasBedrockConditionId) return;

  const statement = policy.Statement.find((s) => s.Sid === "DenyRegionAccess");
  if (!statement?.Condition?.ArnNotLike) return;

  const baseKeys = { ...statement.Condition.ArnNotLike };

  const withBedrockKey = {
    ...baseKeys,
    "bedrock:InferenceProfileArn": bedrockInferenceProfilePatterns,
  };

  statement.Condition.ArnNotLike = {
    "Fn::If": [hasBedrockConditionId, withBedrockKey, baseKeys],
  } as any;
}

/**
 * Builds the condition block for the Allowed Services SCP as raw JSON fragments
 * with CloudFormation Fn::If for conditional principal exception injection.
 *
 * This mirrors the ArnNotLike structure that injectPrincipalExceptions() produces
 * for the other SCPs via Fn::If/Fn::Split, but as raw JSON string concatenation
 * (required because the entire Nuke SCP is built as a Fn::Join string).
 */
export function buildNukeScpConditionBlock(
  policy: ScpPolicy,
  additionalPrincipalExceptions: string[],
  hasAdditionalPrincipalExceptionsConditionId: string,
): {
  conditionBlockStart: string;
  basePrincipalArnsJson: string;
  principalExceptionsFnIf: Record<string, unknown>;
  conditionBlockEnd: string;
} {
  const statement = policy.Statement[0];
  if (!statement) {
    throw new Error("Invalid Allowed Services SCP: no statements found");
  }

  const arnNotLike = statement.Condition?.ArnNotLike;
  if (!arnNotLike) {
    throw new Error(
      "Invalid Allowed Services SCP: missing ArnNotLike condition in first statement",
    );
  }

  const basePrincipalArns = (arnNotLike["aws:PrincipalARN"] as string[]).filter(
    (arn) => arn !== PRINCIPAL_EXCEPTIONS_PLACEHOLDER,
  );
  const basePrincipalArnsJson = basePrincipalArns
    .map((arn) => JSON.stringify(arn))
    .join(",");

  // Raw JSON fragments for the condition block.
  const conditionBlockStart = `{"ArnNotLike":{"aws:PrincipalARN":[`;
  const conditionBlockEnd = `]}}`;

  const principalExceptionsFnIf = {
    "Fn::If": [
      hasAdditionalPrincipalExceptionsConditionId,
      {
        "Fn::Join": [
          "",
          [',"', { "Fn::Join": ['","', additionalPrincipalExceptions] }, '"'],
        ],
      },
      "",
    ],
  };

  return {
    conditionBlockStart,
    basePrincipalArnsJson,
    principalExceptionsFnIf,
    conditionBlockEnd,
  };
}
