---
title: Home
---

The Innovation Sandbox on AWS solution helps you set up and manage temporary sandbox environments. Depending on your role (Admin, Manager, User), you will see different options available for you on the UI.

---

**Admins and Managers** can [approve or deny lease requests](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#approve-reject-account-lease) for sandbox environments. They are notified via email when a new request is pending review.

Admins and Managers can [assign leases directly to users](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#assigning-leases) without requiring approval. This is useful for workshops, training sessions, or controlled distribution scenarios.

Admins can [manage existing accounts](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#manage-accounts) in the account pool, and view a list of all sandbox accounts.

The solution manages the account status throughout the usage lifecycle, when it moves the account across various AWS organizational units. Refer to the [Account states](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#account-states) section.

---

**Users** can [request a new sandbox account](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/user-section.html#request-new-account-lease). If you cannot see your new sandbox requests, click the **Refresh** icon from the My Accounts section, or refresh your browser to view your new requests.
Your request will be reviewed and an outcome provided on the request.

- _Your lease is pending approval_
  You will receive an email notification when an Admin or Manager approves your request. The lease duration starts only after your sandbox request is approved.

- _Your lease request has been denied_
  Your request could be denied due to various factors:

  - Unavailability of additional budget to run sandbox experiments.
  - There are no accounts available in the account pool and the Admin will need to create new accounts or move existing accounts.
  - You may have exceeded the maximum number of leases allowed for a user.

    If your request was denied, reach out to your Admin to understand the reason, and retry the request at a later time.

To access your AWS account associated with your sandbox after it has been approved, choose **Login to account**. Your remaining budget and lease duration is displayed under **My Accounts**.
