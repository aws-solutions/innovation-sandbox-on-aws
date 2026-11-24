// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Button,
  Container,
  FormField,
  Header,
  Input,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AccountStatusIndicator } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/AccountStatusIndicator";
import { CleanupOverview } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/CleanupOverview";
import { isCleanupLockActive } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import {
  useCleanupAccount,
  useEjectAccount,
  useGetAccountById,
  useQuarantineAccount,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-frontend/helpers/encoding";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

interface EjectConfirmationProps {
  accountId: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  isLoading: boolean;
}

const EjectConfirmation = ({
  accountId,
  onCancel,
  onConfirm,
  isLoading,
}: EjectConfirmationProps) => {
  const [confirmText, setConfirmText] = useState("");

  return (
    <SpaceBetween size="m">
      <Alert type="warning">
        Are you sure you want to eject account <strong>{accountId}</strong>?
        <br />
        <br />
        This will permanently remove the account from the Innovation Sandbox
        account pool. The account will no longer be managed by this solution.
        <br />
        <br />
        Ejecting the account does not run account cleanup. Any resources that
        remain in the account can continue to incur charges.
        <br />
        <br />
        This action cannot be reversed. To re-add the account, you will need to
        onboard it again.
      </Alert>
      <FormField label={`To confirm, type "eject" below.`}>
        <Input
          value={confirmText}
          onChange={({ detail }) => setConfirmText(detail.value)}
          placeholder="eject"
        />
      </FormField>
      <SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          loading={isLoading}
          disabled={confirmText !== "eject"}
        >
          Eject
        </Button>
      </SpaceBetween>
    </SpaceBetween>
  );
};

export const AccountDetails = () => {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { showModal, hideModal } = useModal();

  const queryClient = useQueryClient();
  const {
    data: account,
    isLoading,
    isError,
    isFetching,
    refetch,
    error,
  } = useGetAccountById(accountId);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
  };

  // Encoded composite key for the account's current lease, used both to fetch
  // the full lease (for its template name) and to link to the lease details.
  const currentLeaseId = account?.currentLease
    ? base64EncodeCompositeKey({
        userEmail: account.currentLease.ownerEmail,
        uuid: account.currentLease.leaseId,
      })
    : undefined;
  const { data: currentLease } = useGetLeaseById(currentLeaseId);

  const { mutateAsync: quarantineAccount, isPending: isQuarantining } =
    useQuarantineAccount();
  const { mutateAsync: cleanupAccount, isPending: isCleaning } =
    useCleanupAccount();
  const { mutateAsync: ejectAccount, isPending: isEjecting } =
    useEjectAccount();

  useEffect(() => {
    const breadcrumbItems = [
      { text: "Home", href: "/" },
      { text: "Accounts", href: "/accounts" },
    ];

    if (isLoading) {
      breadcrumbItems.push({ text: "Loading...", href: "#" });
    } else if (account) {
      breadcrumbItems.push({
        text: account.awsAccountId,
        href: `/accounts/${account.awsAccountId}`,
      });
    }

    setBreadcrumb(breadcrumbItems);
    setTools(<Markdown file="account-details" />);
  }, [isLoading, account, setBreadcrumb, setTools]);

  const handleQuarantine = () => {
    if (!account) return;
    showModal({
      header: "Quarantine account",
      content: (
        <SpaceBetween size="m">
          <Alert type="warning">
            Are you sure you want to quarantine this account?
            <br />
            <br />
            This will immediately:
            <ul>
              <li>Terminate any active leases and revoke leaseholder access</li>
              <li>Move the account to the Quarantine OU</li>
              <li>Remove the account from the available account pool</li>
            </ul>
            To return the account to the pool, use &quot;Start cleanup&quot; or
            eject and re-onboard the account.
          </Alert>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={hideModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await quarantineAccount(account.awsAccountId);
                  showSuccessToast("Account quarantined successfully.");
                  hideModal();
                } catch {
                  showErrorToast(
                    "Failed to quarantine account.",
                    "Quarantine failed",
                  );
                }
              }}
              loading={isQuarantining}
            >
              Quarantine
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      ),
    });
  };

  const handleRetryCleanup = () => {
    if (!account) return;
    showModal({
      header: "Start cleanup",
      content: (
        <SpaceBetween size="m">
          <Alert type="info">
            This will start a new cleanup process for the account. The account
            will be cleaned using AWS Nuke and validated before being returned
            to the available pool.
          </Alert>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={hideModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await cleanupAccount(account.awsAccountId);
                  showSuccessToast("Cleanup initiated successfully.");
                  hideModal();
                } catch {
                  showErrorToast(
                    "Failed to initiate cleanup.",
                    "Cleanup failed",
                  );
                }
              }}
              loading={isCleaning}
            >
              Start cleanup
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      ),
    });
  };

  const handleEject = () => {
    if (!account) return;
    showModal({
      header: "Eject account",
      content: (
        <EjectConfirmation
          accountId={account.awsAccountId}
          onCancel={hideModal}
          onConfirm={async () => {
            try {
              await ejectAccount(account.awsAccountId);
              showSuccessToast("Account ejected successfully.");
              hideModal();
              navigate("/accounts");
            } catch {
              showErrorToast("Failed to eject account.", "Eject failed");
            }
          }}
          isLoading={isEjecting}
        />
      ),
    });
  };

  if (isLoading) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError || !account) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this account."
          retry={refetch}
          error={error as Error}
        />
      </ContentLayout>
    );
  }

  const canQuarantine =
    account.status === "Available" ||
    account.status === "Active" ||
    account.status === "Frozen";

  // Status makes the account eligible for a cleanup (re)try, but a live
  // (non-expired) cleanup lock means an execution is already running —
  // starting another would race it, so the lock gates the action. An expired
  // lock (stuck execution) deliberately does not block the retry.
  const cleanupLockActive = isCleanupLockActive(account);
  const canRetryCleanup =
    (account.status === "Quarantine" || account.status === "CleanUp") &&
    !cleanupLockActive;

  const canEject = account.status !== "CleanUp";

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="refresh"
                ariaLabel="Refresh account"
                disabled={isFetching}
                onClick={handleRefresh}
              />
              <Button onClick={handleEject} disabled={!canEject}>
                Eject account
              </Button>
              <Button
                onClick={handleRetryCleanup}
                disabled={!canRetryCleanup}
                // Explain the lock-gated case; the status-gated case is
                // self-evident from the page's status field.
                disabledReason={
                  cleanupLockActive
                    ? "A cleanup is already running for this account. Wait for it to finish before retrying."
                    : undefined
                }
              >
                Start cleanup
              </Button>
              <Button onClick={handleQuarantine} disabled={!canQuarantine}>
                Quarantine account
              </Button>
            </SpaceBetween>
          }
        >
          {account.awsAccountId}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <AccountLoginLink
                  accountId={account.awsAccountId}
                  variant="normal"
                />
              }
            >
              Account details
            </Header>
          }
        >
          <KeyValuePairs
            columns={3}
            items={[
              { label: "Account ID", value: account.awsAccountId },
              {
                label: "Status",
                value: (
                  <AccountStatusIndicator
                    status={account.status}
                    activeCleanup={account.activeCleanup}
                  />
                ),
              },
              { label: "Name", value: account.name ?? "-" },
              { label: "Email", value: account.email ?? "-" },
              {
                label: "Current lease",
                value: account.currentLease ? (
                  <LeaseName
                    uuid={account.currentLease.leaseId}
                    templateName={
                      currentLease?.originalLeaseTemplateName ??
                      account.currentLease.ownerEmail
                    }
                    leaseId={currentLeaseId}
                  />
                ) : (
                  "Not leased"
                ),
              },
              {
                label: "Added",
                value: account.meta?.createdTime
                  ? DateTime.fromISO(account.meta.createdTime).toLocaleString(
                      DateTime.DATETIME_SHORT,
                    )
                  : "-",
              },
              {
                label: "Last modified",
                value: account.meta?.lastEditTime
                  ? DateTime.fromISO(account.meta.lastEditTime).toLocaleString(
                      DateTime.DATETIME_SHORT,
                    )
                  : "-",
              },
            ]}
          />
        </Container>

        <CleanupOverview accountId={account.awsAccountId} />
      </SpaceBetween>
    </ContentLayout>
  );
};
