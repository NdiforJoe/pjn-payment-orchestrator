# Compliance — InstaPay Payment Orchestrator

This document maps every technical control in the system to its regulatory requirement. Controls are implemented in infrastructure code, not documented separately — this file is the evidence index, not the evidence itself.

---

## Regulatory Scope

| Regulation | Why it applies |
|---|---|
| **PCI DSS v4.0** | The system processes payment transactions and stores financial records |
| **POPIA (Protection of Personal Information Act)** | South African law — the system stores consumer IDs and financial data of South African residents |

---

## PCI DSS v4.0 Control Mapping

### Requirement 2 — Apply Secure Configurations

| Control | Implementation | Evidence |
|---|---|---|
| 2.2 — System components configured and managed securely | Checkov IaC scan (Gate 5) validates CloudFormation templates against security benchmarks on every commit | `compliance-evidence/checkov-report.json` (CI artifact) |
| 2.2 — No vendor-supplied defaults | CDK constructs use explicit secure defaults — no default VPCs, no public S3 buckets, no unencrypted queues | `cdk/lib/stacks/` |

---

### Requirement 3 — Protect Stored Account Data

| Control | Implementation | Evidence |
|---|---|---|
| 3.5 — Primary account data protected | No raw PANs stored — payment processing delegated to Peach Payments (PCI DSS certified provider). This service stores only opaque consumer IDs. | `compliance-evidence/POPIA-data-manifest.md` |
| 3.5 — Encryption of stored data | DynamoDB encrypted with KMS customer-managed key (`aws_kms_key` with `enableKeyRotation: true`) | `cdk/lib/stacks/database-stack.ts` |
| 3.7 — Key management | Annual automatic key rotation enabled on KMS CMK | `cdk/lib/stacks/database-stack.ts` |

---

### Requirement 4 — Protect Cardholder Data in Transit

| Control | Implementation | Evidence |
|---|---|---|
| 4.2 — Strong cryptography for data in transit | API Gateway enforces HTTPS — HTTP is not available. DynamoDB and SQS traffic uses TLS endpoints. | `cdk/lib/stacks/api-stack.ts` |

---

### Requirement 6 — Develop and Maintain Secure Systems

| Control | Implementation | Evidence |
|---|---|---|
| 6.2 — Software inventory (SBOM) | Syft generates SPDX-format SBOM on every build (Gate 3) | `compliance-evidence/sbom.spdx.json` (CI artifact) |
| 6.3 — Identify and manage security vulnerabilities | npm audit runs on every commit, fails pipeline on critical CVEs (Gate 2) | `compliance-evidence/npm-audit.json` (CI artifact) |
| 6.4 — Public-facing web applications protected | ESLint with security rules (`no-eval`, `no-implied-eval`) + TypeScript strict mode (Gate 4) | `compliance-evidence/eslint-report.json` (CI artifact) |
| 6.4 — Code review process | All changes go through GitHub PR — Gates 1–6 must pass before merge is allowed | `.github/workflows/pipeline.yml` |

---

### Requirement 7 — Restrict Access to System Components

| Control | Implementation | Evidence |
|---|---|---|
| 7.2 — Least privilege access | CDK grant methods generate minimal IAM policies per function. fraud-service has `grantReadData` only — cannot write. order-service and debit-service have `grantReadWriteData`. | `cdk/lib/stacks/compute-stack.ts:133–138` |
| 7.2 — Policy-as-code enforcement | OPA policy gate (Gate 6) evaluates Checkov results and blocks deploy if encryption or logging checks fail | `opa-policies/pci_dss.rego` |

---

### Requirement 9 — Restrict Physical Access / Protect All Media

| Control | Implementation | Evidence |
|---|---|---|
| 9 — Data backup and recovery | DynamoDB Point-in-Time Recovery (PITR) enabled — restore to any second within the last 35 days | `cdk/lib/stacks/database-stack.ts` |

---

### Requirement 10 — Log and Monitor All Access

| Control | Implementation | Evidence |
|---|---|---|
| 10.2 — Audit log of all access | API Gateway access logs capture requestId, IP, method, path, status, latency in JSON — queryable via CloudWatch Insights | `cdk/lib/stacks/api-stack.ts` |
| 10.2 — Step Functions execution logs | All state transitions logged at `LogLevel.ALL` with `includeExecutionData: true` — every APPROVE, DECLINE, and DebitFirstInstalment action is auditable | `cdk/lib/stacks/compute-stack.ts:221–226` |
| 10.2 — Lambda function logs | Structured JSON logs via AWS Lambda Powertools. Log groups retained for 3 months. | `src/shared/logger.ts` |
| 10.3 — Log integrity | CloudWatch log groups protected by KMS encryption | `cdk/lib/stacks/compute-stack.ts` |
| 10.7 — Detect failures of security controls | AWS X-Ray active tracing enabled on all Lambda functions and the Step Functions state machine | `cdk/lib/stacks/compute-stack.ts:78,99,119` |

---

### Requirement 12 — Support Information Security with Policies

| Control | Implementation | Evidence |
|---|---|---|
| 12.3 — Risk management | SHA-pinned GitHub Actions prevent supply chain compromise (mitigates tj-actions/changed-files class of attack) | `.github/workflows/pipeline.yml` |

---

## POPIA Control Mapping

POPIA (Protection of Personal Information Act, Act 4 of 2013) applies to all personal information of South African data subjects.

### Section 14 — Information Quality / Data Minimisation

| Control | Implementation |
|---|---|
| Retain personal information only as long as necessary | Declined orders receive a DynamoDB TTL of 90 days from decline date. DynamoDB automatically purges the record — no manual cron required. |
| Minimise personal information collected | This service stores only opaque consumer IDs (no name, email, phone, ID number, address). PII resolution is handled by the identity service (out of scope). |

See `compliance-evidence/POPIA-data-manifest.md` for the full inventory of personal information stored.

### Section 19 — Security Safeguards

| Control | Implementation |
|---|---|
| Appropriate technical measures to secure personal information | KMS CMK encryption at rest, TLS in transit, least-privilege IAM, CloudWatch audit logs |
| Prevent unauthorised access | No Lambda functions have public URLs — all traffic flows through API Gateway with request validation |

---

## CI/CD Compliance Gates Summary

Every commit to `main` runs the full pipeline. Merge is blocked unless all gates pass.

```
Gate 1 — TruffleHog        Secret scanning              PCI DSS Req 3.4
Gate 2 — npm audit         Dependency CVE check         PCI DSS Req 6.3
Gate 3 — Syft SBOM         Software inventory           PCI DSS Req 6.2
Gate 4 — ESLint + tsc      SAST + type safety           PCI DSS Req 6.4
Gate 5 — Checkov           IaC security + tag policy    PCI DSS Req 2.2
Gate 6 — OPA               Policy-as-code enforcement   PCI DSS Req 7
Gate 7 — CDK Diff          Infra change visibility      change management
Gate 8 — CDK Deploy        Deploy (main only)           controlled release
Gate 9 — Infracost         Cost delta on PR             FinOps governance
```

Compliance artifacts generated per run:
- `npm-audit.json` — dependency vulnerability report
- `sbom.spdx.json` — software bill of materials
- `eslint-report.json` — SAST findings
- `checkov-report.json` — IaC security findings
- `opa-result.json` — policy evaluation result
- `cdk-diff.txt` — infrastructure change diff (PR runs only)

---

## What Is Out of Scope

| Area | Reason |
|---|---|
| Consumer PAN / card data | Delegated to Peach Payments (PCI DSS certified). This service never receives or stores card numbers. |
| Consumer identity verification | Handled by the onboarding service (DHA integration, credit bureau). Out of scope for this project. |
| Penetration testing | Required by PCI DSS Req 11. Not performed on this dev environment — required before production go-live. |
| WAF / DDoS protection | API Gateway throttling is configured. AWS WAF and Shield would be added for production. |
