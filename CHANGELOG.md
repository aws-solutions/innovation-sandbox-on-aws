# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.12] - 2026-06-26

### Security

- Updated amazonlinux base image digest to mitigate:
  - [CVE-2026-42504](https://nvd.nist.gov/vuln/detail/CVE-2026-42504) (golang)
  - [CVE-2026-49839](https://nvd.nist.gov/vuln/detail/CVE-2026-49839) (jq)
  - `openssl-libs`, `openssl-fips-provider-latest`:
    - [CVE-2026-34181](https://nvd.nist.gov/vuln/detail/CVE-2026-34181)
    - [CVE-2026-34182](https://nvd.nist.gov/vuln/detail/CVE-2026-34182)
    - [CVE-2026-34183](https://nvd.nist.gov/vuln/detail/CVE-2026-34183)
    - [CVE-2026-42768](https://nvd.nist.gov/vuln/detail/CVE-2026-42768)
    - [CVE-2026-45445](https://nvd.nist.gov/vuln/detail/CVE-2026-45445)
    - [CVE-2026-45447](https://nvd.nist.gov/vuln/detail/CVE-2026-45447)
  - [CVE-2026-8643](https://nvd.nist.gov/vuln/detail/CVE-2026-8643) (python3-pip, python3-pip-wheel)
- Added `form-data` override and upgraded `vite` to mitigate:
  - [CVE-2026-12143](https://nvd.nist.gov/vuln/detail/CVE-2026-12143) (form-data)
  - [CVE-2026-53571](https://nvd.nist.gov/vuln/detail/CVE-2026-53571) (vite)

## [1.2.11] - 2026-06-15

### Fixed

- BudgetProgressBar rendered an incorrect fill width; replaced the custom progress bar with the Cloudscape `ProgressBar` component ([#147](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/147))

### Security

- Upgraded `react-router` and `react-router-dom` to mitigate [CVE-2026-40181](https://nvd.nist.gov/vuln/detail/CVE-2026-40181)
- Updated amazonlinux base image digest to mitigate:
  - `jq`:
    - [CVE-2026-32316](https://nvd.nist.gov/vuln/detail/CVE-2026-32316)
    - [CVE-2026-33947](https://nvd.nist.gov/vuln/detail/CVE-2026-33947)
    - [CVE-2026-33948](https://nvd.nist.gov/vuln/detail/CVE-2026-33948)
    - [CVE-2026-39956](https://nvd.nist.gov/vuln/detail/CVE-2026-39956)
    - [CVE-2026-39979](https://nvd.nist.gov/vuln/detail/CVE-2026-39979)
    - [CVE-2026-40164](https://nvd.nist.gov/vuln/detail/CVE-2026-40164)
    - [CVE-2026-43894](https://nvd.nist.gov/vuln/detail/CVE-2026-43894)
    - [CVE-2026-43896](https://nvd.nist.gov/vuln/detail/CVE-2026-43896)
  - `libsolv`:
    - [CVE-2026-48863](https://nvd.nist.gov/vuln/detail/CVE-2026-48863)
    - [CVE-2026-48864](https://nvd.nist.gov/vuln/detail/CVE-2026-48864)
    - [CVE-2026-9149](https://nvd.nist.gov/vuln/detail/CVE-2026-9149)
    - [CVE-2026-9150](https://nvd.nist.gov/vuln/detail/CVE-2026-9150)
  - `perl-HTTP-Tiny`: [CVE-2026-7010](https://nvd.nist.gov/vuln/detail/CVE-2026-7010)
  - `perl` (and related modules): [CVE-2026-8376](https://nvd.nist.gov/vuln/detail/CVE-2026-8376)
  - `python3`, `python3-libs`, `python-unversioned-command`: [CVE-2026-6019](https://nvd.nist.gov/vuln/detail/CVE-2026-6019)

## [1.2.10] - 2026-05-28

### Security

- Upgraded `js-cookie` to mitigate [CVE-2026-46625](https://github.com/advisories/GHSA-qjx8-664m-686j)
- Upgraded `uuid` to mitigate [CVE-2026-41907](https://nvd.nist.gov/vuln/detail/CVE-2026-41907)
- Updated amazonlinux base image digest

## [1.2.9] - 2026-05-14

### Security

- Upgraded `fast-uri` to mitigate
  - [CVE-2026-6321](https://nvd.nist.gov/vuln/detail/CVE-2026-6321)
  - [CVE-2026-6322](https://nvd.nist.gov/vuln/detail/CVE-2026-6322)

## [1.2.8] - 2026-05-08

### Fixed

- Allow lease termination and freeze when user is deleted from IDC

### Security

- Updated amazonlinux base image digest to mitigate:
  - [CVE-2026-4046](https://nvd.nist.gov/vuln/detail/CVE-2026-4046) (glibc, glibc-common, glibc-minimal-langpack)
  - [CVE-2026-4786](https://nvd.nist.gov/vuln/detail/CVE-2026-4786) (python3, python3-libs, python-unversioned-command)
  - [CVE-2026-6100](https://nvd.nist.gov/vuln/detail/CVE-2026-6100) (python3, python3-libs, python-unversioned-command)

## [1.2.7] - 2026-04-27

### Security

- Upgraded `@xmldom/xmldom` to mitigate:
  - [CVE-2026-41672](https://github.com/advisories/GHSA-j759-j44w-7fr8)
  - [CVE-2026-41673](https://github.com/advisories/GHSA-2v35-w6hq-6mfw)
  - [CVE-2026-41674](https://github.com/advisories/GHSA-f6ww-3ggp-fr8h)
  - [CVE-2026-41675](https://github.com/advisories/GHSA-x6wf-f3px-wcqx)
- Upgraded `fast-xml-parser` to mitigate [CVE-2026-41650](https://github.com/advisories/GHSA-gh4j-gqv2-49f6)

## [1.2.6] - 2026-04-17

### Security

- Upgraded `libnghttp2` to mitigate [CVE-2026-27135](https://nvd.nist.gov/vuln/detail/CVE-2026-27135)
- Upgraded `openssl-fips-provider-latest` to mitigate:
  - [CVE-2026-28387](https://nvd.nist.gov/vuln/detail/CVE-2026-28387)
  - [CVE-2026-31790](https://nvd.nist.gov/vuln/detail/CVE-2026-31790)
- Upgraded `openssl-libs` to mitigate:
  - [CVE-2026-28387](https://nvd.nist.gov/vuln/detail/CVE-2026-28387)
  - [CVE-2026-31790](https://nvd.nist.gov/vuln/detail/CVE-2026-31790)
- Upgraded `python-unversioned-command` to mitigate [CVE-2026-4519](https://nvd.nist.gov/vuln/detail/CVE-2026-4519)
- Upgraded `python3` to mitigate [CVE-2026-4519](https://nvd.nist.gov/vuln/detail/CVE-2026-4519)
- Upgraded `python3-libs` to mitigate [CVE-2026-4519](https://nvd.nist.gov/vuln/detail/CVE-2026-4519)

## [1.2.5] - 2026-04-10

### Security

- Upgraded `vite` to mitigate:
  - [CVE-2026-39364](https://nvd.nist.gov/vuln/detail/CVE-2026-39364)
  - [CVE-2026-39363](https://nvd.nist.gov/vuln/detail/CVE-2026-39363)
  - [CVE-2026-39365](https://nvd.nist.gov/vuln/detail/CVE-2026-39365)
- Updated amazonlinux base image digest

## [1.2.4] - 2026-04-02

### Security

- Upgraded `aws-nuke` to mitigate:
  - [CVE-2026-25679](https://nvd.nist.gov/vuln/detail/CVE-2026-25679)
  - [CVE-2026-27137](https://nvd.nist.gov/vuln/detail/CVE-2026-27137)
- Upgraded `path-to-regexp` to mitigate:
  - [CVE-2026-4867](https://nvd.nist.gov/vuln/detail/CVE-2026-4867)
  - [CVE-2026-4926](https://nvd.nist.gov/vuln/detail/CVE-2026-4926)
- Upgraded `lodash` to mitigate [CVE-2026-4800](https://nvd.nist.gov/vuln/detail/CVE-2026-4800)

## [1.2.3] - 2026-03-26

### Security

- Upgraded `flatted` to mitigate [CVE-2026-33228](https://nvd.nist.gov/vuln/detail/CVE-2026-33228)
- Upgraded `fast-xml-parser` to mitigate [CVE-2026-33349](https://nvd.nist.gov/vuln/detail/CVE-2026-33349)

## [1.2.2] - 2026-03-19

### Security

- Upgraded `flatted` to mitigate [CVE-2026-32141](https://nvd.nist.gov/vuln/detail/CVE-2026-32141)
- Updated `fast-xml-parser` to address [CVE-2026-26278](https://github.com/advisories/GHSA-jmr7-xgp7-cmfj)

## [1.2.1] - 2026-03-05

### Security

- Upgraded `aws-nuke` to mitigate [CVE-2025-68121](https://nvd.nist.gov/vuln/detail/CVE-2025-68121)
- Upgraded `minimatch` to mitigate:
  - [CVE-2026-27903](https://nvd.nist.gov/vuln/detail/CVE-2026-27903)
  - [CVE-2026-27904](https://nvd.nist.gov/vuln/detail/CVE-2026-27904)
- Upgraded `serialize-javascript` to mitigate [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)
- Upgraded `fast-xml-parser` to mitigate [CVE-2026-27942](https://nvd.nist.gov/vuln/detail/CVE-2026-27942)

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
