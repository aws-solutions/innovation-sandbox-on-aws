// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useAddAccount,
  useGetUnregisteredAccounts,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/hooks";
import { UnregisteredAccount } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { Table } from "@aws-northstar/ui";
import {
  Alert,
  Button,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export const AddAccounts = () => {
  const { setTools } = useAppLayoutContext();
  const setBreadcrumb = useBreadcrumb();
  const queryClient = useQueryClient();
  const {
    data: unregisteredAccounts,
    isLoading: getUnregisteredAccountsIsLoading,
    isFetching: getUnregisteredAccountsIsFetching,
    refetch,
  } = useGetUnregisteredAccounts();

  const { mutateAsync: addAccount } = useAddAccount({ skipInvalidation: true });

  const [selectedAccounts, setSelectedAccounts] = useState<
    UnregisteredAccount[]
  >([]);

  const { showModal } = useModal();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Accounts", href: "/accounts" },
      { text: "Add Accounts", href: "/accounts/new" },
    ]);
    setTools(<Markdown file="add-accounts" />);
  }, []);

  const showRegisterModal = () =>
    showModal({
      header: "Review Accounts to Register",
      content: (
        <BatchActionReview
          items={selectedAccounts}
          description={`${selectedAccounts.length} account(s) will be added to the account pool`}
          columnDefinitions={columnDefinitions}
          identifierKey="Id"
          sequential
          footer={
            <Alert type="warning" header="Warning">
              The accounts listed above will be nuked meaning all resources in
              the account will be deleted permanently.
              <br />
              This action cannot be undone!
            </Alert>
          }
          onSubmit={async (account: UnregisteredAccount) => {
            await addAccount(account.Id);
            setSelectedAccounts((prev) =>
              prev.filter((a) => a.Id !== account.Id),
            );
          }}
          onSuccess={() => {
            // Invalidate both queries after all submissions complete
            queryClient.invalidateQueries({
              queryKey: ["accounts"],
              refetchType: "all",
            });
            queryClient.invalidateQueries({
              queryKey: ["unregisteredAccounts"],
              refetchType: "all",
            });
            showSuccessToast(
              "Accounts were successfully registered with the solution and are now in cleanup.",
            );
          }}
          onError={() =>
            showErrorToast(
              "One or more accounts failed to register, try resubmitting registration.",
              "Failed to register accounts",
            )
          }
        />
      ),
      size: "max",
    });

  const columnDefinitions = [
    {
      cell: (account: UnregisteredAccount) => account.Id,
      header: "AWS Account ID",
      id: "Id",
    },
    {
      cell: (account: UnregisteredAccount) => account.Email,
      header: "Email",
      id: "Email",
    },
    {
      cell: (account: UnregisteredAccount) => account.Name,
      header: "Name",
      id: "Name",
    },
  ];

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="add-accounts" />}
          description="Select accounts to register with the solution"
        >
          Add Accounts
        </Header>
      }
    >
      <Table
        header="Unregistered Accounts"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              iconName="refresh"
              onClick={() => refetch()}
              disabled={getUnregisteredAccountsIsLoading}
            />
            <Button
              variant="primary"
              onClick={showRegisterModal}
              disabled={selectedAccounts.length === 0}
            >
              Register
            </Button>
          </SpaceBetween>
        }
        trackBy="Id"
        columnDefinitions={columnDefinitions}
        items={unregisteredAccounts ?? []}
        loading={getUnregisteredAccountsIsFetching}
        selectionType="multi"
        selectedItems={selectedAccounts}
        onSelectionChange={({ detail }) =>
          setSelectedAccounts(detail.selectedItems)
        }
        stripedRows
        enableKeyboardNavigation
      />
    </ContentLayout>
  );
};
