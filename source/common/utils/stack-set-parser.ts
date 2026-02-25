// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

function extractServiceFromResourceType(
  resourceType: string | null,
): string | null {
  if (!resourceType) {
    return null;
  }

  if (resourceType.startsWith("AWS::")) {
    const parts = resourceType.split("::");
    if (parts[1] === "EC2") {
      if (parts[2] === "VPC") return "VPC";
      if (parts[2] === "TransitGateway") return "TransitGateway";
    }
    return parts[1] ?? null;
  }

  if (resourceType.startsWith("Custom::")) {
    return "CustomResource";
  }

  return null;
}

export function getCloudFormationTemplateServices(
  resourceTypes: string[],
): Record<string, number> {
  const serviceCounts: Record<string, number> = {};

  for (const resourceType of resourceTypes) {
    const service = extractServiceFromResourceType(resourceType);
    if (service) {
      serviceCounts[service] = (serviceCounts[service] || 0) + 1;
    }
  }

  return serviceCounts;
}
