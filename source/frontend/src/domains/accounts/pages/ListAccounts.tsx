// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
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

import {
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { AccountsSummary } from "@amzn/innovation-sandbox-frontend/components/AccountsSummary";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AccountStatusIndicator } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/AccountStatusIndicator";
import { accountStatusSortingComparator } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import {
  useCleanupAccount,
  useEjectAccount,
  useGetAccounts,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

const StatusCell = ({ account }: { account: SandboxAccount }) => (
  <AccountStatusIndicator
    status={account.status}
    lastCleanupStartTime={
      account.cleanupExecutionContext?.stateMachineExecutionStartTime!
    }
  />
);

const CreatedOnCell = ({ account }: { account: SandboxAccount }) =>
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

const LastModifiedCell = ({ account }: { account: SandboxAccount }) =>
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

const AccessCell = ({ account }: { account: SandboxAccount }) => (
  <AccountLoginLink accountId={account.awsAccountId} />
);

const createColumnDefinitions = (includeLinks: boolean) =>
  [
    {
      id: "awsAccountId",
      header: "Account ID",
      sortingField: "awsAccountId",
      cell: (account: SandboxAccount) => account.awsAccountId,
    },
    {
      id: "status",
      header: "Status",
      sortingComparator: accountStatusSortingComparator,
      cell: (account: SandboxAccount) => <StatusCell account={account} />,
    },
    {
      id: "createdOn",
      header: "Added",
      sortingComparator: createDateSortingComparator<SandboxAccount>(
        (a) => a.meta?.createdTime,
      ),
      cell: (account: SandboxAccount) => <CreatedOnCell account={account} />,
    },
    {
      id: "lastModifiedOn",
      header: "Last Modified",
      sortingComparator: createDateSortingComparator<SandboxAccount>(
        (a) => a.meta?.lastEditTime,
      ),
      cell: (account: SandboxAccount) => <LastModifiedCell account={account} />,
    },
    {
      id: "name",
      header: "Name",
      cell: (account: SandboxAccount) => account.name ?? "N/A",
    },
    {
      id: "email",
      header: "Email",
      cell: (account: SandboxAccount) => account.email ?? "N/A",
    },
    {
      id: "link",
      header: "Access",
      cell: (account: SandboxAccount) => <AccessCell account={account} />,
    },
  ].filter((column) => includeLinks || column.id !== "link");

type EjectModalProps = {
  selectedAccounts: SandboxAccount[];
  ejectAccount: (accountId: string) => Promise<any>;
  queryClient: any;
  setSelectedAccounts: React.Dispatch<React.SetStateAction<SandboxAccount[]>>;
};

const EjectModalContent = ({
  selectedAccounts,
  ejectAccount,
  queryClient,
  setSelectedAccounts,
}: EjectModalProps) => (
  <BatchActionReview
    items={selectedAccounts}
    description={`${selectedAccounts.length} account(s) to eject`}
    columnDefinitions={createColumnDefinitions(false)}
    identifierKey="awsAccountId"
    sequential
    onSubmit={async (account: SandboxAccount) => {
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
);

type CleanupModalProps = {
  selectedAccounts: SandboxAccount[];
  cleanupAccount: (accountId: string) => Promise<any>;
  queryClient: any;
  setSelectedAccounts: React.Dispatch<React.SetStateAction<SandboxAccount[]>>;
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
    onSubmit={async (account: SandboxAccount) => {
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

  // state
  const [filter, setFilter] = useState<SandboxAccountStatus>();
  const [selectedAccounts, setSelectedAccounts] = useState<SandboxAccount[]>(
    [],
  );
  const [filteredAccounts, setFilteredAccounts] = useState<SandboxAccount[]>(
    [],
  );

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

    filter
      ? setFilteredAccounts(accounts.filter((x) => filter === x.status))
      : setFilteredAccounts(accounts);
  }, [accounts, filter]);

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

  const handleSelectionChange = ({ detail }: any) => {
    const accounts = detail.selectedItems as SandboxAccount[];
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
                      disabled:
                        // disable cleanup option unless all selected accounts are in quarantine or cleanup
                        !selectedAccounts.every(
                          (x) =>
                            x.status === "Quarantine" || x.status === "CleanUp",
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
