// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Import npm css
import "react-toastify/dist/ReactToastify.css";

import { Route, BrowserRouter as Router, Routes } from "react-router-dom";
import { ToastContainer } from "react-toastify/unstyled";

import { AppLayout } from "@amzn/innovation-sandbox-frontend/components/AppLayout";
import { Authenticator } from "@amzn/innovation-sandbox-frontend/components/Authenticator";
import { AddAccounts } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/AddAccounts";
import { ListAccounts } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/ListAccounts";
import { EditBlueprintBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintBasicDetails";
import { EditBlueprintDeploymentConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintDeploymentConfig";
import { ListBlueprints } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ListBlueprints";
import { RegisterBlueprintWizard } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/RegisterBlueprintWizard";
import { ViewBlueprint } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ViewBlueprint";
import { Home } from "@amzn/innovation-sandbox-frontend/domains/home/pages/Home";
import { ApprovalDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ApprovalDetails";
import { AssignLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/AssignLease";
import { EditBudgetSettings as EditLeaseBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditBudgetSettings";
import { EditCostReportSettings as EditLeaseCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditCostReportSettings";
import { EditDurationSettings as EditLeaseDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditDurationSettings";
import { LeaseDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/LeaseDetails";
import { ListApprovals } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListApprovals";
import { ListLeases } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListLeases";
import { RequestLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/RequestLease";
import { AddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/AddLeaseTemplate";
import { EditBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBasicDetails";
import { EditBlueprintSelection } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBlueprintSelection";
import { EditBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBudgetSettings";
import { EditCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditCostReportSettings";
import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditDurationSettings";
import { LeaseTemplateDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/LeaseTemplateDetails";
import { ListLeaseTemplates } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/ListLeaseTemplates";
import { Settings } from "@amzn/innovation-sandbox-frontend/domains/settings/pages/Settings";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const App = () => {
  const routes = [
    { path: "/", Element: Home },
    { path: "/request", Element: RequestLease },
    { path: "/assign", Element: AssignLease },
    { path: "/settings", Element: Settings },
    { path: "/lease_templates", Element: ListLeaseTemplates },
    { path: "/lease_templates/new", Element: AddLeaseTemplate },
    { path: "/lease_templates/:uuid", Element: LeaseTemplateDetails },
    { path: "/lease_templates/:uuid/edit/basic", Element: EditBasicDetails },
    { path: "/lease_templates/:uuid/edit/budget", Element: EditBudgetSettings },
    {
      path: "/lease_templates/:uuid/edit/blueprint",
      Element: EditBlueprintSelection,
    },
    {
      path: "/lease_templates/:uuid/edit/duration",
      Element: EditDurationSettings,
    },
    {
      path: "/lease_templates/:uuid/edit/cost-report",
      Element: EditCostReportSettings,
    },
    { path: "/accounts", Element: ListAccounts },
    { path: "/accounts/new", Element: AddAccounts },
    { path: "/approvals", Element: ListApprovals },
    { path: "/approvals/:leaseId", Element: ApprovalDetails },
    { path: "/leases", Element: ListLeases },
    { path: "/leases/:leaseId", Element: LeaseDetails },
    { path: "/leases/:leaseId/edit/budget", Element: EditLeaseBudgetSettings },
    {
      path: "/leases/:leaseId/edit/duration",
      Element: EditLeaseDurationSettings,
    },
    {
      path: "/leases/:leaseId/edit/cost-report",
      Element: EditLeaseCostReportSettings,
    },
    { path: "/blueprints", Element: ListBlueprints },
    { path: "/blueprints/register", Element: RegisterBlueprintWizard },
    {
      path: "/blueprints/:blueprintId/edit/basic",
      Element: EditBlueprintBasicDetails,
    },
    {
      path: "/blueprints/:blueprintId/edit/deployment",
      Element: EditBlueprintDeploymentConfig,
    },
    { path: "/blueprints/:blueprintId", Element: ViewBlueprint },
  ];

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: false,
      },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <Authenticator>
        <Router>
          <ModalProvider>
            <AppLayout>
              <Routes>
                {routes.map(({ path, Element }) => (
                  <Route key={path} path={path} element={<Element />} />
                ))}
              </Routes>
            </AppLayout>
          </ModalProvider>
        </Router>
        <ToastContainer />
      </Authenticator>
    </QueryClientProvider>
  );
};
