---
title: Edit Access Settings
---

Configure lease sharing and the permission sets available for assignments on this lease.

---

## Lease sharing

Turn on **Allow owner to share lease** to let the lease owner manage user and group access. When it is off, only Admins and Managers can manage assignments.

Turning this setting off does not revoke existing assignments.

When lease sharing is turned off in the solution settings, you cannot turn this option on. If it was enabled previously, the control remains available so you can turn it off.

---

## Permission sets

Add up to 20 permission sets that can be selected for individual users and groups. The selected-permission-sets table shows each description and identifies the current default.

Choose **Set as default** in the table to change the permission set that new assignments use. The current default cannot be removed until another selected permission set replaces it. Changing the default does not automatically change existing assignments.

Before changing the default or removing an allowed permission set, update assignments that use a permission set that would no longer be available. If saving detects conflicting assignments, the error identifies the number of affected assignments, permission set, and canonical lease name, and links directly to the lease's **Assignments** tab.

_Note: Only Admins and Managers can edit access settings._
