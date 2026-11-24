// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Header, SpaceBetween } from "@cloudscape-design/components";
import type { ReactNode } from "react";

import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { ChatPanel } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/ChatPanel";
import { LeaseBudgetTracker } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/LeaseBudgetTracker";
import {
  type ModelOption,
  ModelSelector,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/ModelSelector";
import type {
  AgentConnectionStatus,
  ChatRenderableMessage,
  ErrorDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import type { BudgetThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const ASSISTANT_NAME = "Sandbox agent";

const WELCOME = {
  heading: "Welcome to your Sandbox Space",
  description:
    "Describe what you want to build and the agent works inside your leased account.",
  examplePrompts: [
    "Create an S3 bucket for my dataset",
    "List the EC2 instances in this account",
    "Set up a DynamoDB table for a todo app",
  ],
};

export type SandboxAgentProps = {
  messages?: ChatRenderableMessage[];
  onSendMessage?: (message: string) => void;
  isResponding?: boolean;
  connectionStatus?: AgentConnectionStatus;
  onReconnect?: () => void;
  onRetry?: (message: ErrorDisplayMessage) => void;
  /** Lease display name (`<template> (<short id>)`); omit for the standalone shell. */
  leaseName?: string;
  /** The sandbox account the agent operates within. */
  awsAccountId?: string;
  /** Current caller's estimated agent spend in USD. */
  callerEstimatedAgentSpend?: number;
  /** The lease's current spend from `getCurrentLeaseSpend`. */
  leaseCurrentSpend?: number;
  /** True while the initial agent spend is loading. */
  isAgentSpendLoading?: boolean;
  /** Maximum lease spend in USD; absent when the lease has no maximum. */
  maxSpend?: number;
  /** Lease dollar thresholds used to color current-spend progress. */
  budgetThresholds?: BudgetThreshold[];
  models?: ModelOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  notice?: ReactNode;
  hasEarlierMessages?: boolean;
  isLoadingEarlierMessages?: boolean;
  isLoadEarlierMessagesError?: boolean;
  isHistoryFetching?: boolean;
  onLoadEarlierMessages?: () => void;
};

export const SandboxAgent = ({
  messages = [],
  onSendMessage = () => {},
  isResponding = false,
  connectionStatus = "connected",
  onReconnect,
  onRetry,
  leaseName,
  awsAccountId,
  callerEstimatedAgentSpend,
  leaseCurrentSpend,
  isAgentSpendLoading = false,
  maxSpend,
  budgetThresholds,
  models = [],
  selectedModelId,
  onSelectModel = () => {},
  notice,
  hasEarlierMessages,
  isLoadingEarlierMessages,
  isLoadEarlierMessagesError,
  isHistoryFetching,
  onLoadEarlierMessages,
}: SandboxAgentProps) => {
  const showModelSelector = models.length > 0;
  const pageHeader = (
    <Header
      variant="h1"
      description={
        awsAccountId ? (
          <>
            {`AWS account ${awsAccountId}`}{" "}
            <AccountLoginLink accountId={awsAccountId} />
          </>
        ) : undefined
      }
    >
      {leaseName ?? "Sandbox Space"}
    </Header>
  );

  return (
    <ChatPanel
      messages={messages}
      onSendMessage={onSendMessage}
      assistantName={ASSISTANT_NAME}
      isResponding={isResponding}
      connectionStatus={connectionStatus}
      onReconnect={onReconnect}
      onRetry={onRetry}
      welcome={WELCOME}
      hasEarlierMessages={hasEarlierMessages}
      isLoadingEarlierMessages={isLoadingEarlierMessages}
      isLoadEarlierMessagesError={isLoadEarlierMessagesError}
      isHistoryFetching={isHistoryFetching}
      onLoadEarlierMessages={onLoadEarlierMessages}
      // Keep the header outside ContentLayout so ChatPanel owns the full-height
      // scrolling region and pinned composer.
      header={
        notice ? (
          <SpaceBetween size="s">
            {pageHeader}
            {notice}
          </SpaceBetween>
        ) : (
          pageHeader
        )
      }
      composerControls={
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <LeaseBudgetTracker
            leaseCurrentSpend={leaseCurrentSpend}
            maxSpend={maxSpend}
            budgetThresholds={budgetThresholds}
            callerEstimatedAgentSpend={callerEstimatedAgentSpend}
            isAgentSpendLoading={isAgentSpendLoading}
          />
          {showModelSelector && (
            <ModelSelector
              models={models}
              selectedModelId={selectedModelId}
              onSelectModel={onSelectModel}
              // A turn is priced at the model it was sent with, so the choice
              // is locked while a turn is in flight.
              disabled={isResponding}
            />
          )}
        </SpaceBetween>
      }
    />
  );
};
