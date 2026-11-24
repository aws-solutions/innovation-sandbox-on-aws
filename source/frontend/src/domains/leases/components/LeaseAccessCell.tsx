// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ButtonDropdown, SpaceBetween } from "@cloudscape-design/components";

import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";

const OPEN_SPACE_ID = "open-space";

export interface LeaseAccessOpenSpace {
  readonly onOpen: () => void;
}

interface LeaseAccessCellProps {
  readonly accountId: string;
  /** Omit when the viewer cannot open a Sandbox Space on this lease; the cell then shows only the Login link. */
  readonly openSpace?: LeaseAccessOpenSpace;
}

/** Login link for the lease table, with a menu offering Open Space when the lease has one. */
export const LeaseAccessCell = ({
  accountId,
  openSpace,
}: LeaseAccessCellProps) => {
  if (!openSpace) {
    return <AccountLoginLink accountId={accountId} wrapText={false} />;
  }
  return (
    <SpaceBetween direction="horizontal" size="xxs">
      <AccountLoginLink accountId={accountId} wrapText={false} />
      <ButtonDropdown
        variant="inline-icon"
        iconName="caret-down-filled"
        ariaLabel="More access options"
        expandToViewport
        items={[
          {
            id: OPEN_SPACE_ID,
            text: "Open Space",
            iconName: "gen-ai",
          },
        ]}
        onItemClick={({ detail }) => {
          if (detail.id === OPEN_SPACE_ID) openSpace.onOpen();
        }}
      />
    </SpaceBetween>
  );
};
