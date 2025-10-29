// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Button,
  ButtonDropdown,
  Container,
  ContentLayout,
  Header,
  Popover,
  SpaceBetween,
} from "@cloudscape-design/components";
import moment from "moment";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { AccountsSummary } from "@amzn/innovation-sandbox-frontend/components/AccountsSummary";
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
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useAppLayoutContext } from "@aws-northstar/ui/components/AppLayout";

const StatusCell = ({ account }: { account: SandboxAccount }) => (
  <AccountStatusIndicator
    status={account.status}
    lastCleanupStartTime={
      account.cleanupExecutionContext?.stateMachineExecutionStartTime!
    }
  />
);

const CreatedOnCell = ({ account }: { account: SandboxAccount }) => (
  <Popover
    position="top"
    dismissButton={false}
    content={moment(account.meta?.createdTime).format("MM/DD/YYYY hh:mm:A")}
  >
    {moment(account.meta?.createdTime).fromNow()}
  </Popover>
);

const LastModifiedCell = ({ account }: { account: SandboxAccount }) => (
  <Popover
    position="top"
    dismissButton={false}
    content={moment(account.meta?.lastEditTime).format("MM/DD/YYYY hh:mm:A")}
  >
    {moment(account.meta?.lastEditTime).fromNow()}
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
      sortingField: "createdOn",
      cell: (account: SandboxAccount) => <CreatedOnCell account={account} />,
    },
    {
      id: "lastModifiedOn",
      header: "Last Modified",
      sortingField: "lastModifiedOn",
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
  navigate: (path: string) => void;
};

const EjectModalContent = ({
  selectedAccounts,
  ejectAccount,
  navigate,
}: EjectModalProps) => (
  <BatchActionReview
    items={selectedAccounts}
    description={`${selectedAccounts.length} account(s) to eject`}
    columnDefinitions={createColumnDefinitions(false)}
    identifierKey="awsAccountId"
    onSubmit={async (account: SandboxAccount) => {
      await ejectAccount(account.awsAccountId);
    }}
    onSuccess={() => {
      navigate("/accounts");
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
  navigate: (path: string) => void;
};

const CleanupModalContent = ({
  selectedAccounts,
  cleanupAccount,
  navigate,
}: CleanupModalProps) => (
  <BatchActionReview
    items={selectedAccounts}
    description={`${selectedAccounts.length} account(s) to retry cleanup`}
    columnDefinitions={createColumnDefinitions(false)}
    identifierKey="awsAccountId"
    onSubmit={async (account: SandboxAccount) => {
      await cleanupAccount(account.awsAccountId);
    }}
    onSuccess={() => {
      navigate("/accounts");
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

  // api hooks
  const { data: accounts, isFetching, refetch } = useGetAccounts();
  const { mutateAsync: ejectAccount } = useEjectAccount();
  const { mutateAsync: cleanupAccount } = useCleanupAccount();

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
          navigate={navigate}
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
          navigate={navigate}
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
