// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Alert,
  Button,
  ButtonDropdown,
  Container,
  Header,
  Popover,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { AccountsSummary } from "@amzn/innovation-sandbox-frontend/components/AccountsSummary";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AccountStatusIndicator } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/AccountStatusIndicator";
import {
  accountStatusSortingComparator,
  isCleanupLockActive,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import {
  useCleanupAccount,
  useEjectAccount,
  useGetAccounts,
  useQuarantineAccount,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { SandboxAccountView } from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { SandboxAccountStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account";

// prettier-ignore
const StatusCell = ({ account }: { account: SandboxAccountView }) => (
  <AccountStatusIndicator
    status={account.status}
    activeCleanup={account.activeCleanup}
    lastCleanupStartTime={ // NOSONAR typescript:S1874: Pass the legacy timestamp for accounts without activeCleanup.
      account.cleanupExecutionContext?.stateMachineExecutionStartTime
    }
  />
);

const CreatedOnCell = ({ account }: { account: SandboxAccountView }) =>
  account.meta?.createdTime && (
    <Popover
      position="top"
      dismissButton={false}
      content={DateTime.fromISO(account.meta?.createdTime).toFormat(
        "MM/dd/yyyy hh:mm:a",
      )}
    >
      {DateTime.fromISO(account.meta?.createdTime).toRelative()}
    </Popover>
  );

const LastModifiedCell = ({ account }: { account: SandboxAccountView }) =>
  account.meta?.lastEditTime && (
    <Popover
      position="top"
      dismissButton={false}
      content={DateTime.fromISO(account.meta?.lastEditTime).toFormat(
        "MM/dd/yyyy hh:mm:a",
      )}
    >
      {DateTime.fromISO(account.meta?.lastEditTime).toRelative()}
    </Popover>
  );

const AccessCell = ({ account }: { account: SandboxAccountView }) => (
  <AccountLoginLink accountId={account.awsAccountId} wrapText={false} />
);

const createColumnDefinitions = (includeLinks: boolean) =>
  [
    {
      id: "awsAccountId",
      header: "Account ID",
      sortingField: "awsAccountId",
      cell: (account: SandboxAccountView) => (
        <TextLink to={`/accounts/${account.awsAccountId}`}>
          {account.awsAccountId}
        </TextLink>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortingComparator: accountStatusSortingComparator,
      cell: (account: SandboxAccountView) => <StatusCell account={account} />,
    },
    {
      id: "createdOn",
      header: "Added",
      sortingComparator: createDateSortingComparator<SandboxAccountView>(
        (a) => a.meta?.createdTime,
      ),
      cell: (account: SandboxAccountView) => (
        <CreatedOnCell account={account} />
      ),
    },
    {
      id: "lastModifiedOn",
      header: "Last Modified",
      sortingComparator: createDateSortingComparator<SandboxAccountView>(
        (a) => a.meta?.lastEditTime,
      ),
      cell: (account: SandboxAccountView) => (
        <LastModifiedCell account={account} />
      ),
    },
    {
      id: "name",
      header: "Name",
      cell: (account: SandboxAccountView) => account.name ?? "N/A",
    },
    {
      id: "email",
      header: "Email",
      cell: (account: SandboxAccountView) => account.email ?? "N/A",
    },
    {
      id: "link",
      header: "Access",
      cell: (account: SandboxAccountView) => <AccessCell account={account} />,
    },
  ].filter((column) => includeLinks || column.id !== "link");

type EjectModalProps = {
  selectedAccounts: SandboxAccountView[];
  ejectAccount: (accountId: string) => Promise<any>;
  queryClient: any;
  setSelectedAccounts: React.Dispatch<
    React.SetStateAction<SandboxAccountView[]>
  >;
};

const EjectModalContent = ({
  selectedAccounts,
  ejectAccount,
  queryClient,
  setSelectedAccounts,
}: EjectModalProps) => (
  <SpaceBetween size="m">
    <Alert type="warning" header="Ejection does not run account cleanup">
      Any resources that remain in the selected accounts can continue to incur
      charges.
    </Alert>
    <BatchActionReview
      items={selectedAccounts}
      description={`${selectedAccounts.length} account(s) to eject`}
      columnDefinitions={createColumnDefinitions(false)}
      identifierKey="awsAccountId"
      sequential
      onSubmit={async (account: SandboxAccountView) => {
        await ejectAccount(account.awsAccountId);
        setSelectedAccounts((prev) =>
          prev.filter((a) => a.awsAccountId !== account.awsAccountId),
        );
      }}
      onSuccess={() => {
        queryClient.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        showSuccessToast(
          "Account(s) were successfully ejected from the account pool.",
        );
      }}
      onError={() =>
        showErrorToast(
          "One or more accounts failed to eject, try resubmitting.",
          "Failed to eject account(s)",
        )
      }
    />
  </SpaceBetween>
);

type CleanupModalProps = {
  selectedAccounts: SandboxAccountView[];
  cleanupAccount: (accountId: string) => Promise<any>;
  queryClient: any;
  setSelectedAccounts: React.Dispatch<
    React.SetStateAction<SandboxAccountView[]>
  >;
};

const CleanupModalContent = ({
  selectedAccounts,
  cleanupAccount,
  queryClient,
  setSelectedAccounts,
}: CleanupModalProps) => (
  <BatchActionReview
    items={selectedAccounts}
    description={`${selectedAccounts.length} account(s) to retry cleanup`}
    columnDefinitions={createColumnDefinitions(false)}
    identifierKey="awsAccountId"
    sequential
    onSubmit={async (account: SandboxAccountView) => {
      await cleanupAccount(account.awsAccountId);
      setSelectedAccounts((prev) =>
        prev.filter((a) => a.awsAccountId !== account.awsAccountId),
      );
    }}
    onSuccess={() => {
      queryClient.invalidateQueries({
        queryKey: ["accounts"],
        refetchType: "all",
      });
      showSuccessToast("Account(s) were successfully sent to retry cleanup");
    }}
    onError={() =>
      showErrorToast(
        "One or more accounts failed to retry cleanup, try resubmitting.",
        "Failed to retry cleanup on account(s)",
      )
    }
  />
);

type QuarantineModalProps = {
  selectedAccounts: SandboxAccountView[];
  quarantineAccount: (accountId: string) => Promise<any>;
  queryClient: any;
  setSelectedAccounts: React.Dispatch<
    React.SetStateAction<SandboxAccountView[]>
  >;
};

const QuarantineModalContent = ({
  selectedAccounts,
  quarantineAccount,
  queryClient,
  setSelectedAccounts,
}: QuarantineModalProps) => (
  <SpaceBetween size="m">
    <Alert type="warning">
      Are you sure you want to quarantine the selected account(s)?
      <br />
      <br />
      This will immediately:
      <ul>
        <li>Terminate any active leases and revoke leaseholder access</li>
        <li>Move the account(s) to the Quarantine OU</li>
        <li>Remove the account(s) from the available account pool</li>
      </ul>
      Current leaseholders will immediately lose access. This action cannot be
      reversed. To return an account to the pool, use &quot;Retry cleanup&quot;
      or eject and re-onboard the account.
    </Alert>
    <BatchActionReview
      items={selectedAccounts}
      description={`${selectedAccounts.length} account(s) to quarantine`}
      columnDefinitions={createColumnDefinitions(false)}
      identifierKey="awsAccountId"
      sequential
      onSubmit={async (account: SandboxAccountView) => {
        await quarantineAccount(account.awsAccountId);
        setSelectedAccounts((prev) =>
          prev.filter((a) => a.awsAccountId !== account.awsAccountId),
        );
      }}
      onSuccess={() => {
        queryClient.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        queryClient.invalidateQueries({
          queryKey: ["leases"],
          refetchType: "all",
        });
        showSuccessToast("Account(s) were successfully quarantined.");
      }}
      onError={() =>
        showErrorToast(
          "One or more accounts failed to quarantine, try resubmitting.",
          "Failed to quarantine account(s)",
        )
      }
    />
  </SpaceBetween>
);

export const ListAccounts = () => {
  // base ui hooks
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  // modal hook
  const { showModal } = useModal();

  // query client
  const queryClient = useQueryClient();

  // api hooks
  const { data: accounts, isFetching, refetch } = useGetAccounts();
  const { mutateAsync: ejectAccount } = useEjectAccount({
    skipInvalidation: true,
  });
  const { mutateAsync: cleanupAccount } = useCleanupAccount({
    skipInvalidation: true,
  });
  const { mutateAsync: quarantineAccount } = useQuarantineAccount({
    skipInvalidation: true,
  });

  // state
  const [filter, setFilter] = useState<SandboxAccountStatus>();
  const [selectedAccounts, setSelectedAccounts] = useState<
    SandboxAccountView[]
  >([]);
  const [filteredAccounts, setFilteredAccounts] = useState<
    SandboxAccountView[]
  >([]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Accounts", href: "/accounts" },
    ]);
    setTools(<Markdown file="accounts" />);
  }, []);

  const onCreateClick = () => {
    navigate("/accounts/new");
  };

  useEffect(() => {
    if (!accounts) return;

    setFilteredAccounts(
      filter ? accounts.filter((x) => filter === x.status) : accounts,
    );
  }, [accounts, filter]);

  // Keep the current selection in sync with the latest account data. Selection
  // holds account snapshots captured at click time, so after a refetch (eject,
  // retry cleanup, quarantine, manual refresh, or a background refresh) those
  // snapshots go stale. Reconciling here ensures the action-enablement logic
  // and the review popup always reflect each account's current status, and
  // drops selections for accounts that no longer exist in the pool.
  useEffect(() => {
    if (!accounts) return;

    setSelectedAccounts((prev) => {
      if (prev.length === 0) return prev;

      const accountsById = new Map(
        accounts.map((account) => [account.awsAccountId, account]),
      );

      return prev
        .map((selected) => accountsById.get(selected.awsAccountId))
        .filter(
          (account): account is SandboxAccountView => account !== undefined,
        );
    });
  }, [accounts]);

  const showEjectModal = () => {
    showModal({
      header: "Eject Account(s)",
      content: (
        <EjectModalContent
          selectedAccounts={selectedAccounts}
          ejectAccount={ejectAccount}
          queryClient={queryClient}
          setSelectedAccounts={setSelectedAccounts}
        />
      ),
      size: "max",
    });
  };

  const showCleanupModal = () => {
    showModal({
      header: "Clean Up Account(s)",
      content: (
        <CleanupModalContent
          selectedAccounts={selectedAccounts}
          cleanupAccount={cleanupAccount}
          queryClient={queryClient}
          setSelectedAccounts={setSelectedAccounts}
        />
      ),
      size: "max",
    });
  };

  const showQuarantineModal = () => {
    showModal({
      header: "Quarantine Account",
      content: (
        <QuarantineModalContent
          selectedAccounts={selectedAccounts}
          quarantineAccount={quarantineAccount}
          queryClient={queryClient}
          setSelectedAccounts={setSelectedAccounts}
        />
      ),
      size: "max",
    });
  };

  const handleSelectionChange = ({ detail }: any) => {
    const accounts = detail.selectedItems as SandboxAccountView[];
    setSelectedAccounts(accounts);
  };

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          actions={
            <Button onClick={onCreateClick} variant="primary">
              Add accounts
            </Button>
          }
          description="Manage registered AWS accounts in the account pool"
        >
          Accounts
        </Header>
      }
    >
      <SpaceBetween size="m">
        <AccountsSummary
          isLoading={isFetching}
          accounts={accounts}
          filter={filter}
          onFilterUpdated={setFilter}
        />
        <Container>
          <Table
            data-embedded-table
            variant="embedded"
            stripedRows
            trackBy="awsAccountId"
            columnDefinitions={createColumnDefinitions(true)}
            header="Accounts"
            items={filteredAccounts}
            selectedItems={selectedAccounts}
            onSelectionChange={handleSelectionChange}
            loading={isFetching}
            actions={
              <SpaceBetween direction="horizontal" size="s">
                <Button
                  iconName="refresh"
                  data-testid="refresh-button"
                  onClick={() => refetch()}
                  disabled={isFetching}
                />
                <ButtonDropdown
                  disabled={selectedAccounts.length === 0}
                  items={[
                    { text: "Eject account", id: "eject" },
                    {
                      text: "Retry cleanup",
                      id: "retryCleanup",
                      // Every selected account must be in a retryable status
                      // (Quarantine/CleanUp) AND free of a live cleanup lock —
                      // a live lock means an execution is already running and
                      // retrying would race it (an expired lock is the stuck
                      // case the retry recovers, so it does not block).
                      disabled: !selectedAccounts.every(
                        (x) =>
                          (x.status === "Quarantine" ||
                            x.status === "CleanUp") &&
                          !isCleanupLockActive(x),
                      ),
                      disabledReason: selectedAccounts.some(isCleanupLockActive)
                        ? "A cleanup is already running for a selected account. Wait for it to finish before retrying."
                        : undefined,
                    },
                    {
                      text: "Quarantine account",
                      id: "quarantine",
                      disabled:
                        // disable quarantine option unless all selected accounts are in available, active, or frozen
                        !selectedAccounts.every(
                          (x) =>
                            x.status === "Available" ||
                            x.status === "Active" ||
                            x.status === "Frozen",
                        ),
                    },
                  ]}
                  onItemClick={({ detail }) => {
                    switch (detail.id) {
                      case "eject":
                        showEjectModal();
                        break;
                      case "retryCleanup":
                        showCleanupModal();
                        break;
                      case "quarantine":
                        showQuarantineModal();
                        break;
                    }
                  }}
                >
                  Actions
                </ButtonDropdown>
              </SpaceBetween>
            }
          />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
};
