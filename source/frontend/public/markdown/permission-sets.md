---
title: Permission Sets
---

View the permission sets that are registered for use with sandbox leases.

---

## Registered permission sets

The catalog lists permission sets that an administrator registered with this solution deployment. Each entry includes its name, description, and session duration.

Administrators can choose a permission set name to open its details in AWS IAM Identity Center, or choose **Manage permission sets** to open the permission-set catalog in the console, where they can create and manage permission sets. Managers can view the catalog on this page, but these console links are available only to administrators.

To register a permission set with this deployment, add the tag `ISB:<namespace>:ManagedPermissionSet` with the value `true`, replacing `<namespace>` with the deployment's configured ISB namespace. Allow time for the catalog cache to synchronize after adding the tag.

The catalog is read-only. Create, update, tag, and delete permission sets in IAM Identity Center.

---

## Find a permission set

Enter a name or description in **Find permission sets**. Use the pagination controls when additional matching results are available, or refresh the table to reload the catalog.

If a permission set is missing, confirm that it has the exact registration tag for this deployment and that it belongs to the configured IAM Identity Center instance.

_Note: The solution's Admin and Manager permission sets cannot be assigned to leases and do not appear in this catalog._

---

## Sandbox Spaces

Sandbox Spaces doesn't support permission sets that have a permissions boundary, whether AWS managed or customer managed. Users assigned such a permission set keep their normal IAM Identity Center access, but the Sandbox Spaces agent rejects their messages. For leases that use Sandbox Spaces, choose permission sets without a permissions boundary.
