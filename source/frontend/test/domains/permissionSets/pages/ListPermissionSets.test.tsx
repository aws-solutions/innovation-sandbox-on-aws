// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ListPermissionSets } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/pages/ListPermissionSets";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

import permissionSetsHelp from "../../../../public/markdown/permission-sets.md?raw";

const mockSetBreadcrumb = vi.fn();
const mockSetTools = vi.fn();
const mockSetToolsOpen = vi.fn();
const mockUseUser = vi.fn();

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => mockSetBreadcrumb,
}));

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserver;

const developerPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
  sessionDuration: "PT4H",
};

const analystPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AnalystAccess",
  description: "Read-only analytics access",
  sessionDuration: "PT2H",
};

function permissionSetResponse(
  result: (typeof developerPermissionSet)[],
  nextPageIdentifier?: string,
) {
  return HttpResponse.json({
    status: "success",
    data: { result, nextPageIdentifier },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ListPermissionSets", () => {
  const renderPage = () =>
    renderWithQueryClient(
      <BrowserRouter>
        <ListPermissionSets />
      </BrowserRouter>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({
      isAdmin: true,
      isManager: false,
      isUser: false,
    });
    vi.mocked(useAppLayoutContext).mockReturnValue({
      toolsOpen: false,
      setTools: mockSetTools,
      setToolsOpen: mockSetToolsOpen,
    });
  });

  it("renders the live catalog and specific IDC deep links", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("maxResults")).toBe("20");
        return permissionSetResponse([developerPermissionSet]);
      }),
    );

    renderPage();

    expect(
      screen.getByRole("heading", { name: "Permission Sets" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Developer sandbox access")).toBeVisible();
    expect(screen.getByText("PT4H")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /DeveloperAccess/ }),
    ).toHaveAttribute(
      "href",
      "https://us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1#/instances/1234567890abcdef/permission-sets/details/ps-0123456789abcdef",
    );
    const managePermissionSets = screen.getByRole("link", {
      name: "Manage permission sets",
    });
    expect(managePermissionSets).toHaveTextContent("Manage permission sets");
    expect(managePermissionSets).toHaveAttribute(
      "href",
      "https://us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1#/permission-sets",
    );
    expect(managePermissionSets).toHaveAttribute("target", "_blank");
  });

  it("does not render IDC console links for managers", async () => {
    mockUseUser.mockReturnValue({
      isAdmin: false,
      isManager: true,
      isUser: false,
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        permissionSetResponse([developerPermissionSet]),
      ),
    );

    renderPage();

    expect(await screen.findByText("DeveloperAccess")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /DeveloperAccess/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "Manage permission sets",
      }),
    ).not.toBeInTheDocument();
  });

  it("sends the filter to the API and renders the filtered result", async () => {
    const observedQueries: (string | null)[] = [];
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        observedQueries.push(query);
        return permissionSetResponse(
          query?.toLowerCase().includes("analyst")
            ? [analystPermissionSet]
            : [developerPermissionSet],
        );
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.type(
      screen.getByPlaceholderText("Find permission sets"),
      "analyst",
    );

    expect(await screen.findByText("AnalystAccess")).toBeVisible();
    expect(observedQueries).toEqual([null, "analyst"]);
  });

  it("bounds delayed search requests to the Smithy query limit", async () => {
    const observedQueries: string[] = [];
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        if (query) {
          observedQueries.push(query);
        }
        return permissionSetResponse([]);
      }),
    );
    const user = userEvent.setup();
    const oversizedQuery = "x".repeat(201);

    renderPage();
    await screen.findByText("No registered permission sets were found.");
    const filter = screen.getByPlaceholderText("Find permission sets");
    await user.click(filter);
    await user.paste(oversizedQuery);

    expect(filter).toHaveValue("x".repeat(200));
    await waitFor(() => expect(observedQueries).toEqual(["x".repeat(200)]));
  });

  it("paginates cursor pages without appending rows", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("pageIdentifier");
        return cursor === "cursor-2"
          ? permissionSetResponse([analystPermissionSet])
          : permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    expect(screen.getByText("(1+)")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    const pagination = createWrapper().findPagination();
    expect(pagination).not.toBeNull();
    await user.click(pagination!.findNextPageButton().getElement());

    expect(await screen.findByText("AnalystAccess")).toBeVisible();
    expect(screen.queryByText("DeveloperAccess")).not.toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeVisible();

    await user.click(pagination!.findPreviousPageButton().getElement());

    expect(await screen.findByText("DeveloperAccess")).toBeVisible();
    expect(screen.queryByText("AnalystAccess")).not.toBeInTheDocument();
  });

  it("shows table progress while loading the next page", async () => {
    const nextPageLoad = deferred();
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, async ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("pageIdentifier");
        if (cursor === "cursor-2") {
          await nextPageLoad.promise;
          return permissionSetResponse([analystPermissionSet]);
        }
        return permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.click(
      createWrapper().findPagination()!.findNextPageButton().getElement(),
    );

    await waitFor(() =>
      expect(
        createWrapper().findTable()!.findLoadingText()!.getElement(),
      ).toHaveTextContent("Loading permission sets..."),
    );

    await act(async () => nextPageLoad.resolve());
    expect(await screen.findByText("AnalystAccess")).toBeVisible();
  });

  it("starts a fresh cursor sequence when the page size changes", async () => {
    const observedRequests: {
      cursor: string | null;
      maxResults: string | null;
    }[] = [];
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const url = new URL(request.url);
        observedRequests.push({
          cursor: url.searchParams.get("pageIdentifier"),
          maxResults: url.searchParams.get("maxResults"),
        });
        return permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    const preferences = createWrapper()
      .findTable()!
      .findCollectionPreferences()!;
    await user.click(preferences.findTriggerButton().getElement());
    const modal = preferences.findModal()!;
    const fiftyRows = modal
      .findPageSizePreference()!
      .findOptions()
      .find((option) =>
        option.findLabel().getElement().textContent?.includes("50 rows"),
      )!;
    await user.click(fiftyRows.findNativeInput().getElement());
    await user.click(modal.findConfirmButton()!.getElement());

    await waitFor(() =>
      expect(observedRequests).toEqual([
        { cursor: null, maxResults: "20" },
        { cursor: null, maxResults: "50" },
      ]),
    );
    expect(
      createWrapper().findPagination()!.findCurrentPage().getElement(),
    ).toHaveTextContent("1");
  });

  it("returns to the first page when the filter changes", async () => {
    const observedQueries: (string | null)[] = [];
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("q");
        const cursor = url.searchParams.get("pageIdentifier");
        observedQueries.push(query);

        if (query === "analyst") {
          return permissionSetResponse([analystPermissionSet], "cursor-3");
        }
        return cursor === "cursor-2"
          ? permissionSetResponse([analystPermissionSet])
          : permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    const pagination = createWrapper().findPagination()!;
    await user.click(pagination.findNextPageButton().getElement());
    expect(await screen.findByText("AnalystAccess")).toBeVisible();
    expect(pagination.findCurrentPage().getElement()).toHaveTextContent("2");

    await user.type(
      screen.getByPlaceholderText("Find permission sets"),
      "analyst",
    );

    await waitFor(() =>
      expect(observedQueries).toEqual([null, null, "analyst"]),
    );
    expect(screen.getByText("AnalystAccess")).toBeVisible();
    expect(
      createWrapper().findPagination()!.findCurrentPage().getElement(),
    ).toHaveTextContent("1");
  });

  it("preserves loaded rows and reloads after a stale next-page cursor", async () => {
    let catalogLoads = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("pageIdentifier");
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            {
              status: "fail",
              data: {
                errors: [
                  {
                    field: "pageIdentifier",
                    message:
                      "The pagination token is invalid for this request.",
                  },
                ],
              },
            },
            { status: 400 },
          );
        }

        catalogLoads += 1;
        return permissionSetResponse(
          [developerPermissionSet],
          catalogLoads === 1 ? "cursor-2" : undefined,
        );
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.click(
      createWrapper().findPagination()!.findNextPageButton().getElement(),
    );

    expect(
      await screen.findByText(
        "The catalog changed while loading the next page.",
      ),
    ).toBeVisible();
    expect(screen.getByText("DeveloperAccess")).toBeVisible();
    expect(
      screen.getByPlaceholderText("Find permission sets"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload catalog" }));

    await waitFor(() => expect(catalogLoads).toBe(2));
    expect(
      screen.queryByText("The catalog changed while loading the next page."),
    ).not.toBeInTheDocument();
  });

  it("uses a generic message when loading the next page fails", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("pageIdentifier");
        return cursor === "cursor-2"
          ? HttpResponse.json(
              { status: "error", message: "Internal server error" },
              { status: 500 },
            )
          : permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.click(
      createWrapper().findPagination()!.findNextPageButton().getElement(),
    );

    expect(
      await screen.findByText("The next page could not be loaded."),
    ).toBeVisible();
    expect(
      screen.queryByText("The catalog changed while loading the next page."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("DeveloperAccess")).toBeVisible();
  });

  it("preserves loaded rows when a background refresh fails", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () => {
        requestCount += 1;
        return requestCount === 1
          ? permissionSetResponse([developerPermissionSet])
          : HttpResponse.json(
              { status: "error", message: "Internal server error" },
              { status: 500 },
            );
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.click(
      screen.getByRole("button", { name: "Refresh permission sets" }),
    );

    expect(
      await screen.findByText("The catalog could not be refreshed."),
    ).toBeVisible();
    expect(screen.getByText("DeveloperAccess")).toBeVisible();
  });

  it("disables pagination while a refresh is active", async () => {
    const refreshGate = deferred();
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, async () => {
        requestCount += 1;
        if (requestCount > 1) {
          await refreshGate.promise;
        }
        return permissionSetResponse([developerPermissionSet], "cursor-2");
      }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByText("DeveloperAccess");
    await user.click(
      screen.getByRole("button", { name: "Refresh permission sets" }),
    );

    await waitFor(() =>
      expect(
        createWrapper().findPagination()!.findNextPageButton().isDisabled(),
      ).toBe(true),
    );

    await act(async () => refreshGate.resolve());
  });

  it("renders loading and empty states", async () => {
    const initialLoad = deferred();
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, async () => {
        await initialLoad.promise;
        return permissionSetResponse([]);
      }),
    );

    renderPage();
    expect(
      createWrapper().findTable()?.findLoadingText()?.getElement(),
    ).toHaveTextContent("Loading permission sets...");

    await act(async () => initialLoad.resolve());
    expect(
      await screen.findByText("No registered permission sets were found."),
    ).toBeVisible();
  });

  it("renders an error state", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        HttpResponse.json(
          {
            status: "error",
            message: "Internal server error",
          },
          { status: 500 },
        ),
      ),
    );
    renderPage();

    expect(
      await screen.findByText(
        "Could not load permission sets. Please try again.",
      ),
    ).toBeVisible();
  });

  it("opens Permission Sets help from the heading icon", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        permissionSetResponse([]),
      ),
      http.get("/markdown/permission-sets.md", () =>
        HttpResponse.text(permissionSetsHelp),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const helpIcon = screen.getByRole("button", {
      name: "Learn about permission sets",
    });
    await user.click(helpIcon);
    expect(mockSetToolsOpen).toHaveBeenCalledWith(true);
    expect(mockSetTools).toHaveBeenLastCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ file: "permission-sets" }),
      }),
    );

    renderWithQueryClient(
      <BrowserRouter>{mockSetTools.mock.lastCall![0]}</BrowserRouter>,
    );
    expect(
      await screen.findByText(
        "View the permission sets that are registered for use with sandbox leases.",
      ),
    ).toBeVisible();
    expect(
      createWrapper().findHelpPanel()?.findHeader()?.getElement(),
    ).toHaveTextContent("Permission Sets");
    expect(createWrapper().findHelpPanel()?.getElement()).toHaveTextContent(
      "Manage permission sets",
    );
  });

  it("sets the page breadcrumb and help content", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        permissionSetResponse([]),
      ),
    );

    renderPage();

    await waitFor(() =>
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Permission Sets", href: "/permission-sets" },
      ]),
    );
    expect(mockSetTools).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ file: "permission-sets" }),
      }),
    );
  });
});
