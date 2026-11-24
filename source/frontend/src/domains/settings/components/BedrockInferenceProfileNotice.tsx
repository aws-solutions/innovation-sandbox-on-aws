// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, Box, Link, SpaceBetween } from "@cloudscape-design/components";

const ACCOUNT_POOL_DEPLOY_GUIDE_URL =
  "https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/step1-deploy-accountpool-stack.html";

export const BedrockInferenceProfileNotice = ({
  bedrockInferenceProfilePatterns,
}: Readonly<{
  bedrockInferenceProfilePatterns: string[];
}>) => {
  const isSet = bedrockInferenceProfilePatterns.length > 0;

  return (
    <Alert
      type={isSet ? "info" : "warning"}
      header={
        isSet
          ? "Bedrock inference profile patterns"
          : "Bedrock inference profile patterns not set"
      }
    >
      <SpaceBetween size="xs">
        {isSet ? (
          [
            <Box key="intro" variant="p">
              Sandbox Spaces uses the{" "}
              <Box variant="code">BedrockInferenceProfilePatterns</Box>{" "}
              parameter on the Account Pool stack for cross-Region inference.
              Make sure the patterns cover the models you enable. This exemption
              applies to every principal in sandbox accounts, not only Sandbox
              Spaces.
            </Box>,
            <SpaceBetween key="current-value" direction="horizontal" size="xs">
              <Box variant="p">Current value:</Box>
              <Box variant="code">
                {bedrockInferenceProfilePatterns.join(", ")}
              </Box>
            </SpaceBetween>,
          ]
        ) : (
          <Box variant="p">
            Sandbox Spaces models can't run until the{" "}
            <Box variant="code">BedrockInferenceProfilePatterns</Box> parameter
            on the Account Pool stack is set. The default value,{" "}
            <Box variant="code">arn:aws:bedrock:*:*:inference-profile/*</Box>,
            allows all inference profiles. This exemption applies to every
            principal in sandbox accounts, not only Sandbox Spaces.
          </Box>
        )}
        <Link external href={ACCOUNT_POOL_DEPLOY_GUIDE_URL}>
          Learn more about deploying the Account Pool stack
        </Link>
      </SpaceBetween>
    </Alert>
  );
};
