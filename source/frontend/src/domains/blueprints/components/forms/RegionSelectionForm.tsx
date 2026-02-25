// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header } from "@cloudscape-design/components";
import { Controller, useFormContext } from "react-hook-form";

import { RegionListBuilder } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/RegionListBuilder";

export function RegionSelectionForm() {
  const { control } = useFormContext<{ selectedRegions: string[] }>();

  return (
    <Container header={<Header variant="h2">Regions</Header>}>
      <Controller
        control={control}
        name="selectedRegions"
        render={({ field, fieldState }) => (
          <RegionListBuilder
            selectedRegions={field.value}
            onChange={field.onChange}
            errorText={fieldState.error?.message}
          />
        )}
      />
    </Container>
  );
}
