// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import CardsField from "@amzn/innovation-sandbox-frontend/components/FormFields/CardsField";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { VisibilityIndicator } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/VisibilityIndicator";
import { useGetLeaseTemplates } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";
import {
  Alert,
  Box,
  ColumnLayout,
  Container,
  Input,
  KeyValuePairs,
  Pagination,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { Duration } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";

interface TemplateSelectionFormProps {
  label?: string;
}

const LEASE_TEMPLATES_PER_PAGE = 12;

const LeaseTemplateCardContent = ({ option }: { option: LeaseTemplate }) => (
  <Box>
    <Divider />
    <KeyValuePairs
      columns={1}
      items={[
        {
          label: "Description",
          value: option.description || "No description",
        },
        {
          label: "Blueprint",
          value: <BlueprintName blueprintName={option.blueprintName} />,
        },
        {
          label: "Max Budget",
          value: option.maxSpend ? (
            formatCurrency(option.maxSpend)
          ) : (
            <StatusIndicator type="info">No max budget</StatusIndicator>
          ),
        },
        {
          label: "Expires",
          value: option.leaseDurationInHours ? (
            `after ${Duration.fromObject({ hours: option.leaseDurationInHours }).toHuman()}`
          ) : (
            <StatusIndicator type="info">No expiry</StatusIndicator>
          ),
        },
        {
          label: "Visibility",
          value: <VisibilityIndicator item={option} />,
        },
        {
          label: "Approval",
          value: option.requiresApproval ? (
            <StatusIndicator type="warning">Requires approval</StatusIndicator>
          ) : (
            <StatusIndicator type="success">
              No approval required
            </StatusIndicator>
          ),
        },
      ]}
    />
  </Box>
);

export const TemplateSelectionForm = ({
  label = "What lease template would you like to use?",
}: TemplateSelectionFormProps) => {
  const { control } = useFormContext();

  const [currentPageIndex, setCurrentPageIndex] = useState<number>(1);
  const [searchTerm, setSearchTerm] = useState<string>("");

  const {
    data: leaseTemplates,
    isLoading,
    isError,
    refetch,
    error: fetchError,
  } = useGetLeaseTemplates();

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

  // Reset to page 1 when search term changes
  useEffect(() => {
    if (searchTerm !== "") {
      setCurrentPageIndex(1);
    }
  }, [searchTerm]);

  if (isLoading) {
    return (
      <Container>
        <Loader label="Loading lease templates..." />
      </Container>
    );
  }

  if (isError) {
    return (
      <Container>
        <ErrorPanel
          description="Could not load lease templates at the moment."
          retry={refetch}
          error={fetchError as Error}
        />
      </Container>
    );
  }

  if ((leaseTemplates || []).length === 0) {
    return (
      <Container>
        <Alert type="error" header="No lease templates configured.">
          Please contact your system administrator.
        </Alert>
      </Container>
    );
  }

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
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

        {filteredLeaseTemplates.length === 0 && searchTerm.trim() !== "" ? (
          <Alert type="info" header="No matching templates">
            No lease templates match your search term. Try a different search.
          </Alert>
        ) : (
          <CardsField<LeaseTemplate, any, "leaseTemplateUuid">
            controllerProps={{
              control,
              name: "leaseTemplateUuid",
            }}
            formFieldProps={{
              stretch: true,
              label,
            }}
            cardsProps={{
              items: paginatedLeaseTemplates,
              entireCardClickable: true,
              selectionType: "single",
              cardsPerRow: [
                { cards: 1 },
                { minWidth: 500, cards: 2 },
                { minWidth: 800, cards: 3 },
              ],
              cardDefinition: {
                header: (option) => option.name,
                sections: [
                  {
                    // prettier-ignore
                    content: (option) => <LeaseTemplateCardContent option={option} />, // NOSONAR typescript:S6478 - the way the card component works requires defining component during render
                  },
                ],
              },
            }}
            valueExtractor={(template) => template.uuid}
            itemMatcher={(template, uuid) => template.uuid === uuid}
          />
        )}
      </SpaceBetween>
    </Container>
  );
};
