---
title: Lease Template
---

The **Lease Templates** page displays all your available lease templates.

A **lease template** defines the conditions that govern the use of the account - such as approval for a user to use a given account, budget threshold actions, lease duration threshold actions, cost reporting group assignments, and template visibility controls.

**Template Visibility**: Templates can be set as **Public** (visible to all users for self-service requests) or **Private** (visible only to Admins and Managers for direct lease assignment).

---

**Add new lease template**
An Admin or a Manager can create a new lease template, set approval methods, set a maximum budget or duration for the lease template, set up cost reporting groups, and configure visibility settings. For more information, refer to the [Creating and managing lease templates](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#creating-managing-lease-templates) page.

**Template Visibility Options**:

- **Public**: Template appears in the general listing and users can request leases from it
- **Private**: Template is only visible to Admins and Managers for direct lease assignment to users

We recommend periodically reviewing and deleting unused lease templates to prevent users from using them to request new sandbox accounts.

**Update existing lease templates**
To update current lease template settings, select the name of the lease template.

**Note**: Updates to the lease template only affect new leases and does not impact existing active leases.

**Delete an existing lease template**
When you delete a lease template, it is removed from the list of templates, and users will no longer be able to create new sandbox requests based on that template. Existing leases that are based on deleted lease templates are not affected.
