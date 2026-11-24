// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import SupportPromptGroup from "@cloudscape-design/chat-components/support-prompt-group";
import { Box, SpaceBetween } from "@cloudscape-design/components";

export type WelcomeStateProps = {
  heading: string;
  description: string;
  examplePrompts: string[];
  onPromptSelect: (prompt: string) => void;
};

export const WelcomeState = ({
  heading,
  description,
  examplePrompts,
  onPromptSelect,
}: WelcomeStateProps) => {
  return (
    <Box padding="l" textAlign="center">
      <SpaceBetween size="m">
        <SpaceBetween size="xxs">
          <Box variant="h3">{heading}</Box>
          <Box color="text-body-secondary">{description}</Box>
        </SpaceBetween>
        {examplePrompts.length > 0 && (
          <SupportPromptGroup
            ariaLabel="Suggested prompts"
            onItemClick={({ detail }) => onPromptSelect(detail.id)}
            items={examplePrompts.map((prompt) => ({
              id: prompt,
              text: prompt,
            }))}
          />
        )}
      </SpaceBetween>
    </Box>
  );
};
