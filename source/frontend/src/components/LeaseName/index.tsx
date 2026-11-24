// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LinkProps } from "@cloudscape-design/components";

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { getLeaseDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";

interface LeaseNameProps {
  /** The lease UUID (used for display name derivation). */
  uuid: string;
  /** The lease template name (included in the display name). */
  templateName: string;
  /** The lease ID used for routing (e.g., `userEmail#uuid`). When provided, renders as a link. */
  leaseId?: string;
  /** Optional font size for the link (passed to TextLink). */
  fontSize?: LinkProps.FontSize;
}

/**
 * Renders a lease display name (`<templateName> (<first8>)`) with optional link
 * to lease details.
 */
export const LeaseName = ({
  uuid,
  templateName,
  leaseId,
  fontSize,
}: LeaseNameProps) => {
  const displayName = getLeaseDisplayName({
    uuid,
    originalLeaseTemplateName: templateName,
  });

  if (leaseId) {
    return (
      <TextLink fontSize={fontSize} to={`/leases/${leaseId}`}>
        {displayName}
      </TextLink>
    );
  }

  return <>{displayName}</>;
};
