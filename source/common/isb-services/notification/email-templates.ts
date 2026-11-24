// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { AssignmentCreatedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-created-event.js";
import { AssignmentRemovedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-removed-event.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEvent } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { SynthesizedEmail } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import {
  escapeHtml,
  formatCurrency,
  formatRate,
  formatRelativeTime,
  stripControlCharacters,
} from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

// either to or bcc, but not both
// no need to support that
// the retry logic will be complex if we support that
/**
 * Mutually exclusive to/bcc to simplify retry bisection logic in EmailService.
 */
export type EmailDestination =
  | {
      to: string[];
      bcc?: never;
    }
  | {
      to?: never;
      bcc: string[];
    };

export type EmailTemplatesContext = {
  webAppUrl: string;
  destination: EmailDestination;
};

type BudgetAlertDetail = LeaseBudgetThresholdBreachedAlert["Detail"];
type SpendRateAlertDetail = LeaseSpendRateThresholdBreachedAlert["Detail"];

/** Dollars-per-hour or per-day, matching the rate's own basis. */
function rateBasisWord(
  basis: "HOURLY" | "DAILY" | null | undefined,
): "hour" | "day" {
  return basis === "DAILY" ? "day" : "hour";
}

/**
 * The lead clause naming what happened, per `triggeredBy`. Keyed on the enum so
 * a new value is a compile error here rather than an `undefined` in a sent
 * email. Figures are rounded through `format-utils.ts`, the one rounding source
 * the email and the console share, so the two never round the same number
 * differently.
 */
export const budgetAlertThresholdClause: Record<
  BudgetAlertDetail["triggeredBy"],
  (detail: BudgetAlertDetail) => string
> = {
  // Each clause carries its own verb, and the template supplies none. A shared
  // "has" in the template only fits the branches whose verb is a past
  // participle: PREDICTED's is not ("has is projected to cross"), so the verb
  // has to live with the branch that chooses it.
  //
  // `budget` is optional on a lease with no maxSpend, so it is stated only when
  // set.
  REPORTED: (detail) =>
    `has reached the budget threshold of ${formatCurrency(detail.budgetThresholdTriggered)}${
      detail.budget === undefined
        ? ""
        : ` against the assigned budget of ${formatCurrency(detail.budget)}`
    }`,
  // Stated as an estimate, never "reached": the reported spend has not crossed
  // the line, and on a FREEZE_ACCOUNT threshold "reached" would misstate why the
  // account was frozen.
  PREDICTED: (detail) =>
    `is projected to cross its configured budget threshold of ${formatCurrency(detail.budgetThresholdTriggered)}, an estimate from the current spend rate rather than a confirmed charge`,
};

/**
 * The exhaustion clause, rounded for display. A positive value under half an
 * hour rounds to zero, which would read "in about 0 hours" as if the budget
 * were already spent, so a sub-hour countdown says "within the hour" instead.
 */
function budgetCountdownClause(budget: number, hours: number): string {
  const rounded = Math.round(hours);
  const unit = rounded === 1 ? "hour" : "hours";
  const when = rounded < 1 ? "within the hour" : `in about ${rounded} ${unit}`;
  return `the ${formatCurrency(budget)} budget would be exhausted ${when}`;
}

/**
 * The one insight the alert names, its service escaped for the surface it
 * renders on. Omitted entirely when no insight was carried, so the notification
 * says nothing rather than hedging.
 */
function budgetAlertInsightSentence(
  detail: Pick<BudgetAlertDetail | SpendRateAlertDetail, "insight">,
  escape: (value: string) => string,
): string | undefined {
  const insight = detail.insight;
  if (insight == null) {
    return undefined;
  }
  const service = escape(insight.service);
  const amount = formatCurrency(insight.amount);
  switch (insight.kind) {
    case "COMPOSITION": {
      const share =
        insight.shareOfComparedSpend == null
          ? ""
          : ` (${Math.round(insight.shareOfComparedSpend * 100)}%)`;
      return `The largest service is ${service}, ${amount}${share}.`;
    }
    case "CHANGE": {
      const percent = insight.changePercent ?? 0;
      const direction = percent < 0 ? "down" : "up";
      return `The biggest change is ${service}, ${direction} ${Math.abs(
        Math.round(percent),
      )}% since the previous interval, now ${amount}.`;
    }
    case "NEW_ENTRANT":
      return `New this interval: ${service}, ${amount}.`;
    default:
      // A fourth insight kind must add its own sentence rather than silently
      // borrowing NEW_ENTRANT's, as the triggeredBy clause map is likewise keyed.
      return assertNever(insight.kind);
  }
}

/** The alert fields the confirmed-cost and countdown sentences read; both alerts carry them. */
type AlertFigures = Pick<
  BudgetAlertDetail & SpendRateAlertDetail,
  | "totalSpend"
  | "lastReportedAt"
  | "unbilledBedrockTokenCost"
  | "budget"
  | "hoursToBudgetExhaustion"
  | "countdownRate"
  | "countdownRateSource"
>;

/**
 * The last confirmed cost, with the monitored Bedrock token cost the bill
 * has not caught up with appended where it adds at least a cent.
 */
function confirmedCostSentence(
  detail: Pick<
    AlertFigures,
    "totalSpend" | "lastReportedAt" | "unbilledBedrockTokenCost"
  >,
): string {
  const observed =
    detail.lastReportedAt == null
      ? ""
      : `, observed ${formatRelativeTime(detail.lastReportedAt)}`;
  return `The last confirmed cost was ${formatCurrency(detail.totalSpend)}${observed}${unbilledBedrockClause(detail)}.`;
}

/**
 * The monitored Bedrock token cost the projection adds to the last
 * confirmed cost, which the bill has not caught up with. Empty where it adds
 * no cent.
 */
function unbilledBedrockClause(
  detail: Pick<AlertFigures, "unbilledBedrockTokenCost">,
): string {
  const unbilled = detail.unbilledBedrockTokenCost;
  if (
    unbilled == null ||
    unbilled <= 0 ||
    formatCurrency(unbilled) === formatCurrency(0)
  ) {
    return "";
  }
  return `, plus ${formatCurrency(unbilled)} of Bedrock token usage not yet billed`;
}

/**
 * The countdown as a sentence of its own where it burns at a rate that reads
 * differently from `otherRate`: on the token poll, that rate adds the
 * monitored Bedrock token rate. `otherRate` is the projection rate a
 * dollar alert already states, or undefined on a spend-rate alert, which
 * states no projection rate. Undefined where there is no budget or positive
 * countdown, and where the countdown follows `otherRate`.
 */
function countdownAtItsOwnRate(
  detail: AlertFigures,
  otherRate: string | undefined,
): string | undefined {
  const {
    budget,
    hoursToBudgetExhaustion,
    countdownRate,
    countdownRateSource,
  } = detail;
  if (
    budget == null ||
    hoursToBudgetExhaustion == null ||
    hoursToBudgetExhaustion <= 0 ||
    countdownRate == null ||
    countdownRateSource == null
  ) {
    return undefined;
  }
  const ownRate = formatRate(countdownRate, rateBasisWord(countdownRateSource));
  if (ownRate === otherRate) {
    return undefined;
  }
  return `At ${ownRate} including monitored Bedrock token cost, ${budgetCountdownClause(budget, hoursToBudgetExhaustion)}.`;
}

/** The budget clause: the countdown where it is a positive number of hours, the budget alone otherwise. */
function budgetClause(
  budget: number,
  hours: number | null | undefined,
): string {
  // The countdown goes negative once the projection overshoots the whole
  // budget, so it is stated only when it is a positive number of hours;
  // otherwise the budget is still named on its own.
  return hours != null && hours > 0
    ? budgetCountdownClause(budget, hours)
    : `the assigned budget is ${formatCurrency(budget)}`;
}

/**
 * Projection context for a spend-rate alert. The measured rate compared
 * against the limit did not carry `predictedCost`, so no rate is attributed to
 * the projection here; a countdown that burns at its own rate is stated in a
 * separate sentence naming that rate.
 */
function spendRateProjectionSentences(detail: SpendRateAlertDetail): string[] {
  const separateCountdown = countdownAtItsOwnRate(detail, undefined);
  const hours =
    separateCountdown === undefined ? detail.hoursToBudgetExhaustion : null;
  const sentences: string[] = [];
  if (detail.predictedCost != null) {
    const clauses = [
      `The projected cost is ${formatCurrency(detail.predictedCost)}`,
    ];
    if (detail.budget != null) {
      clauses.push(budgetClause(detail.budget, hours));
    }
    sentences.push(`${clauses.join(", ")}.`);
  } else if (detail.budget != null && separateCountdown === undefined) {
    // The separate countdown sentence names the budget itself.
    sentences.push(
      hours != null && hours > 0
        ? `At the current projection, ${budgetCountdownClause(detail.budget, hours)}.`
        : `The assigned budget is ${formatCurrency(detail.budget)}.`,
    );
  }
  if (separateCountdown !== undefined) {
    sentences.push(separateCountdown);
  }
  return sentences;
}

/**
 * The figures a dollar breach carries beyond its lead: the last confirmed cost
 * and the unbilled Bedrock usage added to it on a PREDICTED estimate, which it
 * is measured against (a REPORTED breach already names the crossed figure in
 * its lead), and -- only where a rate was in force -- the projection rate, the
 * projection, the budget and the countdown, which is stated with its own rate
 * where that differs. The rate gate is what keeps a first-interval lease, whose
 * `predictedCost` is the reported total under another name, from being
 * described as "projected". The budget is named whenever it is set, not only
 * alongside the countdown, so it survives a run whose countdown is
 * unavailable.
 */
function budgetAlertFigureSentences(detail: BudgetAlertDetail): string[] {
  const sentences: string[] = [];
  if (detail.triggeredBy === "PREDICTED") {
    sentences.push(confirmedCostSentence(detail));
  }
  if (detail.rate != null && detail.rateSource != null) {
    sentences.push(
      ...rateSentences(
        detail,
        formatRate(detail.rate, rateBasisWord(detail.rateSource)),
      ),
    );
  }
  return sentences;
}

/** The rate, the projection, the budget and the countdown, for a breach a rate was in force on. */
function rateSentences(detail: BudgetAlertDetail, rate: string): string[] {
  const clauses = [`At the current rate of ${rate}`];
  if (detail.predictedCost != null) {
    clauses.push(
      `the projected cost is ${formatCurrency(detail.predictedCost)}`,
    );
  }
  const separateCountdown = countdownAtItsOwnRate(detail, rate);
  if (detail.budget != null && separateCountdown === undefined) {
    clauses.push(budgetClause(detail.budget, detail.hoursToBudgetExhaustion));
  }
  // With no consequent clause a bare "At the current rate of $X." reads as a
  // fragment, so the rate is stated as a complete sentence instead.
  const sentences = [
    clauses.length === 1
      ? `The current spend rate is ${rate}.`
      : `${clauses.join(", ")}.`,
  ];
  if (separateCountdown !== undefined) {
    sentences.push(separateCountdown);
  }
  return sentences;
}

/**
 * The full alert body paragraph, dynamic values escaped for the given surface
 * so the same sentences serve `htmlBody` and `textBody` without drifting apart.
 */
function budgetAlertParagraph(
  detail: BudgetAlertDetail,
  escape: (value: string) => string,
): string {
  const sentences = [
    `The usage cost for your account ID: ${escape(detail.accountId)} under lease ID: ${escape(detail.leaseId.uuid)} ${budgetAlertThresholdClause[detail.triggeredBy](detail)}.`,
    ...budgetAlertFigureSentences(detail),
  ];
  const insight = budgetAlertInsightSentence(detail, escape);
  if (insight !== undefined) {
    sentences.push(insight);
  }
  sentences.push(
    "Review the AWS resources running in your account and operate within the prescribed budget limit to avoid freeze or clean-up actions on your account.",
  );
  return sentences.join(" ");
}

/** A spend rate is an estimate, so the last confirmed cost is always named. */
function spendRateAlertParagraph(
  detail: SpendRateAlertDetail,
  escape: (value: string) => string,
): string {
  const unit = rateBasisWord(detail.rateBasis);
  const sentences = [
    `The spend rate for your account ID: ${escape(detail.accountId)} under lease ID: ${escape(detail.leaseId.uuid)} has exceeded its configured spend rate limit of ${formatRate(detail.thresholdRate, unit)}; the measured rate is ${formatRate(detail.measuredRate, unit)}, an estimate of how fast cost is accruing rather than a confirmed charge.`,
    confirmedCostSentence(detail),
    ...spendRateProjectionSentences(detail),
  ];
  const insight = budgetAlertInsightSentence(detail, escape);
  if (insight !== undefined) {
    sentences.push(insight);
  }
  sentences.push(
    "Review the AWS resources running in your account and reduce the rate of spend to avoid freeze or clean-up actions on your account.",
  );
  return sentences.join(" ");
}

type FrozenByBudgetReason =
  LeaseFrozenEvent<"BudgetExceeded">["Detail"]["reason"];

/** The budget a freeze reason names; empty where it carries none. */
function assignedBudgetClause(budget: number | undefined): string {
  if (budget == null) {
    return "";
  }
  return ` against the assigned budget of ${formatCurrency(budget)}`;
}

/**
 * Why a budget freeze happened, per the reason's `triggeredBy`. A projected
 * freeze must not present the estimate as a billed figure, so it says the
 * figure is an estimate, which rate produced it, and what the last confirmed
 * cost was. A reason without `triggeredBy`, as the previous release emits,
 * or with `REPORTED`, keeps the shipped wording, except that an absent budget
 * is omitted rather than rendered as `undefined`. Switched exhaustively so
 * a new trigger kind is a compile error here rather than billed wording.
 */
function frozenByBudgetClause(reason: FrozenByBudgetReason): string {
  const triggeredBy = reason.triggeredBy ?? "REPORTED";
  const freezeThreshold = `the freeze threshold of ${formatCurrency(reason.triggeredBudgetThreshold)}`;
  switch (triggeredBy) {
    case "REPORTED":
      return `has been frozen since usage cost has reached ${freezeThreshold}${assignedBudgetClause(reason.budget)}`;
    case "PREDICTED": {
      const rateBasisPhrase =
        reason.rateSource == null
          ? "current spend rate"
          : `current spend rate per ${rateBasisWord(reason.rateSource)}`;
      return `has been frozen because usage cost is projected to reach ${freezeThreshold}${assignedBudgetClause(reason.budget)}. That figure is an estimate from the ${rateBasisPhrase}, not a confirmed charge; the last confirmed cost was ${formatCurrency(reason.totalSpend)}`;
    }
    default:
      return assertNever(triggeredBy);
  }
}

type FrozenBySpendRateReason =
  LeaseFrozenEvent<"SpendRateExceeded">["Detail"]["reason"];

function frozenBySpendRateClause(reason: FrozenBySpendRateReason): string {
  const unit = rateBasisWord(reason.rateBasis);
  return `has been frozen because its spend rate of ${formatRate(reason.measuredRate, unit)} exceeded the spend rate limit of ${formatRate(reason.thresholdRate, unit)}. A spend rate is an estimate of how fast cost is accruing, not a confirmed charge; the last confirmed cost was ${formatCurrency(reason.totalSpend)}${assignedBudgetClause(reason.budget)}`;
}

type SpendFrozenEvent = LeaseFrozenEvent<
  "BudgetExceeded" | "SpendRateExceeded"
>;

function frozenBySpendClause(event: SpendFrozenEvent): string {
  const reason = event.Detail.reason;
  return reason.type === "SpendRateExceeded"
    ? frozenBySpendRateClause(reason)
    : frozenByBudgetClause(reason);
}

/** The subject's basis phrase, so a spend-rate freeze is not reported as a budget one. */
function frozenBySpendBasis(event: SpendFrozenEvent): string {
  return event.Detail.reason.type === "SpendRateExceeded"
    ? "Spend Rate Limit"
    : "Allowed Budget";
}

export namespace EmailTemplates {
  export function LeaseRequested(
    event: LeaseRequestedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject:
        "[Action Required] Innovation Sandbox: New Lease Approval Request",
      htmlBody: `
    <h1>Request to approve or deny lease from ${event.Detail.userEmail}</h1>
    <p>A new lease has been requested by sandbox user ${event.Detail.userEmail}.
    Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to approve or deny the lease request.</p>
    `,
      textBody: `
      Request to approve or deny lease from ${event.Detail.userEmail}
      A new lease has been requested by sandbox user ${event.Detail.userEmail}.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to approve or deny the lease request.
    `,
    };
  }

  export function LeaseApproved(
    event: LeaseApprovedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject: "[Informational] Innovation Sandbox: Lease Request Approved",
      htmlBody: `
      <h1>Welcome to Innovation Sandbox on AWS ${event.Detail.userEmail}!</h1>
      <p>Your sandbox lease request ${event.Detail.leaseId} has been ${event.Detail.approvedBy === "AUTO_APPROVED" ? "auto approved" : "approved by " + event.Detail.approvedBy}.
      Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to access your sandbox account.</p>
    `,
      textBody: `
      Welcome to Innovation Sandbox on AWS ${event.Detail.userEmail}!
      Your sandbox lease request ${event.Detail.leaseId} has been ${event.Detail.approvedBy === "AUTO_APPROVED" ? "auto approved" : "approved by " + event.Detail.approvedBy}.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to access your sandbox account.
    `,
    };
  }

  export function LeaseDenied(
    event: LeaseDeniedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject: "[Informational] Innovation Sandbox: Lease Request Denied",
      htmlBody: `
      <p>Your sandbox lease request ${event.Detail.leaseId} has been denied by ${event.Detail.deniedBy}.
      Contact your Innovation Sandbox on AWS administrator or manager for more details.</p>
    `,
      textBody: `
      Your sandbox lease request ${event.Detail.leaseId} has been denied by ${event.Detail.deniedBy}.
      Contact your Innovation Sandbox on AWS administrator or manager for more details.
    `,
    };
  }

  export function LeaseBudgetAlert(
    event: LeaseBudgetThresholdBreachedAlert,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject:
        "[Action may be needed] Innovation Sandbox: Budget Threshold Alert",
      htmlBody: `
      <p>${budgetAlertParagraph(event.Detail, escapeHtml)}</p>
    `,
      textBody: `
      ${budgetAlertParagraph(event.Detail, stripControlCharacters)}
    `,
    };
  }

  export function LeaseSpendRateThresholdAlert(
    event: LeaseSpendRateThresholdBreachedAlert,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject:
        "[Action may be needed] Innovation Sandbox: Spend Rate Limit Alert",
      htmlBody: `
      <p>${spendRateAlertParagraph(event.Detail, escapeHtml)}</p>
    `,
      textBody: `
      ${spendRateAlertParagraph(event.Detail, stripControlCharacters)}
    `,
    };
  }

  export function LeaseDurationThresholdAlert(
    event: LeaseDurationThresholdBreachedAlert,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject: "[Informational] Innovation Sandbox: Lease Threshold Alert",
      htmlBody: `
      <p>Your lease ID: ${event.Detail.leaseId.uuid} for account ID: ${event.Detail.accountId} usage has reached the lease duration threshold
      of ${event.Detail.leaseDurationInHours - event.Detail.triggeredDurationThreshold} hour(s) against the assigned lease duration ${event.Detail.leaseDurationInHours} hour(s).
      Ensure you complete all tasks before your sandbox account access expires.</p>
    `,
      textBody: `
      Your lease ID: ${event.Detail.leaseId.uuid} for account ID: ${event.Detail.accountId} usage has reached the lease duration threshold
      of ${event.Detail.leaseDurationInHours - event.Detail.triggeredDurationThreshold} hour(s) against the assigned lease duration ${event.Detail.leaseDurationInHours} hour(s).
      Ensure you complete all tasks before your sandbox account access expires.
    `,
    };
  }

  export function AccountCleanupFailure(
    event: AccountCleanupFailureEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject: "[Action Required] Innovation Sandbox: Account Clean-up Failure",
      htmlBody: `
      <p>The resource clean-up process for account ID: ${event.Detail.accountId} failed since some resources could not be
      deleted automatically. Review the account to clean up the remaining resources manually and
      use Innovation Sandbox on AWS to re-initiate the clean-up action.</p>
    `,
      textBody: `
      The resource clean-up process for account ID: ${event.Detail.accountId} failed since some resources could not be
      deleted automatically. Review the account to clean up the remaining resources manually and
      use Innovation Sandbox on AWS to re-initiate the clean-up action.
    `,
    };
  }

  export function AccountDrift(
    event: AccountDriftDetectedAlert,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject: "[Action Required] Innovation Sandbox: Account Drift",
      htmlBody: event.Detail.expectedOu
        ? `<p>The account ID: ${event.Detail.accountId} was expected to be in ${event.Detail.expectedOu} OU, but it was found in ${event.Detail.actualOu}.
       The account has been moved to the quarantine OU by the system.</p>
      `
        : `<p>Untracked account ID: ${event.Detail.accountId} was found in ${event.Detail.actualOu}.
       The account has been moved to the quarantine OU by the system.</p>
      `,
      textBody: event.Detail.expectedOu
        ? `
      The account ID: ${event.Detail.accountId} was expected to be in ${event.Detail.expectedOu} OU, but it was found in ${event.Detail.actualOu}.
      The account has been moved to the quarantine OU by the system.
    `
        : `
      Untracked account ID: ${event.Detail.accountId} was found in ${event.Detail.actualOu}.
      The account has been moved to the quarantine OU by the system.
    `,
    };
  }

  export function LeaseUnfrozen(
    event: LeaseUnfrozenEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      to: context.destination.to!,
      subject: "[Informational] Innovation Sandbox: Lease Unfrozen",
      htmlBody: `
      <p>The lease ID: ${event.Detail.leaseId.uuid} for account ID: ${event.Detail.accountId} has been unfrozen
      with the new budget limit of $${event.Detail.maxBudget} and lease duration of ${event.Detail.leaseDurationInHours}
      hours. Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to access your sandbox account
      and use within the prescribed limits.</p>
    `,
      textBody: `
      The lease ID: ${event.Detail.leaseId.uuid} for account ID: ${event.Detail.accountId} has been unfrozen
      with the new budget limit of $${event.Detail.maxBudget} and lease duration of ${event.Detail.leaseDurationInHours}
      hours. Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to access your sandbox account
      and use within the prescribed limits.
    `,
    };
  }

  export function GroupCostReportGenerated(
    event: GroupCostReportGeneratedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject:
        "[Informational] Innovation Sandbox: Monthly Cost Report Generated",
      htmlBody: `
        <p>Monthly Cost Report Successfully Generated</p>
        <p>The monthly cost report for ${event.Detail.reportMonth} has been successfully generated and uploaded to S3 s3://${event.Detail.bucketName}/${event.Detail.fileName}.</p>
      `,
      textBody: `
        Monthly Cost Report Successfully Generated

        The monthly cost report for ${event.Detail.reportMonth} has been successfully generated and uploaded to S3 s3://${event.Detail.bucketName}/${event.Detail.fileName}.
      `,
    };
  }

  export function GroupCostReportGenerationFailure(
    event: GroupCostReportGeneratedFailureEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject: `Group Cost Report Generation Failed - ${event.Detail.reportMonth}`,
      htmlBody: `
        <p>Group Cost Report Generation Failed</p>
        <p>The monthly cost report for ${event.Detail.reportMonth} failed to be generated. Check the
        CloudWatch logs ${event.Detail.logName} for more details and retry the cost report generation if needed.</p>
      `,
      textBody: `
        Group Cost Report Generation Failed

        The monthly cost report for ${event.Detail.reportMonth} failed to be generated. Check the
        CloudWatch logs ${event.Detail.logName} for more details and retry the cost report generation if needed.
      `,
    };
  }

  export namespace LeaseTerminated {
    export function byBudgetUser(
      event: LeaseTerminatedEvent<"BudgetExceeded">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Account Clean-up Action based on Allowed Budget",
        htmlBody: `
      <p>The resource clean-up process has been initiated for lease ID: ${event.Detail.leaseId.uuid} on account ID: ${event.Detail.accountId}
      since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. You will no longer be able
      to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.</p>
    `,
        textBody: `
      The resource clean-up process has been initiated for lease ID: ${event.Detail.leaseId.uuid} on account ID: ${event.Detail.accountId}
      since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. You will no longer be able
      to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.
    `,
      };
    }

    export function byBudgetAdminManager(
      event: LeaseTerminatedEvent<"BudgetExceeded">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject:
          "[Informational] Innovation Sandbox: Account Clean-up Action based on Allowed Budget",
        htmlBody: `
      <p>The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. Upon successful clean-up,
      the account will be moved under 'Available' OU. You will be notified if any manual intervention is
      required to complete the resource clean-up process.</p>
    `,
        textBody: `
      The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. Upon successful clean-up,
      the account will be moved under 'Available' OU. You will be notified if any manual intervention is
      required to complete the resource clean-up process.
    `,
      };
    }

    export function byDurationUser(
      event: LeaseTerminatedEvent<"Expired">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Account Clean-up Action based on Lease Duration",
        htmlBody: `
      <p>The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since the lease has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer
      be able to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.</p>
    `,
        textBody: `
      The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since the lease has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer
      be able to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.
    `,
      };
    }

    export function byDurationAdminManager(
      event: LeaseTerminatedEvent<"Expired">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject:
          "[Informational] Innovation Sandbox: Account Clean-up Action based on Lease Duration",
        htmlBody: `
      <p>The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since it has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). Upon successful clean-up,
      the account will be moved to 'Available' OU. You will be notified if any manual intervention is required
      to complete the resource clean-up process.</p>
    `,
        textBody: `
      The resource clean-up process has been initiated for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      since it has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). Upon successful clean-up,
      the account will be moved to 'Available' OU. You will be notified if any manual intervention is required
      to complete the resource clean-up process.
    `,
      };
    }

    export function byManuallyTerminatedUser(
      event: LeaseTerminatedEvent<"ManuallyTerminated">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Manual Account Clean-up Action",
        htmlBody: `
      <p>Your lease for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      has been manually terminated by an administrator. You will no longer be able to access this account.
      Contact your administrator or manager with any questions.</p>
    `,
        textBody: `
      Your lease for account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid}
      has been manually terminated by an administrator. You will no longer be able to access this account.
      Contact your administrator or manager with any questions.
    `,
      };
    }

    export function byAccountQuarantinedUser(
      event: LeaseTerminatedEvent<"AccountQuarantined">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Account Quarantined Action",
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been quarantined.
      You will no longer be able to access your account. Contact your Innovation Sandbox on AWS
      administrator or manager for assistance.</p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been quarantined.
      You will no longer be able to access your account. Contact your Innovation Sandbox on AWS
      administrator or manager for assistance.
    `,
      };
    }

    export function byEjectedUser(
      event: LeaseTerminatedEvent<"Ejected">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject: "[Informational] Innovation Sandbox: Account Ejected Action",
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been ejected
      by an Innovation Sandbox on AWS administrator or manager. You will no longer be able to access your account. Contact your Innovation Sandbox
      administrator or manager for assistance.</p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been ejected
      by an Innovation Sandbox on AWS administrator or manager. You will no longer be able to access your account. Contact your Innovation Sandbox
      administrator or manager for assistance.
    `,
      };
    }

    export function byProvisioningFailedUser(
      event: LeaseTerminatedEvent<"ProvisioningFailed">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Blueprint Deployment Failed",
        htmlBody: `
      <p>The blueprint deployment for your sandbox lease (lease ID: ${event.Detail.leaseId.uuid}) failed and the lease has been terminated.
      You can submit a new lease request through <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> or contact your
      Innovation Sandbox on AWS administrator or manager for assistance.</p>
    `,
        textBody: `
      The blueprint deployment for your sandbox lease (lease ID: ${event.Detail.leaseId.uuid}) failed and the lease has been terminated.
      You can submit a new lease request through Innovation Sandbox on AWS ${context.webAppUrl} or contact your
      Innovation Sandbox on AWS administrator or manager for assistance.
    `,
      };
    }

    export function byProvisioningFailedAdminManager(
      event: LeaseTerminatedEvent<"ProvisioningFailed">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject:
          "[Action Required] Innovation Sandbox: Blueprint Deployment Failed",
        htmlBody: `
      <p>Blueprint deployment failed for an auto-approved lease (lease ID: ${event.Detail.leaseId.uuid}) on account ID: ${event.Detail.accountId}.
      The lease has been terminated and the account will be cleaned up and returned to the Available pool.
      Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to investigate the blueprint configuration.</p>
    `,
        textBody: `
      Blueprint deployment failed for an auto-approved lease (lease ID: ${event.Detail.leaseId.uuid}) on account ID: ${event.Detail.accountId}.
      The lease has been terminated and the account will be cleaned up and returned to the Available pool.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to investigate the blueprint configuration.
    `,
      };
    }
  }

  export namespace LeaseFrozen {
    export function byBudgetUser(
      event: SpendFrozenEvent,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject: `[Informational] Innovation Sandbox: Account Freeze Action based on ${frozenBySpendBasis(event)}`,
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} under your lease ID: ${event.Detail.leaseId.uuid} ${frozenBySpendClause(event)}.
      You will no longer be able to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.</p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} under your lease ID: ${event.Detail.leaseId.uuid} ${frozenBySpendClause(event)}.
      You will no longer be able to access your account. Contact your Innovation Sandbox on AWS administrator or manager for assistance.
    `,
      };
    }

    export function byBudgetAdminManager(
      event: SpendFrozenEvent,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject: `[Action Required] Innovation Sandbox: Account Freeze Action based on ${frozenBySpendBasis(event)}`,
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} ${frozenBySpendClause(event)}.
      Sandbox users will no longer be able to access this account. The resources being used in the account will
      continue to be billed. Take one of the following timely actions:
        <p>
        a) Review the account with the sandbox user(s) to terminate resources that are no longer needed to reduce cost.
        Guide the users on ways to stay within the budget limit and if necessary, manually grant them access to the
        account to resume sandbox use.
        </p>
        <p>
        OR
        </p>
        <p>
        b) Review the account and initiate clean-up action through Innovation Sandbox on AWS.
        </p>
        <p>
        OR
        </p>
        <p>
        c) To continue using the account beyond its budget limit, use Innovation Sandbox on AWS
        to eject the account to the 'Exit' OU and then move it elsewhere from there.
        </p>
      </p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} ${frozenBySpendClause(event)}.
      Sandbox users will no longer be able to access this account. The resources being used in the account will
      continue to be billed. Take one of the following timely actions:
        a) Review the account with the sandbox user(s) to terminate resources that are no longer needed to reduce cost.
        Guide the users on ways to stay within the budget limit and if necessary, manually grant them access to the
        account to resume sandbox use.
        OR
        b) Review the account and initiate clean-up action through Innovation Sandbox on AWS.
        OR
        c) To continue using the account beyond its budget limit, use Innovation Sandbox on AWS
        to eject the account to the 'Exit' OU and then move it elsewhere from there.
    `,
      };
    }

    export function byDurationUser(
      event: LeaseFrozenEvent<"Expired">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Account Freeze Action based on Lease Duration",
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} for your lease ID: ${event.Detail.leaseId.uuid} has been frozen since the lease duration
      has reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease
      duration of ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer be able to access your account.
      Contact your Innovation Sandbox on AWS administrator or manager for assistance.</p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} for your lease ID: ${event.Detail.leaseId.uuid} has been frozen since the lease duration
      has reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease
      duration of ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer be able to access your account.
      Contact your Innovation Sandbox on AWS administrator or manager for assistance.
    `,
      };
    }

    export function byDurationAdminManager(
      event: LeaseFrozenEvent<"Expired">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject:
          "[Action Required] Innovation Sandbox: Account Freeze Action based on Lease Duration",
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} for lease ID: ${event.Detail.leaseId.uuid} has been frozen since the lease duration has
      reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease duration of
      ${event.Detail.reason.leaseDurationInHours} hour(s). Sandbox users will no longer be able to access this account.
      The resources being used in the account will continue to be billed. Take one of the following timely
      actions after reviewing your account:
        <p>
        a) To continue using the account beyond its lease duration, use Innovation Sandbox on AWS
        to eject the account to the 'Exit' OU and then move it elsewhere from there.
        </p>
        <p>
        OR
        </p>
        <p>
        b) You can initiate the clean-up action to delete the resources in this account through
        Innovation Sandbox on AWS.
        </p>
      </p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} for lease ID: ${event.Detail.leaseId.uuid} has been frozen since the lease duration has
      reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease duration of
      ${event.Detail.reason.leaseDurationInHours} hour(s). Sandbox users will no longer be able to access this account.
      The resources being used in the account will continue to be billed. Take one of the following timely
      actions after reviewing your account:
        a) To continue using the account beyond its lease duration, use Innovation Sandbox on AWS
        to eject the account to the 'Exit' OU and then move it elsewhere from there.
        OR
        b) You can initiate the clean-up action to delete the resources in this account through
        Innovation Sandbox on AWS.
    `,
      };
    }

    export function byManuallyFrozenUser(
      event: LeaseFrozenEvent<"ManuallyFrozen">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject: "[Informational] Innovation Sandbox: Account Frozen Action",
        htmlBody: `
      <p>The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been frozen
      by an Innovation Sandbox on AWS administrator or manager. You will no longer be able to access your account. Contact your Innovation Sandbox
      administrator or manager for assistance.</p>
    `,
        textBody: `
      The account ID: ${event.Detail.accountId} under lease ID: ${event.Detail.leaseId.uuid} has been frozen
      by an Innovation Sandbox on AWS administrator or manager. You will no longer be able to access your account. Contact your Innovation Sandbox
      administrator or manager for assistance.
    `,
      };
    }
  }

  export function LeaseProvisioningFailed(
    event: LeaseProvisioningFailedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject:
        "[Action Required] Innovation Sandbox: Blueprint Deployment Failed",
      htmlBody: `
      <p>Blueprint deployment failed for "${event.Detail.blueprintName}" on lease ID: ${event.Detail.leaseId.uuid}, account ID: ${event.Detail.accountId}.
      The lease has been reset to PendingApproval status and requires manager re-approval.
      The account (${event.Detail.accountId}) will be cleaned up and returned to the Available pool.
      Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to investigate the blueprint configuration and retry the approval.</p>
    `,
      textBody: `
      Blueprint deployment failed for "${event.Detail.blueprintName}" on lease ID: ${event.Detail.leaseId.uuid}, account ID: ${event.Detail.accountId}.
      The lease has been reset to PendingApproval status and requires manager re-approval.
      The account (${event.Detail.accountId}) will be cleaned up and returned to the Available pool.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to investigate the blueprint configuration and retry the approval.
    `,
    };
  }

  export function AssignmentCreated(
    event: AssignmentCreatedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    const principalLabel =
      event.Detail.assigneeEmail ?? event.Detail.principalId;
    return {
      to: context.destination.to!,
      subject: "[Informational] Innovation Sandbox: Access granted to a lease",
      htmlBody: `
      <p>Access for ${escapeHtml(principalLabel)} to sandbox lease (ID: ${escapeHtml(event.Detail.leaseId)}) for account ID: ${escapeHtml(event.Detail.accountId)} has been granted by ${escapeHtml(event.Detail.addedBy)}.</p>
      <p>Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> to view lease details.</p>
    `,
      textBody: `
      Access for ${principalLabel} to sandbox lease (ID: ${event.Detail.leaseId}) for account ID: ${event.Detail.accountId} has been granted by ${event.Detail.addedBy}.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} to view lease details.
    `,
    };
  }

  export function AssignmentRemoved(
    event: AssignmentRemovedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    const principalLabel =
      event.Detail.assigneeEmail ?? event.Detail.principalId;
    return {
      to: context.destination.to!,
      subject:
        "[Informational] Innovation Sandbox: Access removed from a lease",
      htmlBody: `
      <p>Access for ${escapeHtml(principalLabel)} to sandbox lease (ID: ${escapeHtml(event.Detail.leaseId)}) for account ID: ${escapeHtml(event.Detail.accountId)} has been removed.</p>
      <p>Sign in to <a href="${context.webAppUrl}">Innovation Sandbox on AWS</a> for more details.</p>
    `,
      textBody: `
      Access for ${principalLabel} to sandbox lease (ID: ${event.Detail.leaseId}) for account ID: ${event.Detail.accountId} has been removed.
      Sign in to Innovation Sandbox on AWS ${context.webAppUrl} for more details.
    `,
    };
  }
}
