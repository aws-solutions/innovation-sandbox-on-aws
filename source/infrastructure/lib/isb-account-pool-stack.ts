// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  addParameterGroup,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  HubAccountIdParam,
  NamespaceParam,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbAccountPoolResources } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-resources";

export class IsbAccountPoolStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* solution input parameters go here*/

    const namespaceParam = new NamespaceParam(this);

    const hubAccountIdParam = new HubAccountIdParam(this);

    const parentOuId = new ParameterWithLabel(this, "ParentOuId", {
      label: "Parent OU Id",
      description:
        "Provide Root id or organization unit id where Innovation Sandbox OUs will be created",
      allowedPattern: "^(r-[0-9a-z]{4,32})|(ou-[0-9a-z]{4,32}-[a-z0-9]{8,32})$",
    });

    const isbManagedRegions = new ParameterWithLabel(
      this,
      "IsbManagedRegions",
      {
        type: "CommaDelimitedList",
        label: "ISB Managed Regions",
        description:
          "Provide list of AWS Regions to limit the use to specific regions.",
        allowedPattern:
          "^[a-z]{2}(-[a-z]+-\\d{1})(,[ ]*[a-z]{2}(-[a-z]+-\\d{1}))*$",
        constraintDescription:
          "Must be a comma-separated list of valid AWS Region codes, e.g., us-east-1,eu-west-1",
      },
    );

    addParameterGroup(this, {
      label: "AccountPool Stack Configuration",
      parameters: [
        namespaceParam,
        hubAccountIdParam,
        parentOuId,
        isbManagedRegions,
      ],
    });

    new IsbAccountPoolResources(this, {
      namespace: namespaceParam.valueAsString,
      parentOuId: parentOuId.valueAsString,
      hubAccountId: hubAccountIdParam.valueAsString,
      isbManagedRegions: isbManagedRegions.valueAsList,
      synthesizer: props?.synthesizer,
    });

    applyIsbTag(this, `${namespaceParam.valueAsString}`);
  }
}
