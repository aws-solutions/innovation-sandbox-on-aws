// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { UpdateLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/UpdateLeaseTemplate";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUseParams = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => mockUseParams(),
  };
});

describe("UpdateLeaseTemplate", () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ uuid: mockAdvancedLeaseTemplate.uuid });
    server.use(
      http.get(
        `${config.ApiUrl}/leaseTemplates/${mockAdvancedLeaseTemplate.uuid}`,
        () => {
          return HttpResponse.json({
            status: "success",
            data: mockAdvancedLeaseTemplate,
          });
        },
      ),
    );
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <UpdateLeaseTemplate />
      </Router>,
    );

  test("renders the component with correct structure", async () => {
    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const contentLayout = wrapper.findContentLayout();
      expect(contentLayout).not.toBeNull();

      const header = contentLayout!.findHeader();
      expect(header).not.toBeNull();
      expect(header!.getElement()).toHaveTextContent(
        mockAdvancedLeaseTemplate.name,
      );

      const tabs = wrapper.findTabs();
      expect(tabs).not.toBeNull();
      const tabLinks = tabs!.findTabLinks();
      expect(tabLinks).toHaveLength(4);
      expect(tabLinks[0].getElement()).toHaveTextContent("Basic Details");
      expect(tabLinks[1].getElement()).toHaveTextContent("Budget");
      expect(tabLinks[2].getElement()).toHaveTextContent("Duration");
      expect(tabLinks[3].getElement()).toHaveTextContent("Cost Report");
    });
  });

  test("handles error when fetching lease template fails", async () => {
    server.use(
      http.get(
        `${config.ApiUrl}/leaseTemplates/${mockAdvancedLeaseTemplate.uuid}`,
        () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch lease template" },
            { status: 500 },
          );
        },
      ),
    );

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const alert = wrapper.findAlert();
      expect(alert).not.toBeNull();
      expect(alert!.getElement()).toHaveTextContent(
        "There was a problem loading this lease template.",
      );
    });
  });
});
