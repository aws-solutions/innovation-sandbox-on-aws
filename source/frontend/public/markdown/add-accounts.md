---
title: Add Accounts
---

Register AWS accounts from your organization to make them available as sandbox environments for users.

---

## Unregistered Accounts

The table displays AWS accounts staged within the "Entry" organizational unit (OU) that are not yet registered with Innovation Sandbox. These accounts are available to be added to the account pool.

---

## Register Accounts

Select one or more accounts from the table and choose **Register** to add them to the account pool.

**Important**: Registered accounts will undergo automated cleanup to remove all existing resources. This process is irreversible and permanently deletes all resources in the selected accounts.

For more information, see [Managing the account pool](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#new-accounts).

---

## Account Cleanup Process

After registration, accounts enter a cleanup phase where all supported resources are deleted. This ensures accounts are in a clean state before being made available for lease requests.

Cleanup typically takes 5-30 minutes depending on the resources present in the account.
