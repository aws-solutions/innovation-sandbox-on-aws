---
title: Lease Assignments
---

Manage who has access to this lease and which permission set each user or group uses.

---

## Permission set selection

Each principal appears once and uses one permission set. New assignments start with the lease's default permission set. You can choose any additional permission set allowed by the lease.

An unavailable custom permission set cannot be used for new grants. Approval and unfreeze proceed, but affected assignments report errors. Existing access is retained. You can remove the assignment or change it to an available permission set.

---

## Staged changes

Additions, removals, and permission-set changes are staged locally until you choose **Save changes**. Choose **Undo** to reverse a staged removal or replacement. Navigate away without saving to discard all staged changes.

---

## Principal types

**User**: Access granted directly to an individual.

**Group**: Access granted via an Identity Center group. All group members gain access automatically.

---

## Processing states

After saving, assignments show processing status while access is granted or revoked in IAM Identity Center. Expand a row to view the grant and revoke operations involved in a permission-set replacement. A completed revoke removes future federation access but does not terminate an existing session.

If an operation fails, retry the failed changes after resolving the reported issue. **Revoke failed** can mean the principal still has access and requires operator attention.

---

## Who can manage assignments

**Admins and Managers** can add, remove, or change assignments while the lease is **Active**.

**Lease Owners** can manage assignments while the lease is **Active** when lease sharing is enabled in the solution settings and **Allow owner to share lease** is enabled on the lease.

For more information, see [Sharing leases](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#sharing-leases).
