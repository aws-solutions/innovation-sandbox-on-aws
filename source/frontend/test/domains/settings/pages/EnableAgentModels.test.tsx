// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useAgentModelCatalog,
  useAgentModelDiscovery,
  usePutAgentModelCatalogEntry,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { EnableAgentModels } from "@amzn/innovation-sandbox-frontend/domains/settings/pages/EnableAgentModels";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({
      status: "authenticated",
      user: {
        type: "user",
        email: "admin@example.com",
        userId: "a1",
        roles: ["Admin"],
      },
    }),
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

// Mock the hooks that make HTTP calls rather than going through MSW,
// matching the pattern used by other page tests.
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries",
  () => ({
    useAgentModelCatalog: vi.fn(),
    useAgentModelDiscovery: vi.fn(),
    usePutAgentModelCatalogEntry: vi.fn(),
    AGENT_MODEL_CATALOG_KEY: ["agentModelCatalog"],
  }),
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CATALOG_LAST_EDIT = "2026-09-01T00:00:00.000Z";

function makeAvailableModel(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "amazon.nova-lite-v1:0",
    displayName: "Amazon Nova Lite",
    provider: "Amazon",
    availability: "global",
    modelType: "foundation-model",
    pricingSource: "price-list",
    pricingRefreshedAt: new Date("2026-09-18T00:00:00.000Z"),
    inputPricePer1KTokens: 0.00006,
    outputPricePer1KTokens: 0.00024,
    cacheReadPricePer1KTokens: 0.000006,
    cacheWritePricePer1KTokens: 0.00006,
    ...overrides,
  };
}

function makeCatalogRow(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "amazon.nova-lite-v1:0",
    displayName: "Amazon Nova Lite",
    provider: "Amazon",
    availability: "global",
    enabled: true,
    addedAt: CATALOG_LAST_EDIT,
    lastSavedBy: "admin@example.com",
    meta: { createdTime: CATALOG_LAST_EDIT, lastEditTime: CATALOG_LAST_EDIT },
    ...overrides,
  };
}

const mockMutateAsync = vi.fn();

function setupMocks(
  options: {
    catalog?: unknown[];
    available?: unknown[];
    catalogEnabled?: boolean;
  } = {},
) {
  const catalog = options.catalog ?? [];
  const available = options.available ?? [makeAvailableModel()];

  vi.mocked(useAgentModelCatalog).mockReturnValue({
    data: catalog,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as any);

  vi.mocked(useAgentModelDiscovery).mockReturnValue({
    data: available,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as any);

  vi.mocked(usePutAgentModelCatalogEntry).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  } as any);
}

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: "/settings/sandbox-spaces/models/new",
        element: (
          <ModalProvider>
            <EnableAgentModels />
          </ModalProvider>
        ),
      },
      { path: "*", element: <div>navigated away</div> },
    ],
    { initialEntries: ["/settings/sandbox-spaces/models/new"] },
  );
  render(<RouterProvider router={router} />, {
    wrapper: createQueryClientWrapper(),
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMutateAsync.mockResolvedValue(makeCatalogRow());
  setupMocks();
});

describe("EnableAgentModels", () => {
  it("renders page title and info alert", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: /add sandbox spaces models/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/eligible models only/i)).toBeInTheDocument();
  });

  it("renders Cancel button", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
  });

  it("shows discovered models", async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Amazon Nova Lite")),
      ).toBeInTheDocument(),
    );
  });

  it("excludes models already enabled in the catalog", async () => {
    setupMocks({
      catalog: [
        makeCatalogRow({ modelId: "amazon.nova-lite-v1:0", enabled: true }),
      ],
      available: [
        makeAvailableModel({ modelId: "amazon.nova-lite-v1:0" }),
        makeAvailableModel({ modelId: "other", displayName: "Other Model" }),
      ],
    });

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Other Model")),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText((c) => c.includes("Amazon Nova Lite")),
    ).not.toBeInTheDocument();
  });

  it("shows disabled catalog models (can be re-enabled)", async () => {
    setupMocks({
      catalog: [
        makeCatalogRow({ modelId: "amazon.nova-lite-v1:0", enabled: false }),
      ],
      available: [makeAvailableModel({ modelId: "amazon.nova-lite-v1:0" })],
    });

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Amazon Nova Lite")),
      ).toBeInTheDocument(),
    );
  });

  it("lists a model with no price, and it cannot be selected", async () => {
    setupMocks({
      catalog: [],
      available: [
        makeAvailableModel({
          modelId: "unpriced.model",
          displayName: "Unpriced Model",
          pricingSource: undefined,
          pricingRefreshedAt: undefined,
          inputPricePer1KTokens: undefined,
          outputPricePer1KTokens: undefined,
          cacheReadPricePer1KTokens: undefined,
          cacheWritePricePer1KTokens: undefined,
        }),
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Unpriced Model")),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Price unavailable")).toBeInTheDocument();
    // The only selectable control besides the header's is the row's checkbox.
    const rowCheckbox = screen
      .getAllByRole("checkbox")
      .find((checkbox) =>
        checkbox.closest("tr")?.textContent?.includes("Unpriced"),
      );
    expect(rowCheckbox).toBeDisabled();
  });
  it("lets a priced model be selected while an unpriced one is disabled", async () => {
    setupMocks({
      catalog: [],
      available: [
        makeAvailableModel(),
        makeAvailableModel({
          modelId: "unpriced.model",
          displayName: "Unpriced Model",
          pricingSource: undefined,
          inputPricePer1KTokens: undefined,
          outputPricePer1KTokens: undefined,
        }),
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Unpriced Model")),
      ).toBeInTheDocument(),
    );
    const rowCheckbox = (name: string) =>
      screen
        .getAllByRole("checkbox")
        .find((checkbox) =>
          checkbox.closest("tr")?.textContent?.includes(name),
        )!;
    expect(rowCheckbox("Amazon Nova Lite")).toBeEnabled();
    expect(rowCheckbox("Unpriced Model")).toBeDisabled();
  });
  it("disables 'Enable selected models' until a row is selected", async () => {
    renderPage();
    await screen.findByRole("button", { name: /cancel/i });
    expect(
      screen.getByRole("button", { name: /enable selected models/i }),
    ).toBeDisabled();
  });

  it("calls upsert with enabled:true and no OCC token for a new model", async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Amazon Nova Lite")),
      ).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    await user.click(
      screen.getByRole("button", { name: /enable selected models/i }),
    );

    await screen.findByText(/review models to add/i);
    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedLastEditTime: expect.anything() }),
    );
  });

  it("re-enables a disabled catalog model with its OCC token", async () => {
    setupMocks({
      catalog: [
        makeCatalogRow({ modelId: "amazon.nova-lite-v1:0", enabled: false }),
      ],
      available: [makeAvailableModel({ modelId: "amazon.nova-lite-v1:0" })],
    });

    const user = userEvent.setup({ delay: null });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("Amazon Nova Lite")),
      ).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);
    await user.click(
      screen.getByRole("button", { name: /enable selected models/i }),
    );

    await screen.findByText(/review models to add/i);
    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        expectedLastEditTime: CATALOG_LAST_EDIT,
      }),
    );
  });
});
