// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config";
import { Form } from "@amzn/innovation-sandbox-frontend/components/Form";
import { costReportFields } from "../formFields/costReport";

type CostReportFormProps = {
  costReportGroup: LeaseTemplate["costReportGroup"];
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  isUpdating: boolean;
  costReportGroups?: ReportingConfig["costReportGroups"];
  requireCostReportGroup?: ReportingConfig["requireCostReportGroup"];
};

export type CostReportFormData = {
  costReportGroup: LeaseTemplate["costReportGroup"];
  costReportGroupEnabled: boolean;
  selectedCostReportGroup?: { label: string; value: string };
};

export const CostReportForm = ({
  costReportGroup,
  onSubmit,
  onCancel,
  isUpdating,
  costReportGroups,
  requireCostReportGroup,
}: CostReportFormProps) => {
  const handleSubmit = (data: any) => {
    const finalCostReportGroup = data.costReportGroupEnabled
      ? data.selectedCostReportGroup.value
      : undefined;

    return onSubmit({
      costReportGroup: finalCostReportGroup,
    });
  };

  const getInitialValues = () => {
    const hasExistingGroup =
      costReportGroup && costReportGroups?.includes(costReportGroup);

    return {
      costReportGroupEnabled: !!costReportGroup,
      selectedCostReportGroup: hasExistingGroup
        ? { label: costReportGroup, value: costReportGroup }
        : undefined,
    };
  };

  return (
    <Form
      insideTab
      isSubmitting={isUpdating}
      onCancel={onCancel}
      onSubmit={handleSubmit}
      initialValues={getInitialValues()}
      validate={(data) => {
        const formValues = data as CostReportFormData;
        const errors: Record<string, string> = {};

        if (requireCostReportGroup && !formValues.costReportGroupEnabled) {
          errors.costReportGroupEnabled = "Cost report group is required.";
        }

        if (
          formValues.costReportGroupEnabled &&
          !formValues.selectedCostReportGroup
        ) {
          errors.selectedCostReportGroup = "Please select a cost report group";
        }

        return Object.keys(errors).length > 0 ? errors : undefined;
      }}
      schema={{
        submitLabel: "Update Cost Report Group",
        fields: costReportFields({
          costReportGroups: costReportGroups,
          requireCostReportGroup: requireCostReportGroup,
        }).fields,
      }}
    />
  );
};
