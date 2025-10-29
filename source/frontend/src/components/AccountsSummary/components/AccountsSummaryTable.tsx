// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpaceBetween, Table } from "@cloudscape-design/components";
import classNames from "classnames";
import { ReactNode, useMemo } from "react";

import {
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account";
import {
  AccountStatusDatum,
  convertAccountsToSummary,
  getColor,
} from "@amzn/innovation-sandbox-frontend/components/AccountsSummary/helpers";
import styles from "@amzn/innovation-sandbox-frontend/components/AccountsSummary/styles.module.scss";

interface AccountsSummaryTableProps {
  accounts: SandboxAccount[];
  filter?: SandboxAccountStatus;
  onClick?: (item?: AccountStatusDatum) => void;
}

const StatusCell = ({
  item,
  onClick,
  filter,
}: {
  item: AccountStatusDatum;
  onClick?: (item: AccountStatusDatum) => void;
  filter?: SandboxAccountStatus;
}) => (
  <div
    onClick={() => onClick?.(item)}
    className={classNames(
      { [styles.clickable]: !!onClick },
      {
        [styles.semiTransparent]: filter && filter !== item.status,
      },
    )}
  >
    <SpaceBetween size="xs" direction="horizontal" alignItems="center">
      <svg
        className={classNames(styles.icon, {
          [styles.hidden]: item.title === "Total",
        })}
      >
        <rect
          style={{
            fill: getColor(item.status),
          }}
        />
      </svg>
      <span
        className={classNames({
          [styles.bold]: item.title === "Total",
        })}
      >
        {item.title}
      </span>
    </SpaceBetween>
  </div>
);

const CountCell = ({
  item,
  onClick,
  filter,
}: {
  item: AccountStatusDatum;
  onClick?: (item: AccountStatusDatum) => void;
  filter?: SandboxAccountStatus;
}) => (
  <span
    onClick={() => onClick?.(item)}
    className={classNames(
      styles.rightAlign,
      { [styles.clickable]: !!onClick },
      { [styles.bold]: item.title === "Total" },
      {
        [styles.semiTransparent]: filter && filter !== item.status,
      },
    )}
  >
    {item.value}
  </span>
);

const HeaderCell = ({ children }: { children: ReactNode }) => (
  <span className={styles.rightAlign}>{children}</span>
);

export const AccountsSummaryTable = ({
  accounts,
  filter,
  onClick,
}: AccountsSummaryTableProps) => {
  // memoise summary
  const summary = useMemo(() => {
    const summary = convertAccountsToSummary(accounts);

    // add footer row to show total accounts
    summary.push({ title: "Total", value: accounts?.length ?? 0 });
    return summary;
  }, [accounts]);

  const handleClick = (item: AccountStatusDatum) => {
    if (filter === item.status) {
      onClick?.();
    } else {
      onClick?.(item);
    }
  };

  return (
    <Table
      variant="embedded"
      sortingDisabled
      trackBy="title"
      items={summary}
      columnDefinitions={[
        {
          id: "title",
          header: "Account Status",
          sortingField: "title",
          // prettier-ignore
          cell: (item) => ( // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
            <StatusCell item={item} onClick={handleClick} filter={filter} />
          ),
        },
        {
          id: "value",
          header: <HeaderCell>Count</HeaderCell>,
          sortingField: "value",
          // prettier-ignore
          cell: (item) => ( // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
            <CountCell item={item} onClick={handleClick} filter={filter} />
          ),
        },
      ]}
    />
  );
};
