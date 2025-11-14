// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config";
import { componentTypes, validatorTypes } from "@aws-northstar/ui";
import { FormField } from "@cloudscape-design/components";

interface CostReportFieldsProps {
  costReportGroups?: ReportingConfig["costReportGroups"];
  requireCostReportGroup?: ReportingConfig["requireCostReportGroup"];
}

const getCostReportOptions = (
  costReportGroups?: ReportingConfig["costReportGroups"],
) => {
  if (!costReportGroups || costReportGroups.length === 0) {
    return [
      {
        label:
          "No cost report groups available. Please contact your administrator.",
        value: "",
        disabled: true,
      },
    ];
  }
  return costReportGroups.map((group) => ({
    label: group,
    value: group,
  }));
};

export const costReportFields = (props?: CostReportFieldsProps) => ({
  name: "costReport",
  title: "Cost Report",
  fields: [
    {
      component: componentTypes.RADIO,
      name: "costReportGroupEnabled",
      label: <FormField label="Cost Report Group" />,
      showError: true,
      options: [
        {
          label: "Do not set a cost report group",
          value: false,
        },
        {
          label: "Set cost report group",
          value: true,
        },
      ],
      validate: [
        {
          type: validatorTypes.REQUIRED,
          message: "Please select an option",
        },
      ],
    },
    {
      component: componentTypes.SELECT,
      name: "selectedCostReportGroup",
      label: <FormField label="Select cost report group" />,
      showError: true,
      options: getCostReportOptions(props?.costReportGroups),
      validate: [
        (value: string, allValues: any) => {
          if (allValues.costReportGroupEnabled) {
            if (
              !props?.costReportGroups ||
              props.costReportGroups.length === 0
            ) {
              return "No cost report groups available. Please contact your administrator.";
            }
            if (!value) {
              return "Please select a cost report group";
            }
          }
          return undefined;
        },
      ],
      condition: {
        when: "costReportGroupEnabled",
        is: true,
        then: {
          visible: true,
        },
      },
    },
  ],
});
