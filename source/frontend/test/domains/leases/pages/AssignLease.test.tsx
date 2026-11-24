// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AssignLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/AssignLease";
import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  mockAdvancedLeaseTemplate,
  mockBasicLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  ApiPaginatedResult,
  ApiResponse,
} from "@amzn/innovation-sandbox-frontend/types";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const mockNavigate = vi.fn();
const ownerPrincipalId = "11111111-1111-4111-8111-111111111111";
const sharedPrincipalId = "22222222-2222-4222-8222-222222222222";
const groupPrincipalId = "33333333-3333-4333-8333-333333333333";
const developerPermissionSet: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  availability: "AVAILABLE",
};
const auditorPermissionSet: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AuditorAccess",
  availability: "AVAILABLE",
};
const hydratedBasicLeaseTemplate: LeaseTemplateView = {
  ...mockBasicLeaseTemplate,
  defaultPermissionSet: developerPermissionSet,
  allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

// Stub PrincipalTypeahead with deterministic fixture buttons so tests can
// drive selection without wrestling with Cloudscape Autosuggest in jsdom.
// The real typeahead has its own test file.
const TYPEAHEAD_FIXTURE = [
  {
    principalId: ownerPrincipalId,
    principalType: "USER" as const,
    displayName: "Test User",
    email: "user@example.com",
  },
  {
    principalId: sharedPrincipalId,
    principalType: "USER" as const,
    displayName: "Shared User",
    email: "shared@example.com",
  },
  {
    principalId: groupPrincipalId,
    principalType: "GROUP" as const,
    displayName: "Engineering",
  },
];
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead",
  () => ({
    PrincipalTypeahead: ({
      onSelect,
      shouldExclude = () => false,
      type = "all",
    }: {
      onSelect: (p: (typeof TYPEAHEAD_FIXTURE)[number]) => void;
      shouldExclude?: (p: (typeof TYPEAHEAD_FIXTURE)[number]) => boolean;
      type?: "users" | "groups" | "all";
    }) => (
      <div data-testid="typeahead-stub">
        {TYPEAHEAD_FIXTURE.filter(
          (p) =>
            !shouldExclude(p) &&
            (type === "all" ||
              (type === "users" && p.principalType === "USER") ||
              (type === "groups" && p.principalType === "GROUP")),
        ).map((p) => (
          <button key={p.principalId} type="button" onClick={() => onSelect(p)}>
            Pick {p.email ?? p.displayName}
          </button>
        ))}
      </div>
    ),
  }),
);

describe("AssignLease", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <AssignLease />
      </Router>,
    );

  // Drive the user-selection step via the mocked typeahead.
  const pickUser = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole("button", { name: "Pick user@example.com" }),
    );
  };

  const selectPermissionSet = async (
    displayName: string,
    permissionSetArn: string,
  ) => {
    const row = (await screen.findByText(displayName)).closest("tr")!;
    const select = createWrapper(row).findSelect()!;
    select.openDropdown();
    select.selectOptionByValue(permissionSetArn, {
      expandToViewport: true,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leaseTemplates/${mockBasicLeaseTemplate.uuid}`,
        () =>
          HttpResponse.json({
            status: "success",
            data: hydratedBasicLeaseTemplate,
          }),
      ),
    );
  });

  // Get mocked functions
  const mockedShowSuccessToast = vi.mocked(showSuccessToast);
  const mockedShowErrorToast = vi.mocked(showErrorToast);

  test("renders the assign lease form with correct title and description", async () => {
    renderComponent();

    expect(await screen.findByText("Assign lease")).toBeInTheDocument();
    expect(
      screen.getByText("Create a lease assignment for another user."),
    ).toBeInTheDocument();
  });

  test("correctly renders the wizard with all steps", async () => {
    renderComponent();

    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(2, "disabled")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(3, "disabled")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(4, "disabled")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(5, "disabled")).not.toBeNull();
    });

    // Check step titles using wizard navigation
    const wizard = createWrapper().findWizard();
    expect(
      wizard?.findMenuNavigationLink(1)?.getElement().textContent,
    ).toContain("Select lease template");
    expect(
      wizard?.findMenuNavigationLink(2)?.getElement().textContent,
    ).toContain("Select user");
    expect(
      wizard?.findMenuNavigationLink(3)?.getElement().textContent,
    ).toContain("Configure access");
    expect(
      wizard?.findMenuNavigationLink(4)?.getElement().textContent,
    ).toContain("Terms of Service");
    expect(
      wizard?.findMenuNavigationLink(5)?.getElement().textContent,
    ).toContain("Review & Submit");
  });

  test("displays the lease templates in step 1", async () => {
    renderComponent();

    await waitFor(() => {
      const cards = createWrapper().findCards();
      expect(cards?.findItems()).toHaveLength(2);

      const cardHeaders = cards
        ?.findItems()
        .map((item) => item.findCardHeader()?.getElement().textContent);
      expect(cardHeaders).toContain(mockBasicLeaseTemplate.name);
      expect(cardHeaders).toContain(mockAdvancedLeaseTemplate.name);
    });

    expect(
      screen.getByText(
        "What lease template would you like to use for this assignment?",
      ),
    ).toBeInTheDocument();
  });

  test("prevents navigation to next step without selecting a template", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Should show error and stay on step 1
    expect(
      screen.getAllByText("You must choose a lease template").length,
    ).toBeGreaterThan(0);

    const wizard = createWrapper().findWizard();
    expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
  });

  test("allows navigation to step 2 after selecting a template", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    // Select a lease template
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Should navigate to step 2
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(2, "active")).not.toBeNull();
    });
  });

  test("step 2 requires a user before advancing", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 2
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Try to proceed without picking a user — wizard should stay on step 2.
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(
      createWrapper().findWizard()?.findMenuNavigationLink(2, "active"),
    ).not.toBeNull();
    expect(
      screen.getByText("You must provide a valid user"),
    ).toBeInTheDocument();

    // Pick a user — wizard advances to step 3.
    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(3, "active")).not.toBeNull();
    });
  });

  test("waits for the selected template before configuring access", async () => {
    const user = userEvent.setup();
    let finishLoadingTemplate: (() => void) | undefined;
    const templateLoading = new Promise<void>((resolve) => {
      finishLoadingTemplate = resolve;
    });

    server.use(
      http.get(
        `${getConfig().ApiUrl}/leaseTemplates/${mockBasicLeaseTemplate.uuid}`,
        async () => {
          await templateLoading;
          return HttpResponse.json({
            status: "success",
            data: hydratedBasicLeaseTemplate,
          });
        },
      ),
    );

    renderComponent();

    await user.click(await screen.findByText(mockBasicLeaseTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));
    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    expect(
      await screen.findByText("Loading permission sets..."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("typeahead-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await act(async () => {
      finishLoadingTemplate?.();
      await templateLoading;
    });

    expect(await screen.findByTestId("typeahead-stub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  test("validates terms acceptance in step 4", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 4 (ToS)
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Skip Configure access step
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Try to proceed without accepting terms
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(
      screen.getAllByText("You must accept the terms of service to continue")
        .length,
    ).toBeGreaterThan(0);

    // Accept terms
    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Should navigate to step 5 (Review)
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(5, "active")).not.toBeNull();
    });
  });

  test("displays review information in step 5", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate through all steps
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Skip Configure access step
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Check review step content
    expect(screen.getAllByText("Review & Submit")).toHaveLength(3);
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter any additional comments..."),
    ).toBeInTheDocument();
  });

  test("submits the form successfully and navigates", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, async ({ request }) => {
        const body = (await request.json()) as {
          userEmail: string;
          leaseTemplateUuid: string;
          comments: string;
        };

        expect(body.userEmail).toBe("user@example.com");
        expect(body.leaseTemplateUuid).toBe(mockBasicLeaseTemplate.uuid);
        expect(body.comments).toBe("Test comments");

        return HttpResponse.json({
          status: "success",
          data: {
            uuid: "new-lease-uuid",
            userEmail: body.userEmail,
            status: "Active",
            awsAccountId: "123456789012",
          },
        });
      }),
    );

    renderComponent();

    // Complete the wizard
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Skip Configure access step
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const commentsTextarea = screen.getByPlaceholderText(
      "Enter any additional comments...",
    );
    await user.type(commentsTextarea, "Test comments");

    // Submit the form
    const submitButton = await screen.findByRole("button", {
      name: /assign lease/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Lease has been assigned to user@example.com.",
      );
    });
  });

  test("handles form submission error", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "API Error" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    // Complete the wizard
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Skip Configure access step
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Submit the form
    const submitButton = await screen.findByRole("button", {
      name: /assign lease/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockedShowErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to submit lease assignment"),
      );
    });
  });

  test("allows navigation backwards through steps", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 2
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Navigate back to step 1
    const previousButton = await screen.findByRole("button", {
      name: /previous/i,
    });
    await user.click(previousButton);

    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
    });
  });

  test("handles cancel action", async () => {
    const user = userEvent.setup();
    renderComponent();

    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  test("displays error when no lease templates are available", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        const response: ApiResponse<ApiPaginatedResult<LeaseTemplateView>> = {
          status: "success",
          data: {
            result: [],
            nextPageIdentifier: null,
          },
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No lease templates configured."),
      ).toBeInTheDocument();
    });
  });

  test("clears validation errors when user corrects input", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Try to proceed without selecting template
    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    expect(
      screen.getAllByText("You must choose a lease template").length,
    ).toBeGreaterThan(0);

    // Select template - error should clear
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    expect(
      screen.queryByText("You must choose a lease template"),
    ).not.toBeInTheDocument();
  });

  test("submits the permission sets selected while configuring access", async () => {
    const user = userEvent.setup();

    let postBody:
      | {
          userEmail: string;
          leaseTemplateUuid: string;
          assignments?: Array<{
            principalId: string;
            principalType: "USER" | "GROUP";
            permissionSetArn: string;
          }>;
        }
      | undefined;
    server.use(
      http.post(`${getConfig().ApiUrl}/leases`, async ({ request }) => {
        postBody = (await request.json()) as typeof postBody;
        return HttpResponse.json({ status: "success" }, { status: 200 });
      }),
    );

    renderComponent();

    // Step 1: pick a template.
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    await user.click(screen.getByText(mockBasicLeaseTemplate.name));
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 2: pick the lease owner.
    await pickUser(user);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 3: Configure access. The wizard should be on this step now.
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(3, "active")).not.toBeNull();
    });
    // Stage one extra principal.
    await user.click(
      await screen.findByRole("button", { name: "Pick shared@example.com" }),
    );
    await selectPermissionSet(
      "Shared User",
      auditorPermissionSet.permissionSetArn,
    );
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 4: ToS.
    await user.click(
      screen.getByLabelText(
        "I accept the above terms of service on behalf of the assigned user.",
      ),
    );
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Step 5: Submit.
    await user.click(
      await screen.findByRole("button", { name: /assign lease/i }),
    );

    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody?.userEmail).toBe("user@example.com");
    expect(postBody?.assignments).toEqual([
      {
        principalId: ownerPrincipalId,
        principalType: "USER",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
      {
        principalId: sharedPrincipalId,
        principalType: "USER",
        permissionSetArn: auditorPermissionSet.permissionSetArn,
      },
    ]);
    // Display fields are stripped — backend POST body schema is .strict().
    for (const assignment of postBody?.assignments ?? []) {
      expect(assignment).not.toHaveProperty("displayName");
      expect(assignment).not.toHaveProperty("email");
    }
  });
});
