// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import { ApplicationInsights } from "@amzn/innovation-sandbox-infrastructure/components/observability/app-insights";
import {
  addParameterGroup,
  ParameterWithLabel,
  YesNoParameter,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  IdcAccountIdParam,
  NamespaceParam,
  OrgMgtAccountIdParam,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import {
  getSharedSsmParamValues,
  SharedSpokeConfig,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-ssm-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import fs from "fs";
import path from "path";

export class IsbComputeStack extends Stack {
  public static sharedSpokeConfig: SharedSpokeConfig;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* solution input parameters go here*/
    const namespaceParam = new NamespaceParam(this);

    const orgMgtAccountId = new OrgMgtAccountIdParam(this);

    const idcAccountId = new IdcAccountIdParam(this);

    const allowListedCidr = new ParameterWithLabel(
      this,
      "AllowListedIPRanges",
      {
        type: "CommaDelimitedList",
        label: "Allow Listed IP Ranges",
        description:
          "Comma separated list of CIDR ranges that allow access to the API. To allow all the entire internet, leave" +
          " the default 0.0.0.0/1,128.0.0.0/1",
        default: "0.0.0.0/1,128.0.0.0/1",
        allowedPattern:
          "^((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2]))(\\s*,\\s*((\\d{1,3}\\.){3}\\d{1,3}/([0-9]|[1-2][0-9]|3[0-2])))*$",
      },
    );

    const useStableTagging = new YesNoParameter(this, "UseStableTagging", {
      label: "Use Stable Tagging",
      description:
        "Automatically use the most up to date and secure account cleaner image up until the next minor release. Selecting 'No' will pull the image as originally released, without any security updates.",
      default: "Yes",
    });

    const acceptTerms = new ParameterWithLabel(
      this,
      "AcceptSolutionTermsOfUse",
      {
        label: "Accept Solution Terms of Use",
        description: fs.readFileSync(
          path.join(__dirname, "assets/terms-of-use.txt"),
          "utf-8",
        ),
        allowedPattern: "^Accept$",
        constraintDescription:
          'You must enter "Accept" to deploy this template',
      },
    );

    addParameterGroup(this, {
      label: "Compute Stack Configuration",
      parameters: [
        namespaceParam,
        orgMgtAccountId,
        idcAccountId,
        allowListedCidr,
        useStableTagging,
        acceptTerms,
      ],
    });

    IsbComputeStack.sharedSpokeConfig = getSharedSsmParamValues(
      this,
      namespaceParam.valueAsString,
      idcAccountId.valueAsString,
      orgMgtAccountId.valueAsString,
    );

    new IsbComputeResources(this, {
      namespace: namespaceParam.valueAsString,
      orgMgtAccountId: orgMgtAccountId.valueAsString,
      idcAccountId: idcAccountId.valueAsString,
      allowListedCidr: allowListedCidr.valueAsList,
      useStableTaggingParameter: useStableTagging,
    });

    new ApplicationInsights(this, "IsbApplicationInsights", {
      namespace: namespaceParam.valueAsString,
    });

    applyIsbTag(this, `${namespaceParam.valueAsString}`);
  }
}
