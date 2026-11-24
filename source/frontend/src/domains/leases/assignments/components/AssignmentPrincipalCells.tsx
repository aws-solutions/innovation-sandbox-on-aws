// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge, SpaceBetween } from "@cloudscape-design/components";

import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

type AssignmentPrincipalNameCellProps = {
  displayName?: string;
  isOwner: boolean;
};

export const AssignmentPrincipalNameCell = ({
  displayName,
  isOwner,
}: AssignmentPrincipalNameCellProps) => (
  <SpaceBetween direction="horizontal" size="xs">
    <span>{displayName}</span>
    {isOwner && <Badge color="grey">Owner</Badge>}
  </SpaceBetween>
);

export const AssignmentPrincipalTypeCell = ({
  principalType,
}: {
  principalType: PrincipalType;
}) => (principalType === "USER" ? "User" : "Group");

export const AssignmentPrincipalSubtitleCell = ({
  principalType,
  subtitle,
}: {
  principalType: PrincipalType;
  subtitle?: string;
}) => (principalType === "GROUP" ? (subtitle ?? "Group") : (subtitle ?? "—"));
