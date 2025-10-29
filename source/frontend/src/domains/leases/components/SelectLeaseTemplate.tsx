// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Cards,
  ColumnLayout,
  FormField,
  Input,
  Pagination,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import moment from "moment";
import { useEffect, useMemo, useState } from "react";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { VisibilityIndicator } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/VisibilityIndicator";
import { useGetLeaseTemplates } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";

interface SelectLeaseTemplateProps {
  value: string;
  onChange: (templateId: string) => void;
}

const LEASE_TEMPLATES_PER_PAGE = 12;
const LeaseTemplateCardContent = ({ option }: { option: LeaseTemplate }) => (
  <Box>
    <Divider />
    <SpaceBetween size="l">
      <Box>
        <FormField data-nowrap label="Description:" />
        {option.description ?? "No description"}
      </Box>
      <Box>
        <FormField data-nowrap label="Max Budget:" />
        {option.maxSpend ? (
          formatCurrency(option.maxSpend)
        ) : (
          <StatusIndicator type="info">No max budget</StatusIndicator>
        )}
      </Box>

      <Box>
        <FormField data-nowrap label="Expires:" />
        {option.leaseDurationInHours ? (
          `after ${moment.duration(option.leaseDurationInHours, "hours").humanize()}`
        ) : (
          <StatusIndicator type="info">No expiry</StatusIndicator>
        )}
      </Box>

      <Box>
        <FormField data-nowrap label="Visibility:" />
        <VisibilityIndicator item={option} />
      </Box>

      <Box>
        <FormField data-nowrap label="Approval:" />
        {option.requiresApproval ? (
          <StatusIndicator type="warning">
            <span data-wrap>Requires approval</span>
          </StatusIndicator>
        ) : (
          <StatusIndicator type="success">
            <span data-wrap>No approval required</span>
          </StatusIndicator>
        )}
      </Box>
    </SpaceBetween>
  </Box>
);

export const SelectLeaseTemplate = ({
  value,
  onChange,
}: SelectLeaseTemplateProps) => {
  const [selectedLeaseTemplates, setSelectedLeaseTemplates] = useState<
    LeaseTemplate[]
  >([]);
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(1);
  const [searchTerm, setSearchTerm] = useState<string>("");

  const {
    data: leaseTemplates,
    isLoading,
    isError,
    refetch,
    error: fetchError,
  } = useGetLeaseTemplates();

  const handleSelectionChange = ({ detail }: { detail: any }) => {
    if (detail.selectedItems.length > 0) {
      const leaseTemplate = detail.selectedItems[0];
      onChange(leaseTemplate.uuid);
    } else {
      onChange("");
    }
  };

  // Filter templates by name
  const filteredLeaseTemplates = useMemo(() => {
    if (!leaseTemplates) return [];

    // If no search term, return all templates
    if (!searchTerm.trim()) {
      return leaseTemplates;
    }

    const normalizedSearchTerm = searchTerm.toLowerCase().trim();

    return leaseTemplates.filter((template) =>
      template.name.toLowerCase().includes(normalizedSearchTerm),
    );
  }, [leaseTemplates, searchTerm]);

  // Update selected templates
  useEffect(() => {
    if (!leaseTemplates) {
      setSelectedLeaseTemplates([]);
      return;
    }

    const selectedTemplate = value
      ? leaseTemplates.find((template) => template.uuid === value)
      : null;

    setSelectedLeaseTemplates(selectedTemplate ? [selectedTemplate] : []);
  }, [value, leaseTemplates]);

  // Calculate paginated items
  const paginatedLeaseTemplates = useMemo(() => {
    if (!filteredLeaseTemplates.length) return [];

    const startIndex = (currentPageIndex - 1) * LEASE_TEMPLATES_PER_PAGE;
    const endIndex = startIndex + LEASE_TEMPLATES_PER_PAGE;
    return filteredLeaseTemplates.slice(startIndex, endIndex);
  }, [filteredLeaseTemplates, currentPageIndex]);

  // Calculate total pages
  const totalPages = useMemo(() => {
    if (!filteredLeaseTemplates.length) return 1;
    return Math.ceil(filteredLeaseTemplates.length / LEASE_TEMPLATES_PER_PAGE);
  }, [filteredLeaseTemplates]);

  useEffect(() => {
    if (searchTerm !== "") {
      setCurrentPageIndex(1);
    }
  }, [searchTerm]);

  if (isLoading) {
    return <Loader label="Loading lease templates..." />;
  }

  if (isError) {
    return (
      <ErrorPanel
        description="Could not load lease templates at the moment."
        retry={refetch}
        error={fetchError as Error}
      />
    );
  }

  if ((leaseTemplates || []).length === 0) {
    return (
      <Alert type="error" header="No lease templates configured.">
        Please contact your system administrator.
      </Alert>
    );
  }

  if (!isLoading) {
    return (
      <SpaceBetween size="s">
        <ColumnLayout columns={2}>
          <Box>
            <Input
              type="search"
              placeholder="Search by template name"
              value={searchTerm}
              onChange={({ detail }) => setSearchTerm(detail.value)}
              ariaLabel="Search lease templates"
            />
          </Box>

          {totalPages > 1 && (
            <Box float="right">
              <Pagination
                currentPageIndex={currentPageIndex}
                pagesCount={totalPages}
                onChange={({ detail }) =>
                  setCurrentPageIndex(detail.currentPageIndex)
                }
                ariaLabels={{
                  nextPageLabel: "Next page",
                  previousPageLabel: "Previous page",
                  pageLabel: (pageNumber) =>
                    `Page ${pageNumber} of ${totalPages}`,
                }}
              />
            </Box>
          )}
        </ColumnLayout>
        <Box>
          {filteredLeaseTemplates.length === 0 && searchTerm.trim() !== "" ? (
            <Alert type="info" header="No matching templates">
              No lease templates match your search term. Try a different search.
            </Alert>
          ) : (
            <Cards
              items={paginatedLeaseTemplates}
              selectedItems={selectedLeaseTemplates}
              onSelectionChange={handleSelectionChange}
              entireCardClickable
              selectionType="single"
              cardsPerRow={[
                { cards: 1 },
                { minWidth: 500, cards: 2 },
                { minWidth: 800, cards: 3 },
              ]}
              cardDefinition={{
                header: (option) => option.name,
                sections: [
                  {
                    // prettier-ignore
                    content: (option) => <LeaseTemplateCardContent option={option} />, // NOSONAR typescript:S6478 - the way the card component works requires defining component during render
                  },
                ],
              }}
            />
          )}
        </Box>
      </SpaceBetween>
    );
  }
};
