// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Import npm css
import "react-toastify/dist/ReactToastify.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useMemo, useState } from "react";
import {
  createBrowserRouter,
  Route,
  RouterProvider,
  Routes,
} from "react-router-dom";
import { ToastContainer } from "react-toastify/unstyled";

import { AppLayout } from "@amzn/innovation-sandbox-frontend/components/AppLayout";
import { Authenticator } from "@amzn/innovation-sandbox-frontend/components/Authenticator";
import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";
import { OAuthCallback } from "@amzn/innovation-sandbox-frontend/components/OAuthCallback";
import { ProtectedRoute } from "@amzn/innovation-sandbox-frontend/components/ProtectedRoute";
import { AccountDetails } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/AccountDetails";
import { AddAccounts } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/AddAccounts";
import { ListAccounts } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/ListAccounts";
import { EditBlueprintBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintBasicDetails";
import { EditBlueprintDeploymentConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintDeploymentConfig";
import { ListBlueprints } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ListBlueprints";
import { RegisterBlueprintWizard } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/RegisterBlueprintWizard";
import { ViewBlueprint } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ViewBlueprint";
import { Home } from "@amzn/innovation-sandbox-frontend/domains/home/pages/Home";
import { NotFound } from "@amzn/innovation-sandbox-frontend/domains/home/pages/NotFound";
import { ApprovalDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ApprovalDetails";
import { AssignLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/AssignLease";
import { EditAccessSettings as EditLeaseAccessSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditAccessSettings";
import { EditBudgetSettings as EditLeaseBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditBudgetSettings";
import { EditCostReportSettings as EditLeaseCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditCostReportSettings";
import { EditDurationSettings as EditLeaseDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditDurationSettings";
import { EditSandboxSpacesSettings as EditLeaseSandboxSpacesSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditSandboxSpacesSettings";
import { LeaseDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/LeaseDetails";
import { ListApprovals } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListApprovals";
import { ListLeases } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListLeases";
import { RequestLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/RequestLease";
import { AddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/AddLeaseTemplate";
import { EditAccessAndSharing as EditLeaseTemplateAccessAndSharing } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditAccessAndSharing";
import { EditBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBasicDetails";
import { EditBlueprintSelection } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBlueprintSelection";
import { EditBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBudgetSettings";
import { EditCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditCostReportSettings";
import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditDurationSettings";
import { EditSandboxSpaces } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditSandboxSpaces";
import { LeaseTemplateDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/LeaseTemplateDetails";
import { ListLeaseTemplates } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/ListLeaseTemplates";
import { ListPermissionSets } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/pages/ListPermissionSets";
import { AdminSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/pages/AdminSettings";
import { EnableAgentModels } from "@amzn/innovation-sandbox-frontend/domains/settings/pages/EnableAgentModels";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import type { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

// Lazy-loaded so the chat page and its syntax highlighters stay out of the
// initial bundle.
const SandboxSpaces = lazy(() =>
  import("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/pages/SandboxSpaces").then(
    (module) => ({ default: module.SandboxSpaces }),
  ),
);

interface RouteConfig {
  path: string;
  Element: React.ComponentType;
  allowedRoles: IsbRole[];
}

const ALL_ROLES: IsbRole[] = ["User", "Manager", "Admin"];
const MANAGER_ADMIN: IsbRole[] = ["Manager", "Admin"];
const ADMIN_ONLY: IsbRole[] = ["Admin"];

export const App = () => {
  const routes = useMemo<RouteConfig[]>(
    () => [
      { path: "/", Element: Home, allowedRoles: ALL_ROLES },
      { path: "/request", Element: RequestLease, allowedRoles: ALL_ROLES },
      { path: "/assign", Element: AssignLease, allowedRoles: MANAGER_ADMIN },
      {
        path: "/settings",
        Element: AdminSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates",
        Element: ListLeaseTemplates,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/permission-sets",
        Element: ListPermissionSets,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/new",
        Element: AddLeaseTemplate,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid",
        Element: LeaseTemplateDetails,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/basic",
        Element: EditBasicDetails,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/budget",
        Element: EditBudgetSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/blueprint",
        Element: EditBlueprintSelection,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/duration",
        Element: EditDurationSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/cost-report",
        Element: EditCostReportSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/access",
        Element: EditLeaseTemplateAccessAndSharing,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/lease_templates/:uuid/edit/sandbox-spaces",
        Element: EditSandboxSpaces,
        allowedRoles: MANAGER_ADMIN,
      },
      { path: "/accounts", Element: ListAccounts, allowedRoles: ADMIN_ONLY },
      { path: "/accounts/new", Element: AddAccounts, allowedRoles: ADMIN_ONLY },
      {
        path: "/accounts/:accountId",
        Element: AccountDetails,
        allowedRoles: ADMIN_ONLY,
      },
      {
        path: "/settings/sandbox-spaces/models/new",
        Element: EnableAgentModels,
        allowedRoles: ADMIN_ONLY,
      },
      {
        path: "/approvals",
        Element: ListApprovals,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/approvals/:leaseId",
        Element: ApprovalDetails,
        allowedRoles: MANAGER_ADMIN,
      },
      { path: "/leases", Element: ListLeases, allowedRoles: ALL_ROLES },
      {
        path: "/leases/:leaseId/sandbox-spaces",
        Element: SandboxSpaces,
        allowedRoles: ALL_ROLES,
      },
      {
        path: "/leases/:leaseId",
        Element: LeaseDetails,
        allowedRoles: ALL_ROLES,
      },
      {
        path: "/leases/:leaseId/edit/budget",
        Element: EditLeaseBudgetSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/leases/:leaseId/edit/duration",
        Element: EditLeaseDurationSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/leases/:leaseId/edit/cost-report",
        Element: EditLeaseCostReportSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/leases/:leaseId/edit/access",
        Element: EditLeaseAccessSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/leases/:leaseId/edit/sandbox-spaces",
        Element: EditLeaseSandboxSpacesSettings,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/blueprints",
        Element: ListBlueprints,
        allowedRoles: MANAGER_ADMIN,
      },
      {
        path: "/blueprints/register",
        Element: RegisterBlueprintWizard,
        allowedRoles: ADMIN_ONLY,
      },
      {
        path: "/blueprints/:blueprintId/edit/basic",
        Element: EditBlueprintBasicDetails,
        allowedRoles: ADMIN_ONLY,
      },
      {
        path: "/blueprints/:blueprintId/edit/deployment",
        Element: EditBlueprintDeploymentConfig,
        allowedRoles: ADMIN_ONLY,
      },
      {
        path: "/blueprints/:blueprintId",
        Element: ViewBlueprint,
        allowedRoles: MANAGER_ADMIN,
      },
      { path: "*", Element: NotFound, allowedRoles: ALL_ROLES },
    ],
    [],
  );

  // Create the client once; recreating it on re-render would drop the cache.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            refetchOnMount: false,
            retry: false,
          },
        },
      }),
  );

  // Data router so useBlocker is available for the unsaved-changes guard.
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          path: "*",
          element: (
            <Routes>
              <Route path="/callback" element={<OAuthCallback />} />
              <Route
                path="*"
                element={
                  <Authenticator>
                    <ModalProvider>
                      <AppLayout>
                        <Suspense fallback={<FullPageLoader />}>
                          <Routes>
                            {routes.map(({ path, Element, allowedRoles }) => (
                              <Route
                                key={path}
                                path={path}
                                element={
                                  <ProtectedRoute allowedRoles={allowedRoles}>
                                    <Element />
                                  </ProtectedRoute>
                                }
                              />
                            ))}
                          </Routes>
                        </Suspense>
                      </AppLayout>
                    </ModalProvider>
                    <ToastContainer />
                  </Authenticator>
                }
              />
            </Routes>
          ),
        },
      ]),
    [routes],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};
