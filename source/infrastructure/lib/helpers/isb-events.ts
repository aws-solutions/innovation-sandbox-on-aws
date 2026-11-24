// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";

export function getIsbEventBusName(namespace: string): string {
  return `${namespace}-ISBEventBus`;
}

export function getIsbEventBusArn(
  scope: Construct,
  namespace: string,
  accountId: string,
): string {
  return Stack.of(scope).formatArn({
    service: "events",
    account: accountId,
    resource: "event-bus",
    resourceName: getIsbEventBusName(namespace),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

export function getPermissionSetEventsForwarderName(namespace: string): string {
  return `${namespace}-PermissionSetEventsForwarder`;
}

export function getPermissionSetEventsForwarderArn(
  scope: Construct,
  namespace: string,
  accountId: string,
): string {
  return Stack.of(scope).formatArn({
    service: "events",
    account: accountId,
    resource: "rule",
    resourceName: getPermissionSetEventsForwarderName(namespace),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}
