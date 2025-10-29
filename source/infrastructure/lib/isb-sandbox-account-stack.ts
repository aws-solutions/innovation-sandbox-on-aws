// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  HubAccountIdParam,
  NamespaceParam,
} from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import { IsbSandboxAccountResources } from "@amzn/innovation-sandbox-infrastructure/isb-sandbox-account-resources";

export class IsbSandboxAccountStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const namespaceParam = new NamespaceParam(this);
    const hubAccountIdParam = new HubAccountIdParam(this);

    new IsbSandboxAccountResources(this, {
      hubAccountId: hubAccountIdParam.valueAsString,
      namespace: namespaceParam.valueAsString,
    });
  }
}
