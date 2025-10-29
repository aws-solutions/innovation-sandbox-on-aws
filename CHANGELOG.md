# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
