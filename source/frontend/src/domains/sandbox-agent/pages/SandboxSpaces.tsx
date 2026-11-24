// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, Header } from "@cloudscape-design/components";
import { useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { getLeaseDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import type { SelectableModelView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  canOpenSandboxSpace,
  isSandboxSpacesGloballyUsable,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import {
  useAgentHistory,
  useAgentWebSocket,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/hooks";
import { SandboxAgent } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/pages/SandboxAgent";
import { useSandboxSpacesUsage } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { useModelSelection } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/useModelSelection";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-frontend/helpers/encoding";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  getCurrentLeaseSpend,
  isActiveLease,
  LeaseKeySchema,
  type MonitoredLease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

const DEFAULT_MODEL_UNAVAILABLE_NOTICE =
  "The default model for this Sandbox Space is no longer available. Choose any model from the list.";

// Five events yield several messages; short transcripts load more automatically.
const AGENT_HISTORY_PAGE_SIZE = 5;

const highestKnownSpend = (
  first: number | undefined,
  second: number | undefined,
): number | undefined =>
  first === undefined || second === undefined
    ? (first ?? second)
    : Math.max(first, second);

export const SandboxSpaces = () => {
  const { leaseId } = useParams();
  const routeLeaseId = leaseId ?? "";
  const routeLeaseKey = LeaseKeySchema.safeParse(
    base64DecodeCompositeKey(routeLeaseId),
  );
  const isRouteLeaseKeyValid = routeLeaseKey.success;
  const leaseUuid = isRouteLeaseKeyValid ? routeLeaseKey.data.uuid : "";
  const setBreadcrumb = useBreadcrumb();
  const { user, isLoading: isLoadingUser } = useUser();
  const leaseQuery = useGetLeaseById(
    isRouteLeaseKeyValid ? routeLeaseId : undefined,
  );
  const configQuery = useGetConfigurations();
  const config = configQuery.data;

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease details", href: `/leases/${routeLeaseId}` },
      { text: "Sandbox Space", href: "#" },
    ]);
  }, [routeLeaseId, setBreadcrumb]);

  if (!isRouteLeaseKeyValid) {
    return <UnavailableSandboxSpace />;
  }

  // Do not decide availability until every query the decision depends on has
  // settled. While the config is still loading, `config` is undefined, which
  // would make the deployment-wide gate read as unusable and wrongly show the
  // owner the unavailable state. Show the loader until it resolves.
  if (isLoadingUser || leaseQuery.isLoading || configQuery.isLoading) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (leaseQuery.isError || !leaseQuery.data) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this Sandbox Space."
          error={leaseQuery.error as Error}
          retry={leaseQuery.refetch}
        />
      </ContentLayout>
    );
  }

  // Config gates availability, so a failure to load it is a load error, NOT a
  // lease-eligibility outcome. Surface a retryable error state distinct from
  // the owner/active unavailable message so an eligible owner is not
  // misinformed that the Space is not theirs.
  if (configQuery.isError || !config) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading Sandbox Space configuration."
          error={configQuery.error as Error}
          retry={configQuery.refetch}
        />
      </ContentLayout>
    );
  }

  // Both gates settled — an unavailable result is a real eligibility decision.
  if (
    !canOpenSandboxSpace(leaseQuery.data, user) ||
    !isSandboxSpacesGloballyUsable(config.agent.sandboxSpacesEnabled)
  ) {
    return <UnavailableSandboxSpace />;
  }

  // canOpenSandboxSpace already required an active lease; this guard
  // narrows the union to MonitoredLease so awsAccountId is typed present.
  if (!isActiveLease(leaseQuery.data)) {
    return <UnavailableSandboxSpace />;
  }

  if (!user) {
    return <UnavailableSandboxSpace />;
  }

  // Checked before mounting the chat so its history fetch and socket never run.
  if (leaseQuery.data.selectableModels.length === 0) {
    return <NoAvailableModelSandboxSpace />;
  }

  // Route changes start a new chat session; the socket keeps its initial lease
  // ID through reconnects, so keying this child prevents cross-lease transport.
  return (
    <EligibleSandboxSpace
      key={leaseUuid}
      leaseId={routeLeaseId}
      leaseUuid={leaseUuid}
      userId={user.userId}
      lease={leaseQuery.data}
      selectableModels={leaseQuery.data.selectableModels}
    />
  );
};

const UnavailableSandboxSpace = () => (
  <ContentLayout header={<Header variant="h1">Sandbox Space</Header>}>
    <Alert header="Sandbox Space unavailable" type="warning">
      This Sandbox Space is available only to the active lease user.
    </Alert>
  </ContentLayout>
);

// The active lease user is correctly authenticated, but this lease's allowed
// model subset has no intersection with the enabled catalog, so no model can be
// resolved for a turn. This is a model-availability outcome, not the
// owner/active-lease eligibility outcome, so it carries its own message rather
// than reusing UnavailableSandboxSpace.
const NoAvailableModelSandboxSpace = () => (
  <ContentLayout header={<Header variant="h1">Sandbox Space</Header>}>
    <Alert header="Sandbox Space unavailable" type="warning">
      No enabled model is available for this Sandbox Space. Contact an
      administrator.
    </Alert>
  </ContentLayout>
);

const EligibleSandboxSpace = ({
  leaseId,
  leaseUuid,
  userId,
  lease,
  selectableModels,
}: {
  leaseId: string;
  leaseUuid: string;
  userId: string;
  lease: MonitoredLease;
  selectableModels: SelectableModelView[];
}) => {
  const history = useAgentHistory({
    leaseId,
    userId,
    pageSize: AGENT_HISTORY_PAGE_SIZE,
  });
  const webSocket = useAgentWebSocket({ leaseId, leaseUuid, userId });
  const usage = useSandboxSpacesUsage(leaseId, userId);
  // Only an explicit caller row can establish a spend value; omitted records
  // may be unreadable and must remain unavailable rather than becoming zero.
  const initialCallerSpend = usage.isSuccess
    ? usage.data.spendByUsers.find((row) => row.userId === userId)
        ?.sandboxSpacesEstimatedTokenCostAccrued
    : undefined;
  const webSocketCallerSpend =
    webSocket.callerSandboxSpacesEstimatedTokenCostAccrued;
  // Terminal snapshots can miss concurrent turns; keep the highest known total.
  const callerEstimatedAgentSpend = highestKnownSpend(
    initialCallerSpend,
    webSocketCallerSpend,
  );
  // Lease totals are monotonic while this page is open; keep the highest query
  // or terminal-frame snapshot.
  const leaseCurrentSpend = highestKnownSpend(
    getCurrentLeaseSpend(lease),
    webSocket.leaseCurrentSpend,
  );
  // Not re-filtered here: the server owns enabled ∩ allowed, so the picker
  // cannot drift from what the Worker accepts on a turn.
  const allowedModels = selectableModels;
  const allowedModelIds = allowedModels.map((model) => model.modelId);
  // Preselect the lease's denormalized template default when it is in the
  // allowed subset; the hook falls back to the first selectable model when the
  // default is unset, disabled, or not in this lease's allowed subset.
  const { selectedModelId, setSelectedModelId } = useModelSelection(
    allowedModelIds,
    lease.defaultModelId,
  );
  const isDefaultUnavailable =
    lease.defaultModelId !== undefined &&
    !allowedModelIds.includes(lease.defaultModelId);

  // Each turn must carry a modelId (required by the wire contract).
  const sendMessage = (message: string) => {
    if (!selectedModelId) {
      return;
    }
    webSocket.sendMessage(message, selectedModelId);
  };

  const { isFetchingNextPage, loadEarlierMessages } = history;
  const handleLoadEarlierMessages = useCallback(() => {
    void loadEarlierMessages({ cancelRefetch: false });
  }, [loadEarlierMessages]);

  if (history.isLoading) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  // isError also covers a failed earlier page, which keeps the loaded messages
  // and is reported inline by the chat panel.
  if (history.isLoadingError) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this Sandbox Space history."
          error={history.error}
          retry={history.refetch}
        />
      </ContentLayout>
    );
  }

  return (
    <SandboxAgent
      messages={[...history.messages, ...webSocket.messages]}
      onSendMessage={sendMessage}
      isResponding={webSocket.isResponding}
      connectionStatus={webSocket.connectionStatus}
      onReconnect={webSocket.reconnect}
      onRetry={() => webSocket.retryLastMessage()}
      leaseName={getLeaseDisplayName(lease)}
      awsAccountId={lease.awsAccountId}
      callerEstimatedAgentSpend={callerEstimatedAgentSpend}
      leaseCurrentSpend={leaseCurrentSpend}
      isAgentSpendLoading={
        usage.isPending && webSocketCallerSpend === undefined
      }
      maxSpend={lease.maxSpend}
      budgetThresholds={lease.budgetThresholds}
      models={allowedModels.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        provider: model.provider,
      }))}
      selectedModelId={selectedModelId}
      onSelectModel={setSelectedModelId}
      notice={
        isDefaultUnavailable ? (
          <Alert type="info">{DEFAULT_MODEL_UNAVAILABLE_NOTICE}</Alert>
        ) : undefined
      }
      hasEarlierMessages={history.hasNextPage}
      isLoadingEarlierMessages={isFetchingNextPage}
      isLoadEarlierMessagesError={history.isFetchNextPageError}
      isHistoryFetching={history.isFetching}
      onLoadEarlierMessages={handleLoadEarlierMessages}
    />
  );
};
