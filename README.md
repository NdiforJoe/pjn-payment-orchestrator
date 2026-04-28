# InstaPay — Payment Orchestrator

Serverless BNPL (Buy Now Pay Later) payment processing engine built on AWS. Models the transaction processing layer of a pre-approved credit product: fraud scoring, immediate first-instalment debit at checkout, and scheduled instalment collection via a daily batch.

Built as a portfolio project demonstrating production-grade AWS architecture, security-first CI/CD, and FinOps cost engineering.

---

## Business Context

InstaPay is a pre-approved credit model. A consumer signs up once, passes identity verification and affordability assessment, and receives a credit limit. At merchant checkout:

1. Consumer selects InstaPay, enters their PIN
2. **Instalment 1 is debited immediately** at point of purchase
3. Instalments 2 and 3 are scheduled 30 and 60 days from the purchase date

This project implements the transaction processing layer — everything that happens from the moment `POST /orders` is received to the final instalment being collected.

---

## Architecture

```
POST /orders
     │
API Gateway  ──── REST API, request validation, access logging
     │
order-service Lambda
     │  ├── Writes order to DynamoDB (status: PENDING_FRAUD_CHECK)
     │  ├── Writes 3 instalment records (status: SCHEDULED)
     │  ├── Starts Step Functions execution (async)
     │  └── Returns 202 Accepted immediately
     │
     ▼
Step Functions — Order Orchestrator
     │
     ├── FraudCheck (fraud-service Lambda)
     │       └── Scores fraud risk 0–100, stored at $.fraudResult
     │
     ├── FraudDecision (Choice state)
     │       ├── score ≥ 75 → DeclineOrder
     │       │       └── Mark DECLINED + 90-day POPIA TTL
     │       └── score < 75 → ApproveOrder
     │               └── Mark ACTIVE
     │                       │
     │               DebitFirstInstalment (debit-service Lambda)
     │               Charges instalment 1 immediately via payment provider
     │
EventBridge — Daily cron 06:00 UTC (prod only)
     │
debit-service Lambda
     │
DynamoDB GSI2 query: DUE#<today> → all SCHEDULED instalments due today
     │
Payment provider → PAID or FAILED
```

### Consumer polling

The HTTP request does not wait for fraud scoring or approval. The order-service returns `202 Accepted` with the `orderId` immediately. Consumers poll `GET /orders/{orderId}` for the result.

> **Production consideration:** In-store QR code terminals require an immediate APPROVED/DECLINED response on screen. For that flow, switch from a Standard Workflow to a Step Functions **Express Workflow**, which supports synchronous execution with the response returned in the same HTTP call.

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js 20, ARM64) |
| Infrastructure | AWS CDK v2 |
| Compute | AWS Lambda (ARM64 / Graviton2) |
| Orchestration | AWS Step Functions (Standard Workflow) |
| Database | DynamoDB (single-table design) |
| Scheduler | EventBridge cron |
| API | API Gateway REST |
| Encryption | KMS customer-managed key |
| Observability | CloudWatch Logs, AWS X-Ray |
| CI/CD | GitHub Actions (9-gate security pipeline) |

---

## CDK Stacks

Four stacks deploy independently and share outputs via CDK cross-stack references:

| Stack | Resources | Description |
|---|---|---|
| `PjnDatabase-{env}` | DynamoDB table, KMS key | Single-table design — orders + instalments. Two GSIs. |
| `PjnCompute-{env}` | 3 Lambda functions, Step Functions, SQS DLQs | Core business logic. Step Functions co-located to resolve circular dependency. |
| `PjnOrchestration-{env}` | EventBridge rule | Daily debit batch scheduler. Disabled in non-prod. |
| `PjnApi-{env}` | API Gateway REST API | Public endpoint wired to order-service Lambda. |

---

## DynamoDB Single-Table Design

One table holds both orders and instalments, distinguished by key patterns:

| Entity | PK | SK |
|---|---|---|
| Order | `ORDER#<orderId>` | `ORDER#<orderId>` |
| Instalment | `ORDER#<orderId>` | `INSTALMENT#<seq>` |

A single query on the partition key returns the order and all its instalments in one DynamoDB call.

**GSI1** — Consumer order history  
`gsi1pk = CONSUMER#<consumerId>` → fetch all orders for a given consumer

**GSI2** — Daily debit batch  
`gsi2pk = DUE#<YYYY-MM-DD>` → fetch every instalment due on a specific date across all orders

---

## Key Design Decisions

**Why Step Functions instead of chained Lambda calls?**  
Step Functions logs every state transition automatically — that's a PCI DSS Req 10 audit trail with no extra code. Retries operate at the individual state level: if the fraud Lambda times out, Step Functions retries exactly that state, not the whole flow from the beginning.

**Why DynamoDB over RDS Postgres?**  
The two access patterns — fetch order + instalments by orderId, fetch all instalments due today — map directly to DynamoDB key conditions. Single-digit millisecond latency at any scale, no connection pool management. For complex cross-order reporting, pipe DynamoDB Streams into Redshift or Athena.

**Why ARM64 (Graviton2)?**  
~20% cheaper and faster per invocation vs x86 for equivalent workloads. Right-sized further via Lambda Power Tuning — see [FINOPS.md](FINOPS.md).

**Idempotency guard on debit-service**  
Before calling the payment provider, the debit-service updates instalment status from `SCHEDULED` → `PROCESSING` using a DynamoDB conditional write (`condition: status = SCHEDULED`). If EventBridge fires the Lambda twice (at-least-once delivery), the second execution hits a `ConditionalCheckFailedException` and skips — no double charges.

**POPIA data minimisation**  
Declined orders get a DynamoDB TTL set to 90 days from decline date. DynamoDB automatically purges them — Section 14 obligation met without a cron job.

---

## Security Controls

| Control | Implementation | Compliance mapping |
|---|---|---|
| Encryption at rest | KMS CMK, annual rotation | PCI DSS Req 3.5, 3.7 |
| Encryption in transit | API Gateway enforces HTTPS | PCI DSS Req 4.2 |
| Least-privilege IAM | CDK grant methods per function | PCI DSS Req 7 |
| Audit logging | CloudWatch Logs, X-Ray, SF execution logs | PCI DSS Req 10 |
| Point-in-time recovery | DynamoDB PITR enabled | PCI DSS Req 9 |
| Secret scanning | TruffleHog (Gate 1) | PCI DSS Req 3.4 |
| Dependency audit | npm audit (Gate 2) | PCI DSS Req 6.3 |
| SBOM generation | Syft SPDX (Gate 3) | PCI DSS Req 6.2 |
| SAST | ESLint + tsc type check (Gate 4) | PCI DSS Req 6.4 |
| IaC scanning | Checkov (Gate 5) | PCI DSS Req 2.2 |
| Policy-as-code | OPA (Gate 6) | PCI DSS Req 7 |
| Data minimisation | DynamoDB TTL on declined orders | POPIA Section 14 |

Full compliance evidence is generated by the CI pipeline on every run and stored in `compliance-evidence/`.

---

## FinOps Layer

See [FINOPS.md](FINOPS.md) for full detail. Summary:

- **Cost Allocation Tags** on all resources — Environment, Service, CostCentre, ManagedBy
- **Lambda Power Tuning** right-sized all three functions (fraud-service 256MB → 1024MB)
- **AWS Budget** alert at 80% of monthly limit
- **Cost Anomaly Detection** — daily ML-based alert on unexpected spend spikes
- **Infracost Gate 9** — cost delta posted on every PR before merge
- **Tag validation** in CI — pipeline fails if required tags are missing from IaC

---

## CI/CD Pipeline

9-gate GitHub Actions pipeline. All gates must pass before deploy.

| Gate | Tool | What it enforces |
|---|---|---|
| 1 · Secret Detection | TruffleHog | No credentials in source code |
| 2 · Dependency Audit | npm audit | No high/critical CVEs in dependencies |
| 3 · SBOM | Syft | Software bill of materials generated and stored |
| 4 · SAST | ESLint + tsc | No security anti-patterns, type safety |
| 5 · IaC Scan | Checkov + tag validation | No insecure infrastructure, required tags present |
| 6 · Policy Gate | OPA | PCI DSS encryption and logging rules enforced |
| 7 · CDK Diff | CDK | Infrastructure change summary posted on PR |
| 8 · Deploy | CDK | Deploy to AWS (main branch only) |
| 9 · Cost Delta | Infracost | Cost impact posted on PR before merge |

All GitHub Actions are SHA-pinned against supply chain attacks (post tj-actions/changed-files incident, March 2025).

---

## Project Structure

```
├── src/
│   ├── order-service/      # POST /orders, GET /orders/{id}, SF APPROVE/DECLINE
│   ├── debit-service/      # Payment processing + daily batch runner
│   ├── fraud-service/      # Rule-based fraud scoring 0–100
│   └── shared/
│       ├── dynamo.ts        # DynamoDB read/write helpers
│       ├── payday.ts        # Instalment due date calculation (30-day intervals)
│       ├── types.ts         # Shared TypeScript types
│       └── logger.ts        # Structured logger (AWS Lambda Powertools)
├── cdk/
│   ├── bin/app.ts           # CDK app entry point — stack wiring
│   └── lib/stacks/
│       ├── database-stack.ts
│       ├── compute-stack.ts
│       ├── orchestration-stack.ts
│       └── api-stack.ts
├── opa-policies/
│   └── pci_dss.rego         # OPA policy — encryption + logging rules
├── compliance-evidence/     # CI-generated artifacts (gitignored except manifests)
│   └── POPIA-data-manifest.md
├── .github/workflows/
│   └── pipeline.yml         # 9-gate CI/CD pipeline
└── FINOPS.md                # FinOps decisions, Power Tuning results, cost controls
```

---

## Deploying

### Prerequisites

- AWS CLI configured with SSO (`aws sso login --profile <profile>`)
- Node.js 20+
- CDK CLI (`npm install -g aws-cdk`)

### Install dependencies

```bash
npm install
```

### Deploy all stacks (dev environment)

```bash
cd cdk
CDK_DEFAULT_ACCOUNT=<account-id> CDK_DEFAULT_REGION=us-east-1 \
  cdk deploy --all --require-approval never --profile <profile>
```

### Deploy a specific environment

```bash
cdk deploy --all -c env=prod --profile <profile>
```

### Tear down

```bash
cdk destroy --all --profile <profile>
```

---

## Testing the API

After deploy, get the API URL from the `PjnApi-dev` stack outputs.

### Create an order

```bash
curl -X POST https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/orders \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "consumer-joe-001",
    "merchantId": "merchant-woolworths",
    "merchantName": "Woolworths",
    "totalAmount": 308820,
    "product": "PAY_IN_3"
  }'
```

Response: `202 Accepted` with `orderId` and instalment schedule.

### Poll for result

```bash
curl https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/orders/<orderId>
```

Status transitions: `PENDING_FRAUD_CHECK` → `ACTIVE` or `DECLINED`

---

## What Is Not in Scope

This project models the **transaction processing layer** — what happens after a consumer has an approved credit limit and places an order.

Out of scope (separate service boundary):
- Consumer onboarding — signup, identity verification (DHA), credit bureau affordability check, limit assignment
- Merchant onboarding and settlement
- Consumer-facing mobile/web application
