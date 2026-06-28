// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from "react";

import { AppContext } from "@amzn/innovation-sandbox-frontend/components/AppContext";
import { BaseLayout } from "@amzn/innovation-sandbox-frontend/components/AppLayout/BaseLayout";
import {
  DevRoleContext,
  useDevRoleState,
} from "@amzn/innovation-sandbox-frontend/hooks/useDevRole";

export interface AppLayoutProps {
  children: ReactNode;
}

export const AppLayout = ({ children }: AppLayoutProps) => {
  const devRoleState = useDevRoleState();

  return (
    <DevRoleContext.Provider value={devRoleState}>
      <AppContext>
        <BaseLayout>{children}</BaseLayout>
      </AppContext>
    </DevRoleContext.Provider>
  );
};
