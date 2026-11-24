// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";

/**
 * Shared money/rate/relative-time formatters for emails and the console, so both
 * surfaces round and render the same figures identically (USD 70.50, not
 * "USD 70.5"), plus the two sanitizers for externally-sourced strings
 * interpolated into an HTML or plain-text body.
 */

/**
 * The currency code and not `$`: a sandbox user outside the US reads `$` as their
 * own dollar, and these figures reach them in a message saying their account has
 * been cut off. The code is spelled rather than read from Cost Explorer, which
 * does report one per amount -- so this is an assumption, and a payer billed in
 * anything else is mislabelled here and, worse, compared against budgets entered
 * as bare numbers.
 */
export function formatCurrency(amount: number): string {
  const magnitude = Math.abs(amount).toFixed(2);
  // Sign ahead of the code, so a credit is negative at a glance rather than on
  // the fourth character.
  const sign = amount < 0 && magnitude !== "0.00" ? "-" : "";
  return `${sign}USD ${magnitude}`;
}

export function formatRate(
  dollarsPerUnit: number,
  basis: "hour" | "day",
): string {
  return `${formatCurrency(dollarsPerUnit)}/${basis}`;
}

/**
 * "3 hours ago" for an ISO timestamp. `base` exists for deterministic tests
 * and defaults to now. Falls back to the raw timestamp if it cannot be parsed.
 */
export function formatRelativeTime(
  isoTimestamp: string,
  base?: DateTime,
): string {
  const parsed = DateTime.fromISO(isoTimestamp, { zone: "utc" });
  if (!parsed.isValid) {
    return isoTimestamp;
  }
  return parsed.toRelative({ base: base ?? DateTime.utc() }) ?? isoTimestamp;
}
/**
 * Full local date and time for an ISO timestamp. Falls back to the raw
 * timestamp if it cannot be parsed, as luxon renders "Invalid DateTime".
 */
export function formatAbsoluteTime(isoTimestamp: string): string {
  const parsed = DateTime.fromISO(isoTimestamp);
  if (!parsed.isValid) {
    return isoTimestamp;
  }
  return parsed.toLocaleString(DateTime.DATETIME_HUGE);
}

/**
 * HTML-escape a value interpolated into an HTML body. The template layer
 * escapes nothing on its own, and the budget alert email was the first
 * template to interpolate an externally-sourced string: the Cost Explorer
 * service name in the insight sentence, which for a Marketplace charge is
 * seller-authored. That field is already charset-bounded on the schema (no
 * `< > " ' & =`), so for it this is defence in depth; the account ID and lease
 * UUID routed through it are format-constrained too.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A plain-text sink escapes differently: markup is inert there, but a value
 * carrying `\n` renders as extra lines in a legitimately SES-signed email, so
 * control characters are stripped instead. `insight.service` already excludes
 * `\p{C}` on the schema; this holds the property at the sink whatever reaches it.
 */
export function stripControlCharacters(value: string): string {
  return value.replace(/\p{C}/gu, "");
}
