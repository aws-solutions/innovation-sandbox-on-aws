// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";

import {
  LeaseTemplate,
  Visibility,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { basicFormFields } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/formFields/basic";

export const generateBreadcrumb = (
  query: UseQueryResult<LeaseTemplate | undefined, unknown>,
) => {
  const { data: leaseTemplate, isLoading, isError } = query;

  const breadcrumbItems = [
    { text: "Home", href: "/" },
    { text: "Lease Templates", href: "/lease_templates" },
  ];

  if (isLoading) {
    breadcrumbItems.push({ text: "Loading...", href: "#" });
    return breadcrumbItems;
  }

  if (isError || !leaseTemplate) {
    breadcrumbItems.push({ text: "Error", href: "#" });
    return breadcrumbItems;
  }

  breadcrumbItems.push({
    text: leaseTemplate.name,
    href: `/lease_templates/edit/${leaseTemplate?.uuid}`,
  });

  return breadcrumbItems;
};

/**
 * Gets the visibility option object for form initialization
 * @param visibility - The visibility value ("PUBLIC" or "PRIVATE")
 * @returns The complete option object with label and value
 */
export const getVisibilityOption = (visibility: Visibility) => {
  const visibilityField = basicFormFields().fields.find(
    (field) => field.name === "visibility",
  );
  return visibilityField?.options?.find(
    (option: any) => option.value === visibility,
  );
};
