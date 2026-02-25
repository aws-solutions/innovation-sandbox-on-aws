// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";

export function parseDatetime(datetime: string) {
  return DateTime.fromISO(datetime, { zone: "utc" });
}

export function datetimeAsString(datetime: DateTime<true>): string {
  return datetime.toISO();
}

export function now() {
  return DateTime.utc();
}

export function nowAsIsoDatetimeString() {
  return now().toISO();
}

export function calculateDurationInMinutes(
  startTimeIso: string,
  endTime?: DateTime,
): number {
  const startTime = DateTime.fromISO(startTimeIso);
  const end = endTime ?? DateTime.now();
  return Math.round(end.diff(startTime, "minutes").minutes);
}

export function calculateTtlInEpochSeconds(ttlDays: number) {
  // DynamoDB expects ttl to be in epoch second format
  return Math.floor(DateTime.now().plus({ days: ttlDays }).valueOf() / 1000);
}
