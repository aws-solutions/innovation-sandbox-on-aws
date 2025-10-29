// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { componentTypes, validatorTypes } from "@aws-northstar/ui";
import { Alert, Box } from "@cloudscape-design/components";

export const basicFormFields = () => ({
  name: "basic",
  title: "Basic Details",
  fields: [
    {
      component: componentTypes.TEXT_FIELD,
      name: "name",
      label: "Name",
      isRequired: true,
      validate: [
        {
          type: validatorTypes.REQUIRED,
          message: "Please enter a name for this lease template",
        },
      ],
    },
    {
      component: componentTypes.TEXTAREA,
      name: "description",
      label: "Description",
      description: "Optional",
    },
    {
      component: componentTypes.SELECT,
      name: "visibility",
      label: "Visibility",
      description: "Controls who can see and use this lease template",
      isRequired: true,
      options: [
        {
          label:
            "Private - Hidden from users, visible only to admins and managers",
          value: "PRIVATE",
        },
        {
          label: "Public - Visible to all users",
          value: "PUBLIC",
        },
      ],
      validate: [
        {
          type: validatorTypes.REQUIRED,
          message: "Please select a visibility setting",
        },
      ],
    },
    {
      component: componentTypes.SWITCH,
      name: "requiresApproval",
      label: "Approval required",
    },
    {
      component: componentTypes.PLAIN_TEXT,
      name: "warning",
      label: (
        <Box data-inline-block>
          <Alert type="warning">
            When a user requests this lease template, an account will
            automatically be provided to the user if one is available in the
            account pool.
          </Alert>
        </Box>
      ),
      condition: {
        not: {
          when: "requiresApproval",
          is: true,
        },
        then: {
          visible: true,
        },
      },
    },
  ],
});
