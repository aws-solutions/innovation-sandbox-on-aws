// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { BlueprintTable } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/BlueprintTable";

export const ListBlueprints = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { isAdmin } = useUser();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Blueprints", href: "/blueprints" },
    ]);
    setTools(<Markdown file="blueprints" />);
  }, [setBreadcrumb, setTools]);

  const onRegisterClick = () => {
    navigate("/blueprints/register");
  };

  return (
    <ModalProvider>
      <ContentLayout
        disablePadding
        header={
          <Header
            variant="h1"
            info={<InfoLink markdown="blueprints" />}
            actions={
              isAdmin ? (
                <Button onClick={onRegisterClick} variant="primary">
                  Register blueprint
                </Button>
              ) : undefined
            }
            description="View and manage your blueprints"
          >
            Blueprints
          </Header>
        }
      >
        <BlueprintTable />
      </ContentLayout>
    </ModalProvider>
  );
};
