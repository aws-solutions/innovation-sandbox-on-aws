---
title: Accounts
---

The **Accounts** page displays all the accounts currently in the Account Pool, regardless of their status.

---

**Managing accounts**

If the account clean-up workflow is unsuccessful, the solution will move the account to a **Quarantine** state. Accounts in the Quarantine status may have active AWS resources that still incur cost. We recommend that you investigate these accounts as soon as possible, and manually troubleshoot any issues, before attempting to retrying the clean-up process. Refer to the [Investigating accounts in Quarantine state](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/troubleshooting.html#investigating-accounts) section.

Accounts in **Frozen** status could have active AWS resources running in them that still incur cost. As a next step, you can either:

- Eject the account out of the sandbox OU structure if you want to preserve the AWS resources, or
- Clean-up the resources in the account, and reuse for sandbox experiments.

If no manual action is taken, the solution will automatically clean-up and recycle the account for reuse after final budget/duration thresholds are exceeded.

Refer to the [Managing existing accounts](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#manage-accounts) section.

When a clean-up action is initiated, the solution will complete multiple clean up attempts and update the status.

- Upon successful clean up of AWS resources in an account, the solution will move the account to the pool of available accounts for sandbox use.
- If the account clean-up workflow is unsuccessful, the solution will move the account to **Quarantine** and send an email to the Admin. You will need to manually clean-up the remaining resources and initiate the _Retry Cleanup_ action.
- If the workflow fails to move the account to **Available** or **Quarantine** status within 24 hours, the **Clean-up** status is displayed in red, and you will have to manually perform the **Retry Cleanup** action.
