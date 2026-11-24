// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  Box,
  Button,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";
import {
  SandboxSpacesForm,
  SandboxSpacesFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesForm";
import { useEnabledModelIds } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { createSandboxSpacesEditValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";

/** Stored Sandbox Spaces settings the form is seeded from. */
export interface SandboxSpacesEditSource {
  sandboxSpacesEnabled: boolean;
  allowedModelIds?: readonly string[];
  defaultModelId?: string;
  bedrockTokenMonitoringEnabled?: boolean;
}

interface SandboxSpacesEditFormProps {
  source: SandboxSpacesEditSource;
  variant: SettingsFormVariant;
  globalSandboxSpacesEnabled: boolean;
  /** The allowBedrockTokenMonitoring global setting. */
  allowBedrockTokenMonitoring: boolean;
  isUpdating: boolean;
  onCancel: () => void;
  onSubmit: (data: SandboxSpacesFormValues) => Promise<void>;
}

export const SandboxSpacesEditForm = ({
  source,
  variant,
  globalSandboxSpacesEnabled,
  allowBedrockTokenMonitoring,
  isUpdating,
  onCancel,
  onSubmit,
}: Readonly<SandboxSpacesEditFormProps>) => {
  const enabledModelIds = useEnabledModelIds(globalSandboxSpacesEnabled);
  const validationSchema = useMemo(
    () => createSandboxSpacesEditValidationSchema({ enabledModelIds }),
    [enabledModelIds],
  );
  const methods = useForm<SandboxSpacesFormValues>({
    resolver: zodResolver(validationSchema),
    mode: "all",
    defaultValues: {
      sandboxSpacesEnabled: false,
      allowedModelIds: [],
      defaultModelId: undefined,
      bedrockTokenMonitoringEnabled: false,
      limitModels: false,
    },
  });
  const [sandboxSpacesTurnedOff, setSandboxSpacesTurnedOff] = useState(false);
  const {
    control,
    handleSubmit,
    reset,
    trigger,
    formState: { isValid, isDirty },
  } = methods;
  const sandboxSpacesEnabled = useWatch({
    control,
    name: "sandboxSpacesEnabled",
  });
  // Model rules can only be checked against a loaded catalog.
  const catalogPending =
    globalSandboxSpacesEnabled &&
    sandboxSpacesEnabled &&
    enabledModelIds === undefined;

  useEffect(() => {
    reset({
      sandboxSpacesEnabled: source.sandboxSpacesEnabled,
      allowedModelIds: [...(source.allowedModelIds ?? [])],
      defaultModelId: source.defaultModelId,
      bedrockTokenMonitoringEnabled:
        source.bedrockTokenMonitoringEnabled ?? false,
      limitModels: (source.allowedModelIds?.length ?? 0) > 0,
    });
  }, [source, reset]);

  // Models disabled since the last save must show their errors on load,
  // not only after the field is touched.
  useEffect(() => {
    if (enabledModelIds) {
      void trigger(["allowedModelIds", "defaultModelId"]);
    }
  }, [source, enabledModelIds, trigger]);

  return (
    <ContentLayout header={<Header variant="h1">Edit Sandbox Spaces</Header>}>
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <SandboxSpacesForm
              sandboxSpacesSetting={globalSandboxSpacesEnabled}
              variant={variant}
              monitoring={{
                allowBedrockTokenMonitoring,
                persistedSandboxSpacesEnabled: source.sandboxSpacesEnabled,
                sandboxSpacesTurnedOff,
                onSandboxSpacesTurnedOff: () => setSandboxSpacesTurnedOff(true),
              }}
            />
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={onCancel}
                  formAction="none"
                  disabled={isUpdating}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  formAction="submit"
                  loading={isUpdating}
                  disabled={
                    !isValid || !isDirty || isUpdating || catalogPending
                  }
                >
                  Save changes
                </Button>
              </SpaceBetween>
            </Box>
          </SpaceBetween>
        </form>
      </FormProvider>
    </ContentLayout>
  );
};
