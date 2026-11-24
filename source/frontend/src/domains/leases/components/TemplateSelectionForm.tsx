// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  Container,
  Divider,
  Icon,
  Input,
  KeyValuePairs,
  Modal,
  Pagination,
  SpaceBetween,
} from "@cloudscape-design/components";
import { Duration } from "luxon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import CardsField from "@amzn/innovation-sandbox-frontend/components/FormFields/CardsField";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { useGetLeaseTemplates } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";

interface TemplateSelectionFormProps {
  label?: string;
  clearAssignmentsOnChange?: boolean;
}

const LEASE_TEMPLATES_PER_PAGE = 12;
const CARD_CONTENT_MIN_HEIGHT = 320;

const LeaseTemplateDescription = ({
  description,
  templateName,
}: {
  description?: string;
  templateName: string;
}) => {
  const [modalVisible, setModalVisible] = useState(false);
  const [isDescriptionTruncated, setIsDescriptionTruncated] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const descriptionElement = descriptionRef.current;
    if (!descriptionElement || !description) {
      setIsDescriptionTruncated(false);
      return;
    }

    const updateTruncation = () =>
      setIsDescriptionTruncated(
        descriptionElement.scrollHeight > descriptionElement.clientHeight,
      );

    updateTruncation();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateTruncation);
    resizeObserver.observe(descriptionElement);

    return () => resizeObserver.disconnect();
  }, [description]);

  return (
    <SpaceBetween direction="vertical" size="xxs">
      <Box color="text-body-secondary">
        <div
          ref={descriptionRef}
          style={{
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 4,
            overflow: "hidden",
          }}
        >
          {description || "No description"}
        </div>
      </Box>

      {isDescriptionTruncated && (
        <Button
          variant="inline-link"
          formAction="none"
          ariaHaspopup="dialog"
          ariaLabel={`View full description for ${templateName}`}
          onClick={(event) => {
            event.stopPropagation();
            setModalVisible(true);
          }}
        >
          View full description
        </Button>
      )}

      {modalVisible && (
        <Modal
          visible
          size="medium"
          closeAriaLabel="Close full description"
          header={`${templateName} description`}
          onDismiss={() => setModalVisible(false)}
        >
          {description}
        </Modal>
      )}
    </SpaceBetween>
  );
};

const LeaseTemplateCardContent = ({
  option,
}: {
  option: LeaseTemplateView;
}) => (
  <SpaceBetween direction="vertical" size="s">
    <LeaseTemplateDescription
      description={option.description}
      templateName={option.name}
    />
    {option.blueprintName && (
      <KeyValuePairs
        columns={1}
        items={[
          {
            label: "Blueprint",
            value: option.blueprintName,
          },
        ]}
      />
    )}
  </SpaceBetween>
);

const LeaseTemplateSettings = ({
  option,
  leaseSharingEnabled,
  sandboxSpacesEnabled,
}: {
  option: LeaseTemplateView;
  leaseSharingEnabled: boolean;
  sandboxSpacesEnabled: boolean;
}) => {
  const approvalRequired = option.requiresApproval;
  const sharingAllowed = leaseSharingEnabled && option.allowOwnerToShareLease;
  const sandboxSpaceEnabled =
    sandboxSpacesEnabled && option.sandboxSpacesEnabled;

  if (!approvalRequired && !sharingAllowed && !sandboxSpaceEnabled) {
    return null;
  }

  return (
    <SpaceBetween direction="horizontal" size="s">
      {approvalRequired && (
        <Box visualAccent={{ color: "yellow", borderRadius: "s" }}>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Icon name="lock-private" variant="normal" />
            Approval required
          </SpaceBetween>
        </Box>
      )}
      {sharingAllowed && (
        <Box visualAccent={{ color: "blue", borderRadius: "s" }}>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Icon name="group" variant="normal" />
            Sharing allowed
          </SpaceBetween>
        </Box>
      )}
      {sandboxSpaceEnabled && (
        <Box visualAccent={{ color: "purple", borderRadius: "s" }}>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Icon name="gen-ai" variant="normal" />
            Sandbox Space
          </SpaceBetween>
        </Box>
      )}
    </SpaceBetween>
  );
};

const LeaseTemplateCardFooter = ({
  option,
  leaseSharingEnabled,
  sandboxSpacesEnabled,
}: {
  option: LeaseTemplateView;
  leaseSharingEnabled: boolean;
  sandboxSpacesEnabled: boolean;
}) => (
  <SpaceBetween direction="vertical" size="s">
    <LeaseTemplateSettings
      option={option}
      leaseSharingEnabled={leaseSharingEnabled}
      sandboxSpacesEnabled={sandboxSpacesEnabled}
    />
    <Divider />
    <KeyValuePairs
      columns={2}
      items={[
        {
          label: "Budget",
          value: option.maxSpend
            ? formatCurrency(option.maxSpend)
            : "No max budget",
        },
        {
          label: "Duration",
          value: option.leaseDurationInHours
            ? Duration.fromObject({
                hours: option.leaseDurationInHours,
              })
                .rescale()
                .toHuman()
            : "No expiry",
        },
      ]}
    />
  </SpaceBetween>
);

function leaseTemplateCardRenderer(
  leaseSharingEnabled: boolean,
  sandboxSpacesEnabled: boolean,
) {
  return function LeaseTemplateCard(option: LeaseTemplateView) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: `${CARD_CONTENT_MIN_HEIGHT}px`,
        }}
      >
        <LeaseTemplateCardContent option={option} />
        <div style={{ marginTop: "auto" }}>
          <Box padding={{ top: "m" }}>
            <LeaseTemplateCardFooter
              option={option}
              leaseSharingEnabled={leaseSharingEnabled}
              sandboxSpacesEnabled={sandboxSpacesEnabled}
            />
          </Box>
        </div>
      </div>
    );
  };
}

export const TemplateSelectionForm = ({
  label = "What lease template would you like to use?",
  clearAssignmentsOnChange = false,
}: TemplateSelectionFormProps) => {
  const { control, getValues, setValue } = useFormContext();

  const [currentPageIndex, setCurrentPageIndex] = useState<number>(1);
  const [searchTerm, setSearchTerm] = useState<string>("");

  const {
    data: leaseTemplates,
    isLoading,
    isError,
    refetch,
    error: fetchError,
  } = useGetLeaseTemplates();
  // Global switches, so a template's own setting reads as overridden when the
  // feature is off deployment-wide. Readable by every role.
  const { data: config } = useGetConfigurations();
  const leaseSharingEnabled = !!config?.leases.leaseSharingEnabled;
  const sandboxSpacesEnabled = !!config?.agent.sandboxSpacesEnabled;

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
          error={fetchError}
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
          <CardsField<LeaseTemplateView, any, "leaseTemplateUuid">
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
              onSelectionChange: () => {
                if (
                  clearAssignmentsOnChange &&
                  getValues("assignments")?.length
                ) {
                  setValue("assignments", undefined, {
                    shouldDirty: false,
                    shouldValidate: false,
                  });
                }
              },
              cardsPerRow: [
                { cards: 1 },
                { minWidth: 500, cards: 2 },
                { minWidth: 800, cards: 3 },
              ],
              cardDefinition: {
                header: (option) => option.name,
                sections: [
                  {
                    content: leaseTemplateCardRenderer(
                      leaseSharingEnabled,
                      sandboxSpacesEnabled,
                    ),
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
