// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { SynthesizedEmail } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";

// either to or bcc, but not both
// no need to support that
// the retry logic will be complex if we support that
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

export namespace EmailTemplates {
  export function LeaseRequested(
    event: LeaseRequestedEvent,
    context: EmailTemplatesContext,
  ): SynthesizedEmail {
    return {
      bcc: context.destination.bcc!,
      subject: "[Action Needed] Innovation Sandbox: New Lease Approval Request",
      htmlBody: `
    <h1>Request to approve or deny lease from ${event.Detail.userEmail} </h1>
    <p> A new lease has been requested by sandbox user ${event.Detail.userEmail}.
    Please log into the Innovation Sandbox web application ${context.webAppUrl} to approve or deny the lease request.</p>
    `,
      textBody: `
      Request to approve or deny lease from ${event.Detail.userEmail}
      A new lease has been requested by sandbox user ${event.Detail.userEmail}.
      Please log into the Innovation Sandbox on AWS web application ${context.webAppUrl} to approve or deny the lease request.
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
      <h1>Welcome to Innovation Sandbox on AWS (ISB) ${event.Detail.userEmail}!</h1>
      <p>Your sandbox lease request ${event.Detail.leaseId} has been ${event.Detail.approvedBy === "AUTO_APPROVED" ? "auto approved" : "approved by " + event.Detail.approvedBy}.
      Please log into the Innovation Sandbox web application ${context.webAppUrl} to access your sandbox account.</p>
    `,
      textBody: `
      Welcome to Innovation Sandbox on AWS ${event.Detail.userEmail}!
      Your sandbox lease request ${event.Detail.leaseId} has been ${event.Detail.approvedBy === "AUTO_APPROVED" ? "auto approved" : "approved by " + event.Detail.approvedBy}.
      Please log into the Innovation Sandbox web application ${context.webAppUrl} to access your sandbox account.
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
      Please contact your Innovation Sandbox administrator / manager for more details. Thank you! </p>
    `,
      textBody: `
       Your sandbox lease request ${event.Detail.leaseId} has been denied by ${event.Detail.deniedBy}.
       Please contact your Innovation Sandbox administrator / manager for more details. Thank you!
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
      <p> The usage cost for your account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} has reached the budget threshold of
      USD ${event.Detail.budgetThresholdTriggered} against the assigned budget of USD ${event.Detail.budget}. Please review the AWS
      resources running in your account and operate within the prescribed budget limit to avoid freeze or clean-up
      actions on your account.</p>
    `,
      textBody: `
      The usage cost for your account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} has reached the budget threshold of
      USD ${event.Detail.budgetThresholdTriggered} against the assigned budget of USD ${event.Detail.budget}. Please review the AWS
      resources running in your account and operate within the prescribed budget limit to avoid freeze or clean-up
      actions on your account.
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
      <p> Your lease id: ${event.Detail.leaseId.uuid} for account id: ${event.Detail.accountId} usage has reached the lease duration threshold
      of ${event.Detail.leaseDurationInHours - event.Detail.triggeredDurationThreshold} hour(s) against the assigned lease duration ${event.Detail.leaseDurationInHours} hour(s).
      Please ensure you complete all tasks before your sandbox account access expires. </p>
    `,
      textBody: `
      Your lease id: ${event.Detail.leaseId.uuid} for account id: ${event.Detail.accountId} usage has reached the lease duration threshold
      of ${event.Detail.leaseDurationInHours - event.Detail.triggeredDurationThreshold} hour(s) against the assigned lease duration ${event.Detail.leaseDurationInHours} hour(s).
      Please ensure you complete all tasks before your sandbox account access expires.
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
      <p> The resource clean-up process for account id: ${event.Detail.accountId} failed since some resources could not be
      deleted automatically. Please review the account to clean-up the remaining resources manually and
      use the Innovation Sandbox web application to re-initiate the clean-up action.
    `,
      textBody: `
      The resource clean-up process for account id: ${event.Detail.accountId} failed since some resources could not be
      deleted automatically. Please review the account to clean-up the remaining resources manually and
      use the Innovation Sandbox web application to re-initiate the clean-up action.
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
        ? `<p> The account id: ${event.Detail.accountId} was expected to be in ${event.Detail.expectedOu} OU, but it was found in ${event.Detail.actualOu}.
       The account has been moved to the quarantine OU by the system.</p>
      `
        : `<p> Untracked account id: ${event.Detail.accountId}  was found in ${event.Detail.actualOu}.
       The account has been moved to the quarantine OU by the system.</p>
      `,
      textBody: event.Detail.expectedOu
        ? `
      The account id: ${event.Detail.accountId} was expected to be in ${event.Detail.expectedOu} OU, but it was found in ${event.Detail.actualOu}.
      The account has been moved to the quarantine OU by the system.
    `
        : `
      Untracked account id: ${event.Detail.accountId}  was found in ${event.Detail.actualOu}.
       The account has been moved to the quarantine OU by the system
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
      <p> The lease id: ${event.Detail.leaseId.uuid} for account id: ${event.Detail.accountId} has been unfrozen
      with the new budget limit of \$${event.Detail.maxBudget} and lease duration of ${event.Detail.leaseDurationInHours}
      hours. Please log into the Innovation Sandbox web application ${context.webAppUrl} to access your sandbox account
      and use within the prescribed limits.</p>
    `,
      textBody: `
      The lease id: ${event.Detail.leaseId.uuid} for account id: ${event.Detail.accountId} has been unfrozen
      with the new budget limit of \$${event.Detail.maxBudget} and lease duration of ${event.Detail.leaseDurationInHours}
      hours. Please log into the Innovation Sandbox web application ${context.webAppUrl} to access your sandbox account
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

        <p>The monthly cost report for ${event.Detail.reportMonth} failed to be generated. Please check the
        CloudWatch logs ${event.Detail.logName} for more details and retry the cost report generation if needed.</p>
      `,
      textBody: `
        Group Cost Report Generation Failed

        The monthly cost report for ${event.Detail.reportMonth} failed to be generated. Please check the
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
      <p> The resource clean-up process has been initiated for lease id: ${event.Detail.leaseId.uuid} on account id: ${event.Detail.accountId}
      since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. You will no longer be able
      to access your account. Please contact your Innovation Sandbox administrator / manager for assistance. </p>`,
        textBody: `
        The resource clean-up process has been initiated for lease id: ${event.Detail.leaseId.uuid} on account id: ${event.Detail.accountId} since
        usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. You will no longer be able
        to access your account. Please contact your Innovation Sandbox administrator / manager for assistance.
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
        <p> The resource clean-up process has been initiated for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
        since usage cost has reached or exceeded the assigned budget of USD ${event.Detail.reason.budget}. Upon successful clean-up,
        the account will be moved under 'Available' OU. You will be notified if any manual intervention is
        required to complete the resource clean-up process. </p>
      `,
        textBody: `
        The resource clean-up process has been initiated for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
        since usage cost has reached the assigned budget of USD ${event.Detail.reason.budget}. Upon successful clean-up,
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
          <p> The resource clean-up process has been initiated for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
          since the lease has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer
          be able to access your account. Please contact your Innovation Sandbox administrator / manager for assistance. </p>
        `,
        textBody: `
        The resource clean-up process has been initiated for lease  for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
        since the lease has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer
        be able to access your account. Please contact your Innovation Sandbox administrator / manager for assistance.
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
      <p> The resource clean-up process has been initiated for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
      since it has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). Upon successful clean-up,
      the account will be moved to ‘Available' OU. You will be notified if any manual intervention is required
      to complete the resource clean-up process. </p>
    `,
        textBody: `
    The resource clean-up process has been initiated for account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
    since it has reached the maximum lease duration ${event.Detail.reason.leaseDurationInHours} hour(s). Upon successful clean-up,
    the account will be moved to ‘Available' OU. You will be notified if any manual intervention is required
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
        <p>
        Your lease for account account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
         has been manually terminated by an administrator. You will no longer be able to access this account.
         Please contact your administrator / manager with any questions.
        </p>
    `,
        textBody: `
        Your lease for account account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid}
         has been manually terminated by an administrator. You will no longer be able to access this account.
         Please contact your administrator / manager with any questions.
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
      <p> The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is quarantined
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance. </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is quarantined
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance.
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
      <p> The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is ejected
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance. </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is ejected
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance.
    `,
      };
    }
  }

  export namespace LeaseFrozen {
    export function byBudgetUser(
      event: LeaseFrozenEvent<"BudgetExceeded">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        to: context.destination.to!,
        subject:
          "[Informational] Innovation Sandbox: Account Freeze Action based on Allowed Budget",
        htmlBody: `
      <p> The account id: ${event.Detail.accountId} under your lease id: ${event.Detail.leaseId.uuid} has been frozen since usage cost has reached
      the freeze threshold of USD ${event.Detail.reason.triggeredBudgetThreshold} against the assigned budget of USD ${event.Detail.reason.budget}.
      You will no longer be able to access your account. Please contact your Innovation Sandbox administrator / manager for assistance.  </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} under your lease id: ${event.Detail.leaseId.uuid} has been frozen since usage cost has reached
      the freeze threshold of USD ${event.Detail.reason.triggeredBudgetThreshold} against the assigned budget of USD ${event.Detail.reason.budget}.
      You will no longer be able to access your account. Please contact your Innovation Sandbox administrator / manager for assistance.
    `,
      };
    }

    export function byBudgetAdminManager(
      event: LeaseFrozenEvent<"BudgetExceeded">,
      context: EmailTemplatesContext,
    ): SynthesizedEmail {
      return {
        bcc: context.destination.bcc!,
        subject:
          "[Action Needed] Innovation Sandbox: Account Freeze Action based on Allowed Budget",
        htmlBody: `
      <p> The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} has been frozen since usage cost has reached the
      freeze threshold of USD ${event.Detail.reason.triggeredBudgetThreshold} against the assigned budget of USD ${event.Detail.reason.budget}.
      Sandbox users will no longer be able to access this account. The resources being used in the account will
      continue to be billed. Please do one of the following timely actions:
        <p>
        a) Review the account with the sandbox user(s) to terminate resources that are no longer needed to reduce cost.
        Guide the users on ways to stay within the budget limit and if necessary, manually grant them access to the
        account to resume sandbox use.
        </p>
        <p>
        OR
        </p>
        <p>
        b) Review the account and initiate Clean-up action through the Innovation Sandbox web application.
        </p>
        <p>
        OR
        </p>
        <p>
        c) If you wish to continue using the account beyond its budget limit, you can using the Innovation Sandbox
        web application to eject the account to the 'Exit' OU and then move it else where from there.
        </p>
      </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} has been frozen since usage cost has reached the
      freeze threshold of USD ${event.Detail.reason.triggeredBudgetThreshold} against the assigned budget of USD ${event.Detail.reason.budget}.
      Sandbox users will no longer be able to access this account. The resources being used in the account will
      continue to be billed. Please do one of the following timely actions:
        a) Review the account with the sandbox user(s) to terminate resources that are no longer needed to reduce cost.
        Guide the users on ways to stay within the budget limit and if necessary, manually grant them access to the
        account to resume sandbox use.
        OR
        b) Review the account and initiate clean-up action through the Innovation Sandbox web application.
        c) If you wish to continue using the account beyond its budget limit, you can using the Innovation Sandbox
        web application to eject the account to the 'Exit' OU and then move it else where from there.
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
      <p> The account id: ${event.Detail.accountId} for your lease id: ${event.Detail.leaseId.uuid} has been frozen since the lease duration
      has reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease
      duration of ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer be able to access your account.
      Please contact your Innovation Sandbox administrator / manager for assistance.  </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} for your lease id: ${event.Detail.leaseId} has been frozen since the lease duration
       has reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease
       duration of ${event.Detail.reason.leaseDurationInHours} hour(s). You will no longer be able to access your account.
       Please contact your Innovation Sandbox administrator / manager for assistance.
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
          "[Action Needed] Innovation Sandbox: Account Freeze Action based on Lease Duration",
        htmlBody: `
      <p> The account id: ${event.Detail.accountId} for lease id: ${event.Detail.leaseId.uuid} has been frozen since the lease duration has
      reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease duration of
      ${event.Detail.reason.leaseDurationInHours} hour(s). Sandbox users will no longer be able to access this account.
      The resources being used in the account will continue to be billed. Please do one of the following timely
      actions after reviewing your account:
      <p>
        a) If you wish to continue using the account beyond its lease duration, you can using the Innovation Sandbox
        web application to eject the account to the 'Exit' OU and then move it else where from there.
      </p>
      <p>
        OR
      </p>
      <p>
        b) You can initiate the clean-up action to delete the resources in this account through the Innovation
        Sandbox web application.
      </p>
     . </p>
     `,
        textBody: `
       The account id: ${event.Detail.accountId} for lease id: ${event.Detail.leaseId.uuid} has been frozen since the lease duration has
      reached the freeze threshold of ${event.Detail.reason.leaseDurationInHours - event.Detail.reason.triggeredDurationThreshold} hour(s) against the total lease duration of
      ${event.Detail.reason.leaseDurationInHours} hour(s). Sandbox users will no longer be able to access this account.
      The resources being used in the account will continue to be billed. Please do one of the following timely
      actions after reviewing your account:
        a) If you wish to continue using the account beyond its lease duration, you can using the Innovation Sandbox
        web application to eject the account to the 'Exit' OU and then move it else where from there.
        OR
        b) You can initiate the clean-up action to wipe the resources in this account through the Innovation
        Sandbox web application.
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
      <p> The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is frozen
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance. </p>
    `,
        textBody: `
      The account id: ${event.Detail.accountId} under lease id: ${event.Detail.leaseId.uuid} is frozen
      by an Innovation Sandbox administrator / manger. You will no longer be able to access your account. Please contact your Innovation Sandbox
      administrator / manager for assistance.
    `,
      };
    }
  }
}
