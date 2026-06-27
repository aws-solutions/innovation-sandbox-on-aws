// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnCondition, Fn } from "aws-cdk-lib";
import { Construct } from "constructs";

import { ParameterWithLabel } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";

/**
 * Encapsulates optional custom domain CloudFormation parameters.
 * When all three values are provided, the CloudFront distribution will be configured
 * with the custom domain name, the ACM certificate, and a Route53 alias record.
 *
 * All parameters default to empty string, making this configuration entirely optional.
 */
export class CustomDomainParameter {
  public readonly domainNameParam: ParameterWithLabel;
  public readonly hostedZoneIdParam: ParameterWithLabel;
  public readonly certificateArnParam: ParameterWithLabel;
  public readonly isCustomDomainConfigured: CfnCondition;

  constructor(scope: Construct) {
    this.domainNameParam = new ParameterWithLabel(scope, "CustomDomainName", {
      type: "String",
      label: "Custom Domain Name",
      description:
        "The fully qualified domain name (FQDN) for the ISB (e.g. isb.edgez.live). " +
        "Leave empty to use the default CloudFront domain.",
      default: "",
    });

    this.hostedZoneIdParam = new ParameterWithLabel(
      scope,
      "CustomDomainHostedZoneId",
      {
        type: "String",
        label: "Route53 Hosted Zone ID",
        description:
          "The Route53 Hosted Zone ID for the custom domain. " +
          "Leave empty if not using a custom domain.",
        default: "",
      },
    );

    this.certificateArnParam = new ParameterWithLabel(
      scope,
      "CustomDomainCertificateArn",
      {
        type: "String",
        label: "ACM Certificate ARN (us-east-1)",
        description:
          "The ARN of the ACM certificate in us-east-1 for the custom domain " +
          "(e.g. a wildcard certificate *.isb.edgez.live). Leave empty if not using a custom domain.",
        default: "",
      },
    );

    this.isCustomDomainConfigured = new CfnCondition(
      scope,
      "IsCustomDomainConfigured",
      {
        expression: Fn.conditionAnd(
          Fn.conditionNot(
            Fn.conditionEquals(this.domainNameParam.valueAsString, ""),
          ),
          Fn.conditionNot(
            Fn.conditionEquals(this.hostedZoneIdParam.valueAsString, ""),
          ),
          Fn.conditionNot(
            Fn.conditionEquals(this.certificateArnParam.valueAsString, ""),
          ),
        ),
      },
    );
  }
}
