# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2025-07-24

### Security

- Upgraded `form-data` to mitigate [CVE-2025-7783](https://nvd.nist.gov/vuln/detail/CVE-2025-7783)

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
