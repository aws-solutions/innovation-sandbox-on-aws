// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PropsWithChildren } from "react";
import { FormProvider, useForm, useFormContext } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccessAndSharingForm,
  AccessAndSharingFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/AccessAndSharingForm";
import { AccessAndSharingValidationSchema } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  type PermissionSetReference,
} from "@amzn/innovation-sandbox-shared/types/permission-set";

const mockFetchNextPage = vi.fn();
const mockReloadCatalog = vi.fn();
const mockSubmit = vi.fn();
const mockUsePermissionSets = vi.fn();
const mockUseUser = vi.fn();
const mockCatalogByQuery = new Map<string, Record<string, unknown>>();

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/permissionSets/hooks",
  () => ({
    PERMISSION_SETS_QUERY_MAX_LENGTH: 200,
    usePermissionSets: (
      query: string,
      options: {
        enabled?: boolean;
        refetchOnMount?: boolean;
        refetchOnReconnect?: boolean;
        refetchOnWindowFocus?: boolean;
      },
    ) => mockUsePermissionSets(query, options),
  }),
);

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@cloudscape-design/components", async () => {
  const actual = await vi.importActual<
    typeof import("@cloudscape-design/components")
  >("@cloudscape-design/components");
  const { forwardRef } = await vi.importActual<typeof import("react")>("react");

  type Option = {
    value?: string;
    label?: string;
    disabled?: boolean;
  };
  type MockMultiselectProps = {
    selectedOptions: Option[];
    options: Option[];
    disabled?: boolean;
    onBlur?: () => void;
    onChange: (event: { detail: { selectedOptions: Option[] } }) => void;
    onLoadItems: (event: {
      detail: {
        filteringText: string;
        firstPage: boolean;
        samePage: boolean;
      };
    }) => void;
  };

  return {
    ...actual,
    Multiselect: forwardRef<HTMLDivElement, MockMultiselectProps>(
      (props, ref) => (
        <div ref={ref}>
          <div data-testid="selected-permission-sets">
            {props.selectedOptions.map((option) => option.value).join(",")}
          </div>
          <div data-testid="selected-option-states">
            {props.selectedOptions
              .map((option) => `${option.value}:${option.disabled ?? false}`)
              .join(",")}
          </div>
          {props.options.map((option) => {
            const isSelected = props.selectedOptions.some(
              (selected) => selected.value === option.value,
            );
            return (
              <button
                key={option.value}
                type="button"
                disabled={props.disabled || option.disabled}
                onClick={() =>
                  props.onChange({
                    detail: {
                      selectedOptions: isSelected
                        ? props.selectedOptions.filter(
                            (selected) => selected.value !== option.value,
                          )
                        : [...props.selectedOptions, option],
                    },
                  })
                }
              >
                {isSelected ? "Deselect" : "Select"} {option.label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={props.disabled}
            onClick={() =>
              props.onLoadItems({
                detail: {
                  filteringText: "auditor",
                  firstPage: true,
                  samePage: false,
                },
              })
            }
          >
            Search permission sets
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={() =>
              props.onLoadItems({
                detail: {
                  filteringText: "auditor",
                  firstPage: false,
                  samePage: false,
                },
              })
            }
          >
            Load more permission sets
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={() =>
              props.onLoadItems({
                detail: {
                  filteringText: "auditor",
                  firstPage: false,
                  samePage: true,
                },
              })
            }
          >
            Retry permission sets
          </button>
        </div>
      ),
    ),
  };
});

const developerPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
};

const auditorPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AuditorAccess",
  description: "Read-only sandbox access",
};

const unavailablePermissionSet: PermissionSetReference = {
  permissionSetArn: auditorPermissionSet.permissionSetArn,
  permissionSetId: auditorPermissionSet.permissionSetId,
  name: auditorPermissionSet.name,
  availability: "UNAVAILABLE",
};

const builtInPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2123456789abcdef",
  permissionSetId: "ps-2123456789abcdef",
  name: "test_IsbUsersPS",
  description: "Built-in sandbox user access",
};

const toReference = (
  permissionSet: typeof developerPermissionSet,
): PermissionSetReference => ({
  ...permissionSet,
  availability: "AVAILABLE",
});

function SubmittedValues() {
  const { watch } = useFormContext<AccessAndSharingFormValues>();
  return <output data-testid="form-values">{JSON.stringify(watch())}</output>;
}

function Harness({
  children,
  defaultValues = {},
}: PropsWithChildren<{
  defaultValues?: Partial<AccessAndSharingFormValues>;
}>) {
  const methods = useForm<AccessAndSharingFormValues>({
    resolver: zodResolver(AccessAndSharingValidationSchema),
    mode: "all",
    defaultValues: {
      allowOwnerToShareLease: false,
      defaultPermissionSet: undefined,
      allowedPermissionSets: [],
      ...defaultValues,
    },
  });
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(mockSubmit)}>
        {children}
        <SubmittedValues />
        <button type="submit">Submit access settings</button>
      </form>
    </FormProvider>
  );
}

const formValues = () =>
  JSON.parse(screen.getByTestId("form-values").textContent ?? "{}") as {
    allowOwnerToShareLease: boolean;
    defaultPermissionSet?: PermissionSetReference;
    allowedPermissionSets: PermissionSetReference[];
  };

const waitForBuiltInDefault = async () => {
  await waitFor(() => {
    expect(formValues().defaultPermissionSet?.permissionSetArn).toBe(
      builtInPermissionSet.permissionSetArn,
    );
  });
};

describe("AccessAndSharingForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({
      isAdmin: true,
      isManager: false,
      isUser: false,
    });
    const catalog = (
      permissionSets: unknown[],
      overrides: Record<string, unknown> = {},
    ) => ({
      permissionSets,
      error: undefined,
      fetchNextPage: mockFetchNextPage,
      hasNextPage: true,
      isFetchNextPageError: false,
      isFetchingNextPage: false,
      isLoading: false,
      isLoadingError: false,
      reloadCatalog: mockReloadCatalog,
      ...overrides,
    });
    mockCatalogByQuery.clear();
    mockCatalogByQuery.set(
      "_IsbUsersPS",
      catalog([builtInPermissionSet], { hasNextPage: false }),
    );
    mockCatalogByQuery.set("", catalog([], { hasNextPage: false }));
    mockCatalogByQuery.set(
      "auditor",
      catalog([developerPermissionSet, auditorPermissionSet]),
    );
    mockUsePermissionSets.mockImplementation((query: string) =>
      mockCatalogByQuery.get(query),
    );
  });

  it("renders one permission-set selector and separate permission-set and sharing containers", async () => {
    render(
      <Harness>
        <AccessAndSharingForm leaseSharingEnabled />
      </Harness>,
    );

    const permissionSetsHeading = screen.getByRole("heading", {
      name: "Permission sets",
    });
    const leaseSharingHeading = screen.getByRole("heading", {
      name: "Lease sharing",
    });
    expect(permissionSetsHeading).toBeVisible();
    expect(leaseSharingHeading).toBeVisible();
    expect(
      leaseSharingHeading.compareDocumentPosition(permissionSetsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Add permission sets")).toBeVisible();
    expect(
      screen.queryByText("Default permission set"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage permission sets" }),
    ).toHaveAttribute("href", "/permission-sets");
    expect(screen.getByLabelText("Allow owner to share lease")).toBeEnabled();
    await waitForBuiltInDefault();
  });

  it("bootstraps the built-in default into the effective selection without persisting it as additional", async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    await waitForBuiltInDefault();
    expect(screen.getByText("Full sandbox access")).toBeVisible();
    expect(screen.getByText(builtInPermissionSet.name)).toBeVisible();
    expect(screen.getByTestId("selected-permission-sets")).toHaveTextContent(
      builtInPermissionSet.permissionSetArn,
    );
    expect(screen.getByTestId("selected-option-states")).toHaveTextContent(
      `${builtInPermissionSet.permissionSetArn}:true`,
    );
    expect(
      screen.queryByRole("button", {
        name: `Remove ${builtInPermissionSet.name}`,
      }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Submit access settings" }),
    );
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPermissionSet: toReference(builtInPermissionSet),
        allowedPermissionSets: [],
      }),
      expect.anything(),
    );
  });

  it("opens permission-set management in a new tab", () => {
    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    const managePermissionSetsLink = screen.getByRole("link", {
      name: "Manage permission sets",
    });

    expect(managePermissionSetsLink).toHaveAttribute(
      "href",
      "/permission-sets",
    );
    expect(managePermissionSetsLink).toHaveAttribute("target", "_blank");
  });

  it("does not render permission-set management link for managers", () => {
    mockUseUser.mockReturnValue({
      isAdmin: false,
      isManager: true,
      isUser: false,
    });

    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    expect(
      screen.queryByRole("link", { name: "Manage permission sets" }),
    ).not.toBeInTheDocument();
  });

  it("does not bootstrap during edit flows and preserves hydrated selections", async () => {
    render(
      <Harness
        defaultValues={{
          defaultPermissionSet: toReference(developerPermissionSet),
          allowedPermissionSets: [toReference(auditorPermissionSet)],
        }}
      >
        <AccessAndSharingForm bootstrapBuiltInDefault={false} />
      </Harness>,
    );

    expect(mockUsePermissionSets).toHaveBeenCalledWith(
      "_IsbUsersPS",
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByTestId("selected-permission-sets")).toHaveTextContent(
      developerPermissionSet.permissionSetArn,
    );
    expect(screen.getByTestId("selected-permission-sets")).toHaveTextContent(
      auditorPermissionSet.permissionSetArn,
    );
    expect(formValues().defaultPermissionSet?.permissionSetArn).toBe(
      developerPermissionSet.permissionSetArn,
    );
  });

  it("uses the single selector to add permission sets", async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    await waitForBuiltInDefault();
    await user.click(
      screen.getByRole("button", { name: "Search permission sets" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select DeveloperAccess" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select AuditorAccess" }),
    );

    expect(
      formValues().allowedPermissionSets.map(
        ({ permissionSetArn }) => permissionSetArn,
      ),
    ).toEqual([
      developerPermissionSet.permissionSetArn,
      auditorPermissionSet.permissionSetArn,
    ]);
  });

  it("sets a selected row as default while retaining the previous default", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        defaultValues={{
          defaultPermissionSet: toReference(developerPermissionSet),
          allowedPermissionSets: [toReference(auditorPermissionSet)],
        }}
      >
        <AccessAndSharingForm bootstrapBuiltInDefault={false} />
      </Harness>,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Set AuditorAccess as default permission set",
      }),
    );

    expect(formValues().defaultPermissionSet?.permissionSetArn).toBe(
      auditorPermissionSet.permissionSetArn,
    );
    expect(formValues().allowedPermissionSets).toEqual([
      toReference(developerPermissionSet),
    ]);
    expect(screen.getAllByText("Default")).toHaveLength(1);
  });

  it("explains unavailable permission sets and only allows their removal", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        defaultValues={{
          defaultPermissionSet: toReference(developerPermissionSet),
          allowedPermissionSets: [unavailablePermissionSet],
        }}
      >
        <AccessAndSharingForm bootstrapBuiltInDefault={false} />
      </Harness>,
    );

    expect(
      screen.queryByRole("button", {
        name: "Set AuditorAccess as default permission set",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove AuditorAccess" }),
    ).toBeVisible();

    const unavailableStatus = screen.getByText("Unavailable");
    const descriptionCell = unavailableStatus.closest("td");
    expect(descriptionCell).not.toBeNull();
    expect(within(descriptionCell!).queryByText("—")).not.toBeInTheDocument();

    await user.click(unavailableStatus);
    expect(
      await screen.findByText(
        "This permission set is not currently available in the catalog. It cannot be used for new assignments or chosen as the default. Remove it if it is no longer needed; if it is currently the default, choose another default first.",
      ),
    ).toBeVisible();
  });

  it("removes only non-default permission sets from the table", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        defaultValues={{
          defaultPermissionSet: toReference(developerPermissionSet),
          allowedPermissionSets: [toReference(auditorPermissionSet)],
        }}
      >
        <AccessAndSharingForm bootstrapBuiltInDefault={false} />
      </Harness>,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove AuditorAccess" }),
    );

    expect(formValues().allowedPermissionSets).toEqual([]);
    expect(formValues().defaultPermissionSet?.permissionSetArn).toBe(
      developerPermissionSet.permissionSetArn,
    );
  });

  it(`disables unselected options when ${MAX_ALLOWED_PERMISSION_SETS} total permission sets are selected`, async () => {
    const allowedPermissionSets = Array.from(
      { length: MAX_ALLOWED_PERMISSION_SETS - 1 },
      (_, index) => {
        const permissionSetId = `ps-${index.toString(16).padStart(16, "0")}`;
        return {
          permissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/${permissionSetId}`,
          permissionSetId,
          name: `Permission set ${index}`,
          availability: "AVAILABLE" as const,
        };
      },
    );
    const user = userEvent.setup();
    render(
      <Harness
        defaultValues={{
          defaultPermissionSet: toReference(builtInPermissionSet),
          allowedPermissionSets,
        }}
      >
        <AccessAndSharingForm bootstrapBuiltInDefault={false} />
      </Harness>,
    );

    await user.click(
      screen.getByRole("button", { name: "Search permission sets" }),
    );
    expect(
      screen.getByRole("button", { name: "Select AuditorAccess" }),
    ).toBeDisabled();
  });

  it("surfaces required-default validation through the single selector", async () => {
    const user = userEvent.setup();
    mockCatalogByQuery.set("_IsbUsersPS", {
      ...mockCatalogByQuery.get("_IsbUsersPS"),
      permissionSets: [],
    });
    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    await user.click(
      screen.getByRole("button", { name: "Submit access settings" }),
    );
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Choose a default permission set."),
    ).toBeInTheDocument();
  });

  it("routes catalog pagination and recovery through the single selector", async () => {
    const user = userEvent.setup();
    mockCatalogByQuery.set("auditor", {
      ...mockCatalogByQuery.get("auditor"),
      error: new Error("The cursor is stale"),
      isFetchNextPageError: true,
    });
    render(
      <Harness>
        <AccessAndSharingForm />
      </Harness>,
    );

    await user.click(
      screen.getByRole("button", { name: "Search permission sets" }),
    );
    expect(screen.getByText("The cursor is stale")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Load more permission sets" }),
    );
    expect(mockFetchNextPage).toHaveBeenCalledWith({
      cancelRefetch: false,
    });

    await user.click(
      screen.getByRole("button", { name: "Retry permission sets" }),
    );
    expect(mockReloadCatalog).toHaveBeenCalledTimes(1);
  });

  it("retains existing lease-sharing behavior in its separate container", async () => {
    const user = userEvent.setup();
    render(
      <Harness defaultValues={{ allowOwnerToShareLease: true }}>
        <AccessAndSharingForm />
      </Harness>,
    );

    const sharingToggle = screen.getByLabelText("Allow owner to share lease");
    expect(sharingToggle).toBeEnabled();
    expect(
      screen.getByText(
        "Lease sharing is globally disabled. You can turn sharing off, but cannot enable it again until global sharing is enabled.",
      ),
    ).toBeVisible();

    await user.click(sharingToggle);
    expect(formValues().allowOwnerToShareLease).toBe(false);
  });
});
