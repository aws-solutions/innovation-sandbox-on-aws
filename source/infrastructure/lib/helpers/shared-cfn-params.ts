// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

import { ParameterWithLabel } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";

export class NamespaceParam extends ParameterWithLabel {
  constructor(scope: Construct) {
    super(scope, "Namespace", {
      label: "Namespace",
      description:
        "The namespace for this deployment of Innovation Sandbox (must be the same for all member stacks)." +
        " Alphanumeric characters of length between 3 and 8",
      default: "myisb",
      allowedPattern: "^[0-9a-zA-Z]{3,8}$",
    });
    this.overrideLogicalId("Namespace");
  }
}

export class HubAccountIdParam extends ParameterWithLabel {
  constructor(scope: Construct) {
    super(scope, "HubAccountId", {
      label: "Hub Account Id",
      description:
        "The AWS Account Id where the Innovation Sandbox hub application is (to be) deployed",
      allowedPattern: "^[0-9]{12}$",
    });
    this.overrideLogicalId("HubAccountId");
  }
}

export class OrgMgtAccountIdParam extends ParameterWithLabel {
  constructor(scope: Construct) {
    super(scope, "OrgMgtAccountId", {
      label: "Org Management Account Id",
      description:
        "The AWS Account Id of the org's management account where the account pool stack is deployed",
      allowedPattern: "^[0-9]{12}$",
    });
    this.overrideLogicalId("OrgMgtAccountId");
  }
}

export class IdcAccountIdParam extends ParameterWithLabel {
  constructor(scope: Construct) {
    super(scope, "IdcAccountId", {
      label: "IDC Account Id",
      description:
        "The AWS Account Id where the IAM Identity Center is configured",
      allowedPattern: "^[0-9]{12}$",
    });
    this.overrideLogicalId("IdcAccountId");
  }
}
