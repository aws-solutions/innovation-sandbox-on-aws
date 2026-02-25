# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-02-25

### Added

- Blueprint management for registering, configuring, and tracking CloudFormation StackSets as reusable infrastructure templates ([#34](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/34))
  - Configurable deployment strategies with region targeting, concurrency controls, and failure tolerance
  - Automated blueprint deployment to sandbox accounts during lease provisioning, orchestrated through AWS Step Functions
  - `Provisioning` and `ProvisioningFailed` lease statuses to track blueprint deployment progress during lease approval
  - Deployment history per blueprint with health metrics (successful deployments, deployment history, last deployment time)
  - Blueprint management UI with registration wizard, detail view, deployment history visualization, and editing for basic details and deployment configuration
  - Blueprint association on lease templates, allowing administrators to attach or detach blueprints during template creation or update
- Dedicated detail and edit pages for leases and lease templates covering duration, budget, cost report, and blueprint settings
- Version update alert in the navigation bar when a newer version of the solution is available ([#45](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/45))
- AWS WAF logging to Amazon CloudWatch Logs and alarm on blocked requests
- Validation that the `InnovationSandbox-<namespace>-SandboxAccountRole` role exists in a sandbox account before starting cleanup, reducing unnecessary cleanup attempts

### Fixed

- Sorting on date and status columns in frontend tables by adding dedicated sorting comparators
- Cross-stack reference issue where updates to the account pool stack were not reflected in the compute stack due to deploy-time resolution

### Changed

- Lease approval workflow now supports two paths: immediate access (no blueprint) or deferred access after blueprint deployment completes
- Miscellaneous UX improvements to the frontend application

### Security

- Added JWT signature verification at Lambda middleware layer to prevent authentication bypass when API Gateway is bypassed ([#93](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/93))
- Upgraded `fast-xml-parser` to mitigate:
  - [CVE-2026-25896](https://nvd.nist.gov/vuln/detail/CVE-2026-25896)
  - [CVE-2026-26278](https://nvd.nist.gov/vuln/detail/CVE-2026-26278)
- Upgraded `ajv` to mitigate [CVE-2025-69873](https://nvd.nist.gov/vuln/detail/CVE-2025-69873)
- Upgraded `qs` to mitigate [CVE-2026-2391](https://nvd.nist.gov/vuln/detail/CVE-2026-2391)

## [1.1.8] - 2026-02-04

### Security

- Upgraded `aws-nuke` to mitigate:
  - [CVE-2025-61726](https://nvd.nist.gov/vuln/detail/CVE-2025-61726)
  - [CVE-2025-8732](https://nvd.nist.gov/vuln/detail/CVE-2025-8732)
  - [CVE-2025-61728](https://nvd.nist.gov/vuln/detail/CVE-2025-61728)
  - [CVE-2025-61730](https://nvd.nist.gov/vuln/detail/CVE-2025-61730)
- Upgraded `fast-xml-parser` to mitigate [CVE-2026-25128](https://nvd.nist.gov/vuln/detail/CVE-2026-25128)
- Upgraded `lodash` to mitigate [CVE-2025-13465](https://nvd.nist.gov/vuln/detail/CVE-2025-13465)

## [1.1.7] - 2026-01-20

### Fixed

- Upgraded `aws-nuke` to v3.63.2 to resolve discovery short-circuit behavior when encountering SCP-protected log groups

## [1.1.6] - 2026-01-12

### Security

- Upgraded `@remix-run/router` to mitigate [CVE-2026-22029](https://nvd.nist.gov/vuln/detail/CVE-2026-22029)
- Upgraded `glib2` to mitigate [CVE-2025-14087](https://nvd.nist.gov/vuln/detail/CVE-2025-14087)
- Upgraded `libcap` to mitigate:
  - [CVE-2025-61727](https://nvd.nist.gov/vuln/detail/CVE-2025-61727)
  - [CVE-2025-61729](https://nvd.nist.gov/vuln/detail/CVE-2025-61729)
- Upgraded `python3` to mitigate:
  - [CVE-2025-12084](https://nvd.nist.gov/vuln/detail/CVE-2025-12084)
  - [CVE-2025-13837](https://nvd.nist.gov/vuln/detail/CVE-2025-13837)
- Upgraded `python3-libs` to mitigate:
  - [CVE-2025-12084](https://nvd.nist.gov/vuln/detail/CVE-2025-12084)
  - [CVE-2025-13837](https://nvd.nist.gov/vuln/detail/CVE-2025-13837)
- Upgraded `python-unversioned-command` to mitigate:
  - [CVE-2025-12084](https://nvd.nist.gov/vuln/detail/CVE-2025-12084)
  - [CVE-2025-13837](https://nvd.nist.gov/vuln/detail/CVE-2025-13837)

## [1.1.5] - 2026-01-05

### Security

- Upgraded `qs` to mitigate [CVE-2025-15284](https://nvd.nist.gov/vuln/detail/CVE-2025-15284)

## [1.1.4] - 2025-12-16

### Security

- Upgraded `aws-nuke` to mitigate:
  - [CVE-2025-61729](https://nvd.nist.gov/vuln/detail/CVE-2025-61729)
  - [CVE-2025-61727](https://nvd.nist.gov/vuln/detail/CVE-2025-61727)

## [1.1.3] - 2025-12-10

### Security

- Upgraded `jws` to mitigate [CVE-2025-65945](https://nvd.nist.gov/vuln/detail/CVE-2025-65945)
- Upgraded `mdast-util-to-hast` to mitigate [CVE-2025-66400](https://nvd.nist.gov/vuln/detail/CVE-2025-66400)
- Upgraded `curl-minimal` to mitigate [CVE-2025-11563](https://explore.alas.aws.amazon.com/CVE-2025-11563.html)
- Upgraded `libcurl-minimal` to mitigate [CVE-2025-11563](https://explore.alas.aws.amazon.com/CVE-2025-11563.html)
- Upgraded `glib2` to mitigate [CVE-2025-13601](https://nvd.nist.gov/vuln/detail/CVE-2025-13601)
- Upgraded `python-unversioned-command` to mitigate [CVE-2025-6075](https://nvd.nist.gov/vuln/detail/CVE-2025-6075)
- Upgraded `python3-libs` to mitigate [CVE-2025-6075](https://nvd.nist.gov/vuln/detail/CVE-2025-6075)
- Upgraded `python3` to mitigate [CVE-2025-6075](https://nvd.nist.gov/vuln/detail/CVE-2025-6075)

## [1.1.2] - 2025-11-20

### Security

- Upgraded `js-yaml` to mitigate [CVE-2025-64718](https://nvd.nist.gov/vuln/detail/CVE-2025-64718)
- Upgraded `glob` to mitigate [CVE-2025-64756](https://nvd.nist.gov/vuln/detail/CVE-2025-64756)

## [1.1.1] - 2025-11-14

### Fixed

- Issue preventing cost report group from being set when `requireCostGroup` is set to `true` in AppConfig

### Security

- Upgraded `libcap` to mitigate:
  - [CVE-2025-58188](https://nvd.nist.gov/vuln/detail/CVE-2025-58188)
  - [CVE-2025-58185](https://nvd.nist.gov/vuln/detail/CVE-2025-58185)
  - [CVE-2025-58186](https://nvd.nist.gov/vuln/detail/CVE-2025-58186)
  - [CVE-2025-61723](https://nvd.nist.gov/vuln/detail/CVE-2025-61723)
  - [CVE-2025-61725](https://nvd.nist.gov/vuln/detail/CVE-2025-61725)

## [1.1.0] - 2025-10-29

### Added

- Lease unfreezing capability allowing users to reinstate frozen leases ([#42](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/42))
- Cost reporting groups feature for tracking and reporting costs by organizational groups ([#43](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/43))
- Lease assignment functionality allowing administrators and managers to assign leases to other users([#44](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/44))
- Prioritization of accounts that have been used less recently when selecting an account to use in a lease
- Visibility configuration to set lease templates as PUBLIC or PRIVATE - PUBLIC templates are visible to all users, while PRIVATE templates are only accessible to Admin and Manager roles, enabling administrators to create restricted templates for specific use cases

### Fixed

- IP allow list configuration issues ([#35](https://github.com/aws-solutions/innovation-sandbox-on-aws/pull/35)) (@maniryu)
- Filtered out Credit and Refund entries from cost explorer queries for more accurate reporting ([#36](https://github.com/aws-solutions/innovation-sandbox-on-aws/pull/47)) (@RuidiH)
- Permission issue preventing deployment of IDC stack in delegated admin account
- Execution does not exist bug in account cleaner step function

### Security

- Upgraded `aws-nuke` to mitigate:
  - [CVE-2025-47906](https://nvd.nist.gov/vuln/detail/CVE-2025-47906)
  - [CVE-2025-47907](https://nvd.nist.gov/vuln/detail/CVE-2025-47907)
- Upgraded `vite` to mitigate [CVE-2025-62522](https://nvd.nist.gov/vuln/detail/CVE-2025-62522)
- Upgraded `python3-pip` to mitigate [CVE-2025-8869](https://nvd.nist.gov/vuln/detail/CVE-2025-8869)
- Upgraded `python3-pip-wheel` to mitigate [CVE-2025-8869](https://nvd.nist.gov/vuln/detail/CVE-2025-8869)
- Upgraded `openssl-libs` to mitigate:
  - [CVE-2025-9230](https://nvd.nist.gov/vuln/detail/CVE-2025-9230)
  - [CVE-2025-9231](https://nvd.nist.gov/vuln/detail/CVE-2025-9231)
- Upgraded `openssl-fips-provider-latest` to mitigate:
  - [CVE-2025-9230](https://nvd.nist.gov/vuln/detail/CVE-2025-9230)
  - [CVE-2025-9231](https://nvd.nist.gov/vuln/detail/CVE-2025-9231)
- Upgraded `brace-expansion` to mitigate [CVE-2025-5889](https://nvd.nist.gov/vuln/detail/CVE-2025-5889)

## [1.0.5] - 2025-10-09

### Fixed

- Disabled WAF SizeRestrictions_QUERYSTRING rule blocking legitimate AWS Organizations pagination tokens on GET /accounts/unregistered endpoint when handling large numbers of accounts (>20)

### Security

- Upgraded `expat` to mitigate [CVE-2025-59375](https://nvd.nist.gov/vuln/detail/CVE-2025-59375)

## [1.0.4] - 2025-08-22

### Added

- Conditional deployment of CloudFront access logs to support regions that don't support standard logging (legacy)
- Missing AppConfig Lambda layer extension ARN for eu-central-2 region

### Fixed

- Deployment failures in regions that don't support CloudFront standard access logging (legacy)

## [1.0.3] - 2025-07-25

### Security

- Upgraded `form-data` to mitigate [CVE-2025-7783](https://nvd.nist.gov/vuln/detail/CVE-2025-7783)
- Upgraded `@node-saml/passport-saml` to mitigate [CVE-2025-54369](https://nvd.nist.gov/vuln/detail/CVE-2025-54369)

### Removed

- Removed unused dependency `axios`

## [1.0.2] - 2025-06-25

### Fixed

- Cross account SSM GetParameter sdk call targeting incorrect accountId ([#9](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/9))

## [1.0.1] - 2025-06-19

### Added

- Optional CloudFormation parameters to the IDC stack for mapping user groups from external identity providers ([#2](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/2))

### Fixed

- High latency on APIs that consume the idc service layer code (idc-service.ts) due to dynamic lookup of user groups and permission sets ([#3](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/3))
- IDC Configuration custom resource failing deployment due to large number of groups and permission sets causing timeout ([#6](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/6))

### Security

- Upgraded `aws-nuke` to mitigate:
  - [CVE-2025-22874](https://nvd.nist.gov/vuln/detail/cve-2025-22874)
  - [CVE-2025-0913](https://nvd.nist.gov/vuln/detail/cve-2025-0913)
  - [CVE-2025-4673](https://nvd.nist.gov/vuln/detail/cve-2025-4673)
- Upgraded `brace-expansion` to mitigate [CVE-2025-5889](https://nvd.nist.gov/vuln/detail/CVE-2025-5889)

## [1.0.0] - 2025-05-22

### Added

- All files, initial version
