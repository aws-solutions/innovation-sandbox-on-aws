// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IMPORTANT: All datetime strings stored in DynamoDB and validated by Zod schemas
 * must be UTC with a "Z" suffix (e.g. "2025-01-15T10:30:00.000Z").
 *
 * Our schemas use z.iso.datetime() which rejects timezone offsets like "+05:00".
 * Always use DateTime.utc() / now() from this module — never DateTime.now().toISO()
 * which produces local-timezone offsets that will fail schema validation.
 */

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
  // DynamoDB expects ttl to be in epoch second format.
  //
  // now() rather than DateTime.now(): luxon's plus({ days }) is calendar
  // arithmetic in the DateTime's own zone, so on a local clock a window that
  // straddles a DST transition is 23 or 25 hours per day rather than 24. Every
  // other clock read in this module is UTC, and callers stamping the same ttl
  // should not depend on the host's zone.
  return Math.floor(now().plus({ days: ttlDays }).valueOf() / 1000);
}
