// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared names for customer-account notification metrics.
export const NOTIFICATION_METRIC_NAMESPACE = "ISB/Notifications";
export const NOTIFICATION_FAILED_METRIC = "NotificationFailed";
export const NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE =
  "NotificationDeliveryFailed";

export const NOTIFICATION_CHANNEL_DIMENSION = "Channel";
export const NOTIFICATION_ISB_NAMESPACE_DIMENSION = "ISBNamespace";

export const NOTIFICATION_CHANNELS = ["SES", "SNS"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_ERROR_NAME_MAX_LENGTH = 256;
export const NOTIFICATION_ERROR_NAMES_MAX_COUNT = 10;

export type NotificationFailureMetricLog = {
  notificationMetricType: typeof NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE;
  isbNamespace: string;
  channel: NotificationChannel;
  notificationType: string;
  leaseId?: string;
  awsAccountId?: string;
  errorNames: readonly string[];
};

export function getNotificationErrorNames(
  errors: readonly unknown[],
): string[] {
  const names = errors.flatMap((error) =>
    error instanceof Error
      ? [error.name.slice(0, NOTIFICATION_ERROR_NAME_MAX_LENGTH)]
      : [],
  );
  return [...new Set(names)].slice(0, NOTIFICATION_ERROR_NAMES_MAX_COUNT);
}
