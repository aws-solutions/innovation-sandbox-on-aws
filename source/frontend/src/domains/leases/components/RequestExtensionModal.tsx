// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  FormField,
  SpaceBetween,
  Textarea,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { DateTime } from "luxon";
import { useMemo } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";

import DateTimeField from "@amzn/innovation-sandbox-frontend/components/FormFields/DateTimeField";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useRequestLeaseExtension } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";

interface RequestExtensionModalProps {
  lease: MonitoredLeaseWithLeaseId;
  maxDurationHours?: number;
  onCancel: () => void;
}

interface ExtensionFormValues {
  requestedExpirationDate?: string;
  comments?: string;
}

export const RequestExtensionModal = ({
  lease,
  maxDurationHours,
  onCancel,
}: RequestExtensionModalProps) => {
  const { mutateAsync: requestExtension, isPending } =
    useRequestLeaseExtension();

  const schema = useMemo(() => {
    return z
      .object({
        requestedExpirationDate: z.string().datetime().optional(),
        comments: z.string().max(1000).optional(),
      })
      .superRefine((data, ctx) => {
        if (!data.requestedExpirationDate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "New expiration date is required",
            path: ["requestedExpirationDate"],
          });
          return;
        }

        const requestedDate = DateTime.fromISO(data.requestedExpirationDate);

        if (requestedDate <= DateTime.utc()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Expiration date must be in the future",
            path: ["requestedExpirationDate"],
          });
        }

        if (maxDurationHours && lease.startDate) {
          const leaseStart = DateTime.fromISO(lease.startDate);
          const maxExpiration = leaseStart.plus({ hours: maxDurationHours });

          if (requestedDate > maxExpiration) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Expiration date cannot exceed ${maxDurationHours} hours from lease start (${maxExpiration.toLocaleString(DateTime.DATETIME_SHORT)})`,
              path: ["requestedExpirationDate"],
            });
          }
        }
      });
  }, [maxDurationHours, lease.startDate]);

  const methods = useForm<ExtensionFormValues>({
    resolver: zodResolver(schema),
    mode: "all",
    defaultValues: {
      requestedExpirationDate: undefined,
      comments: "",
    },
  });

  const {
    handleSubmit,
    register,
    formState: { isValid, errors },
    control,
  } = methods;

  const onSubmit = async (data: ExtensionFormValues) => {
    if (!data.requestedExpirationDate) return;

    try {
      await requestExtension({
        leaseId: lease.leaseId,
        request: {
          requestedExpirationDate: data.requestedExpirationDate,
          comments: data.comments || undefined,
        },
      });
      showSuccessToast("Lease extension request submitted successfully.");
      onCancel();
    } catch (error) {
      if (error instanceof Error) {
        showErrorToast(error.message, "Extension Request Failed");
      } else {
        showErrorToast(
          "An unexpected error occurred while requesting the extension.",
          "Extension Request Failed",
        );
      }
    }
  };

  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <SpaceBetween size="l">
          <Alert type="info">
            Request an extension for your lease. The new expiration date must be
            in the future
            {maxDurationHours
              ? ` and within ${maxDurationHours} hours of the lease start date`
              : ""}
            . Your request will be reviewed by an administrator.
          </Alert>

          <DateTimeField
            controllerProps={{ control, name: "requestedExpirationDate" }}
            formFieldProps={{
              label: "New Expiration Date",
              description:
                "Select the new date and time when the lease should expire",
            }}
          />

          <FormField
            label={
              <>
                Comments - <i>Optional</i>
              </>
            }
            description="Provide a reason for the extension request"
            errorText={errors.comments?.message}
          >
            <Textarea
              {...register("comments")}
              placeholder="Reason for extension request"
              onChange={({ detail }) =>
                methods.setValue("comments", detail.value, {
                  shouldValidate: true,
                })
              }
              value={methods.watch("comments") ?? ""}
            />
          </FormField>

          <Box textAlign="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button formAction="none" onClick={onCancel} disabled={isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                formAction="submit"
                loading={isPending}
                disabled={!isValid || isPending}
              >
                Submit Request
              </Button>
            </SpaceBetween>
          </Box>
        </SpaceBetween>
      </form>
    </FormProvider>
  );
};
