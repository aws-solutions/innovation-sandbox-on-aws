// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  ColumnLayout,
  Container,
  Header,
  Input,
  KeyValuePairs,
  Pagination,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import CardsField from "@amzn/innovation-sandbox-frontend/components/FormFields/CardsField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { BlueprintSelectionFormValues } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { useGetBlueprints } from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import { BlueprintView } from "@amzn/innovation-sandbox-frontend/domains/blueprints/model";

const BLUEPRINTS_PER_PAGE = 12;
const DEPLOY_BLUEPRINT_DESCRIPTION =
  "When enabled, every lease created from this template starts with the blueprint's resources already deployed in its sandbox account. When disabled, users get an empty account.";
const BLUEPRINTS_DESCRIPTION =
  "The resources deployed into each sandbox account when a lease starts, so users get a ready-to-use environment.";

const BlueprintCardContent = ({ option }: { option: BlueprintView }) => (
  <Box>
    <Divider />
    <KeyValuePairs
      columns={1}
      items={[
        {
          label: "Blueprint ID",
          value: option.blueprintId,
        },
        {
          label: "Deployment Timeout",
          value: option.deploymentTimeoutMinutes,
        },
        {
          label: "Created By",
          value: option.createdBy,
        },
      ]}
    />
  </Box>
);

/**
 * Reusable form component for blueprint selection.
 * Uses FormContext from parent - no internal state management.
 * Shows a toggle to enable/disable blueprint deployment, and conditionally
 * renders the blueprint card selector when enabled.
 *
 * When no blueprints are available, the toggle is automatically disabled
 * and forced off so the user is not blocked by validation.
 */
export const SelectBlueprintForm = () => {
  const { control, setValue, resetField } =
    useFormContext<BlueprintSelectionFormValues>();

  const blueprintEnabled = useWatch({ control, name: "blueprintEnabled" });

  const [currentPageIndex, setCurrentPageIndex] = useState<number>(1);
  const [searchTerm, setSearchTerm] = useState<string>("");

  const {
    data: response,
    isLoading,
    isError,
    refetch,
    error: fetchError,
  } = useGetBlueprints();

  const blueprints = useMemo(
    () => (response?.blueprints ?? []).map((item) => item.blueprint),
    [response?.blueprints],
  );
  const hasBlueprints = !isLoading && !isError && blueprints.length > 0;

  // Auto-disable toggle when no blueprints are available
  useEffect(() => {
    if (!isLoading && !isError && !hasBlueprints && blueprintEnabled) {
      setValue("blueprintEnabled", false, { shouldDirty: false });
    }
  }, [isLoading, isError, hasBlueprints, blueprintEnabled, setValue]);

  // Clear blueprint selection when toggle is turned off
  useEffect(() => {
    if (!blueprintEnabled) {
      resetField("blueprintId");
      setValue("blueprintName", null);
    }
  }, [blueprintEnabled, resetField, setValue]);

  const filteredBlueprints = useMemo(() => {
    if (!searchTerm.trim()) {
      return blueprints;
    }

    const normalizedSearchTerm = searchTerm.toLowerCase().trim();

    return blueprints.filter((blueprint) =>
      blueprint.name?.toLowerCase().includes(normalizedSearchTerm),
    );
  }, [blueprints, searchTerm]);

  const paginatedBlueprints = useMemo(() => {
    if (!filteredBlueprints.length) return [];

    const startIndex = (currentPageIndex - 1) * BLUEPRINTS_PER_PAGE;
    const endIndex = startIndex + BLUEPRINTS_PER_PAGE;
    return filteredBlueprints.slice(startIndex, endIndex);
  }, [filteredBlueprints, currentPageIndex]);

  const totalPages = useMemo(() => {
    if (!filteredBlueprints.length) return 1;
    return Math.ceil(filteredBlueprints.length / BLUEPRINTS_PER_PAGE);
  }, [filteredBlueprints]);

  useEffect(() => {
    if (searchTerm !== "") {
      setCurrentPageIndex(1);
    }
  }, [searchTerm]);

  // Disable toggle while loading or when no blueprints exist
  const toggleDisabled = isLoading || (!isError && !hasBlueprints);

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header variant="h2" description={DEPLOY_BLUEPRINT_DESCRIPTION}>
            Deploy a blueprint
          </Header>
        }
      >
        <ToggleField
          controllerProps={{ control, name: "blueprintEnabled" }}
          formFieldProps={{
            label: "Deploy a blueprint",
            description:
              toggleDisabled && !isLoading
                ? "No blueprints are available. Register a blueprint first to enable this option."
                : undefined,
          }}
          toggleProps={{
            ariaLabel: "Deploy a blueprint",
            children: blueprintEnabled ? "Deploy a blueprint" : "Empty account",
            disabled: toggleDisabled,
          }}
        />
      </Container>

      {blueprintEnabled && (
        <Container
          header={
            <Header variant="h2" description={BLUEPRINTS_DESCRIPTION}>
              Blueprints
            </Header>
          }
        >
          <SpaceBetween size="m">
            {isLoading && <Loader label="Loading blueprints..." />}

            {isError && (
              <ErrorPanel
                description="Could not load blueprints at the moment."
                retry={refetch}
                error={fetchError}
              />
            )}

            {hasBlueprints && (
              <SpaceBetween size="m">
                <ColumnLayout columns={2}>
                  <Box>
                    <Input
                      type="search"
                      placeholder="Find a blueprint"
                      value={searchTerm}
                      onChange={({ detail }) => setSearchTerm(detail.value)}
                      ariaLabel="Search blueprints"
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

                {filteredBlueprints.length === 0 && searchTerm.trim() !== "" ? (
                  <Alert type="info" header="No matching blueprints">
                    No blueprints match your search term. Try a different
                    search.
                  </Alert>
                ) : (
                  <CardsField<
                    BlueprintView,
                    BlueprintSelectionFormValues,
                    "blueprintId"
                  >
                    controllerProps={{
                      control,
                      name: "blueprintId",
                    }}
                    formFieldProps={{ stretch: true }}
                    cardsProps={{
                      items: paginatedBlueprints,
                      entireCardClickable: true,
                      selectionType: "single",
                      ariaLabels: {
                        selectionGroupLabel: "Blueprints",
                        itemSelectionLabel: (_selection, blueprint) =>
                          blueprint.name,
                      },
                      cardsPerRow: [
                        { cards: 1 },
                        { minWidth: 500, cards: 2 },
                        { minWidth: 700, cards: 3 },
                      ],
                      cardDefinition: {
                        header: (option) => option.name,
                        sections: [
                          {
                            // prettier-ignore
                            content: (option) => <BlueprintCardContent option={option} />, // NOSONAR typescript:S6478 - the way the card component works requires defining component during render
                          },
                        ],
                      },
                      onSelectionChange: ({ detail }) => {
                        const selected = detail.selectedItems[0];
                        setValue("blueprintName", selected?.name ?? null);
                      },
                    }}
                    valueExtractor={(blueprint) => blueprint.blueprintId}
                    itemMatcher={(blueprint, selectedBlueprintId) =>
                      blueprint.blueprintId === selectedBlueprintId
                    }
                  />
                )}
              </SpaceBetween>
            )}
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
};

export type { BlueprintSelectionFormValues } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
