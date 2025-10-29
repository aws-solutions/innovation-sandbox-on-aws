---
title: Assign Lease
---

The **Assign Lease** page allows Admins and Managers to create leases directly on behalf of other users without requiring approval.

**Lease Assignment** is useful for controlled distribution scenarios such as workshops, training sessions, hackathons, or enterprise innovation initiatives where accounts need to be pre-allocated to specific users.

---

**Step 1: Select Lease Template**
Choose from any available lease template (both public and private templates are available for assignment). Private templates are only visible to Admins and Managers and are ideal for specialized environments or controlled access situations.

**Step 2: Select User**
Enter the email address of the user you want to assign the lease to. This must match their email address in AWS IAM Identity Center. The target user must exist in IAM Identity Center before you can assign a lease to them.

**Step 3: Terms of Service**
Accept the terms of service on behalf of the assigned user. You are responsible for ensuring the assigned user understands and agrees to the terms of service.

**Step 4: Review & Assign**
Review the assignment details and optionally add comments about the assignment for audit purposes. Once submitted, the lease will be created immediately without requiring approval.

---

**Important Notes**

- The target user will receive an email notification when a lease is created on their behalf
- The lease will be active immediately upon creation
- You can assign leases from any template (public or private) regardless of who created the template
- The "Created by" field will show your email address for audit tracking
- Users cannot decline assigned leases, but Admins can delete unwanted leases if needed

**Use Cases**

- **Educational workshops**: Pre-provision accounts for students before classes begin
- **Training sessions**: Bulk-assign accounts for new employee cohorts
- **Hackathons**: Distribute pre-configured environments to participants at event start time
- **Innovation projects**: Allocate specialized environments to team members for specific projects

For more information, refer to the [Assigning leases to users](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#assigning-leases) section.
