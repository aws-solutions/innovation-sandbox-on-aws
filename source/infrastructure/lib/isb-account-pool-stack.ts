// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnCondition, Fn, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  addParameterGroup,
  OptionalListParameter,
  OptionalParameter,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  HubAccountIdParam,
  NamespaceParam,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { addIsbAccountPoolResources } from "@amzn/innovation-sandbox-infrastructure/isb-account-pool-resources";

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

    const accountPoolOuName = new OptionalParameter(this, "AccountPoolOuName", {
      label: "Account Pool OU Name (Optional)",
      description:
        "A custom name to provide for the top-level Innovation Sandbox account pool Organizational Unit (OU) (value if left empty: <namespace>_InnovationSandboxAccountPool). Changing this value on an existing deployment renames the live organizational unit in AWS Organizations (the OU ID is unchanged); update it deliberately.",
      valueIfEmpty: `${namespaceParam.valueAsString}_InnovationSandboxAccountPool`,
    });

    const isbManagedRegions = new ParameterWithLabel(
      this,
      "IsbManagedRegions",
      {
        type: "CommaDelimitedList",
        label: "ISB Managed Regions",
        description:
          "Comma-separated list of AWS Regions where sandbox accounts can run workloads. Enable an opt-in Region in the hub account and every sandbox account before you add it here, and in new accounts before you register them. After you change this list, update the Compute stack with a new ForceConfigurationUpdate value.",
        allowedPattern: String.raw`^[a-z]{2}(-[a-z]+-\d{1})(,[ ]*[a-z]{2}(-[a-z]+-\d{1}))*$`,
        constraintDescription:
          "Must be a comma-separated list of valid AWS Region codes, e.g., us-east-1,eu-west-1",
      },
    );

    const additionalAllowedServices = new ParameterWithLabel(
      this,
      "AdditionalAllowedServices",
      {
        type: "CommaDelimitedList",
        label: "Additional Allowed Services",
        default: "",
        description:
          "Optional comma-separated list of additional AWS service actions to allow in sandbox accounts. Actions that already exist in the default allowed list will appear as duplicates in the SCP, which has no effect. Refer to the Implementation Guide for the default list of supported services.",
        allowedPattern: String.raw`^$|^[a-zA-Z0-9-]+:[a-zA-Z0-9*]+(,\s*[a-zA-Z0-9-]+:[a-zA-Z0-9*]+)*$`,
        constraintDescription:
          "Must be empty or a comma-separated list of service:action patterns (e.g., sts:*,bedrock:*). Each entry must follow service:action format. Bare wildcards like *:* are not allowed.",
      },
    );

    const hasAdditionalAllowedServices = new CfnCondition(
      this,
      "HasAdditionalAllowedServices",
      {
        expression: Fn.conditionNot(
          Fn.conditionEquals(
            Fn.join("", additionalAllowedServices.valueAsList),
            "",
          ),
        ),
      },
    );

    const additionalPrincipalExceptions = new ParameterWithLabel(
      this,
      "AdditionalPrincipalExceptions",
      {
        type: "CommaDelimitedList",
        label: "Additional Principal Exceptions",
        default: "",
        description:
          "Optional comma-separated list of IAM role ARNs to exclude from SCP restrictions in sandbox accounts. Supports wildcard (*) at the end of role names. Do not use trailing commas, consecutive commas, or bare wildcards (arn:aws:iam::*:role/*).",
        // CloudFormation validates each CommaDelimitedList element individually against AllowedPattern.
        // This pattern validates a single ARN element (not the full comma-separated string).
        allowedPattern: String.raw`^$|^arn:aws:iam::[0-9*]+:role/[a-zA-Z0-9_+=,.@/-]*[a-zA-Z0-9_+=,.@-]+\*?$`,
        constraintDescription:
          "Must be empty or a valid IAM role ARN (e.g., arn:aws:iam::123456789012:role/MyRole,arn:aws:iam::*:role/ServiceRole*). A bare wildcard role name (arn:aws:iam::*:role/*) is not allowed. Do not use trailing or consecutive commas.",
      },
    );

    const bedrockInferenceProfilePatterns = new OptionalListParameter(
      this,
      "BedrockInferenceProfilePatterns",
      {
        label: "Bedrock Inference Profile Patterns",
        default: "arn:aws:bedrock:*:*:inference-profile/*",
        description:
          "Comma-separated list of Amazon Bedrock inference profile ARN patterns that the Region restriction SCP exempts, so cross-Region inference can reach Regions outside your managed Regions. The default, arn:aws:bedrock:*:*:inference-profile/*, allows all inference profiles. To allow fewer, list specific patterns, for example arn:aws:bedrock:*:*:inference-profile/us.* for US profiles and arn:aws:bedrock:*:*:inference-profile/global.* for global profiles. If you leave this parameter empty, the SCP blocks all cross-Region Bedrock inference, and Sandbox Spaces can't run models that use cross-Region inference profiles.",
        allowedPattern:
          "^$|^arn:aws:bedrock:[a-z0-9*-]+:[0-9*]+:inference-profile/[a-zA-Z0-9.*:_-]+$",
        constraintDescription:
          "Must be empty or a comma-separated list of Bedrock inference profile ARN patterns (e.g., arn:aws:bedrock:*:*:inference-profile/*). Each entry must include the inference-profile/ segment. Overly broad patterns like arn:aws:bedrock:*:*:* are not allowed.",
      },
    );

    // CommaDelimitedList with default "" produces [""] at deploy time.
    // Fn::Join("", [""]) → "" → condition correctly evaluates to false (no additions).
    const hasAdditionalPrincipalExceptions = new CfnCondition(
      this,
      "HasAdditionalPrincipalExceptions",
      {
        expression: Fn.conditionNot(
          Fn.conditionEquals(
            Fn.join("", additionalPrincipalExceptions.valueAsList),
            "",
          ),
        ),
      },
    );

    addParameterGroup(this, {
      label: "AccountPool Stack Configuration",
      parameters: [
        namespaceParam,
        hubAccountIdParam,
        parentOuId,
        accountPoolOuName,
        isbManagedRegions,
        additionalAllowedServices,
        additionalPrincipalExceptions,
        bedrockInferenceProfilePatterns,
      ],
    });

    addIsbAccountPoolResources(this, {
      namespace: namespaceParam.valueAsString,
      parentOuId: parentOuId.valueAsString,
      accountPoolOuName: accountPoolOuName.resolve(),
      hubAccountId: hubAccountIdParam.valueAsString,
      isbManagedRegions: isbManagedRegions.valueAsList,
      additionalAllowedServices: additionalAllowedServices.valueAsList,
      hasAdditionalAllowedServices,
      additionalPrincipalExceptions: additionalPrincipalExceptions.valueAsList,
      hasAdditionalPrincipalExceptions,
      bedrockInferenceProfilePatterns,
      synthesizer: props?.synthesizer,
    });

    applyIsbTag(this, `${namespaceParam.valueAsString}`);
  }
}
