// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import {
  generateBreadcrumb,
  getVisibilityOption,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/helpers";
import { createLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseTemplateFactory";

describe("leaseTemplates helpers", () => {
  describe("generateBreadcrumb", () => {
    it("should generate breadcrumb with loading state", () => {
      const mockQuery: UseQueryResult<LeaseTemplate | undefined, unknown> = {
        data: undefined,
        isLoading: true,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Lease Templates", href: "/lease_templates" },
        { text: "Loading...", href: "#" },
      ]);
    });

    it("should generate breadcrumb with error state", () => {
      const mockQuery: UseQueryResult<LeaseTemplate | undefined, unknown> = {
        data: undefined,
        isLoading: false,
        isError: true,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Lease Templates", href: "/lease_templates" },
        { text: "Error", href: "#" },
      ]);
    });

    it("should generate breadcrumb with lease template data", () => {
      const mockLeaseTemplate = createLeaseTemplate({
        name: "Test Lease Template",
        uuid: "test-uuid-123",
      });
      const mockQuery: UseQueryResult<LeaseTemplate | undefined, unknown> = {
        data: mockLeaseTemplate,
        isLoading: false,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Lease Templates", href: "/lease_templates" },
        {
          text: "Test Lease Template",
          href: "/lease_templates/edit/test-uuid-123",
        },
      ]);
    });

    it("should handle undefined lease template data", () => {
      const mockQuery: UseQueryResult<LeaseTemplate | undefined, unknown> = {
        data: undefined,
        isLoading: false,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Lease Templates", href: "/lease_templates" },
        { text: "Error", href: "#" },
      ]);
    });
  });

  describe("getVisibilityOption", () => {
    it("should return PUBLIC option when visibility is PUBLIC", () => {
      const result = getVisibilityOption("PUBLIC");

      expect(result).toEqual({
        label: "Public - Visible to all users",
        value: "PUBLIC",
      });
    });

    it("should return PRIVATE option when visibility is PRIVATE", () => {
      const result = getVisibilityOption("PRIVATE");

      expect(result).toEqual({
        label:
          "Private - Hidden from users, visible only to admins and managers",
        value: "PRIVATE",
      });
    });
  });
});
