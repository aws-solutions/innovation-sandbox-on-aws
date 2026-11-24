// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { ReviewForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewForm";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { adminConfigGetHandler } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { mockBasicLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("ReviewForm", () => {
  // A template with both features turned on, so the global switches alone
  // decide what each row shows.
  const serveTemplate = () =>
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leaseTemplates/${mockBasicLeaseTemplate.uuid}`,
        () =>
          HttpResponse.json({
            status: "success",
            data: {
              ...mockBasicLeaseTemplate,
              allowOwnerToShareLease: true,
              sandboxSpacesEnabled: true,
            },
          }),
      ),
    );

  const renderReview = () =>
    renderWithQueryClient(
      <ReviewForm data={{ leaseTemplateUuid: mockBasicLeaseTemplate.uuid }} />,
    );

  it("groups sharing and permission sets and shows disabled features as overridden", async () => {
    serveTemplate();
    server.use(
      adminConfigGetHandler(
        createConfiguration({
          leases: { leaseSharingEnabled: false },
          agent: { sandboxSpacesEnabled: false },
        }),
      ),
    );

    renderReview();

    await waitFor(() => {
      expect(screen.getAllByText("Disabled (overridden)")).toHaveLength(2);
    });
    expect(screen.getByText("Sandbox Spaces")).toBeInTheDocument();
    expect(screen.getByText("Access settings")).toBeInTheDocument();
    expect(screen.getByText("Lease sharing")).toBeInTheDocument();
    expect(screen.getByText("Permission sets")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("shows both as Enabled when they are on globally", async () => {
    serveTemplate();
    server.use(
      adminConfigGetHandler(
        createConfiguration({
          leases: { leaseSharingEnabled: true },
          agent: { sandboxSpacesEnabled: true },
        }),
      ),
    );

    renderReview();

    await waitFor(() => {
      expect(screen.getAllByText("Enabled")).toHaveLength(2);
    });
    expect(screen.queryByText("Disabled (overridden)")).not.toBeInTheDocument();
  });
});
