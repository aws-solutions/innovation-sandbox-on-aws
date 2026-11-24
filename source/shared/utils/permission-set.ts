// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  permissionSetIdFromArn,
  permissionSetInstanceIdFromArn,
} from "../types/permission-set.js";

function identityCenterConsoleUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/singlesignon/home?region=${region}`;
}

export function permissionSetCatalogConsoleUrl(region: string): string {
  return `${identityCenterConsoleUrl(region)}#/permission-sets`;
}

export function permissionSetDetailsConsoleUrl(props: {
  region: string;
  permissionSetArn: string;
}): string {
  const permissionSetId = permissionSetIdFromArn(props.permissionSetArn);
  const instanceId = permissionSetInstanceIdFromArn(props.permissionSetArn);

  return permissionSetId && instanceId
    ? `${identityCenterConsoleUrl(props.region)}#/instances/${encodeURIComponent(instanceId)}/permission-sets/details/${encodeURIComponent(permissionSetId)}`
    : permissionSetCatalogConsoleUrl(props.region);
}
