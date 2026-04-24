# FinOps — InstaPay Payment Orchestrator

Cost visibility, efficiency decisions, and continuous cost governance for the InstaPay payment orchestration layer.

---

## Lambda Configuration Decisions

| Function | Memory | Arch | Rationale |
|---|---|---|---|
| order-service | 512 MB | ARM64 | Higher memory needed — writes order + 3 instalments + starts SF execution |
| debit-service | 256 MB | ARM64 | Stateless processor — DynamoDB read + payment provider call |
| fraud-service | 256 MB | ARM64 | CPU-bound rule evaluation — small memory sufficient |

All functions use **ARM64 (Graviton2)** — ~20% cheaper and faster per invocation vs x86 for the same workload.

## Lambda Right-Sizing — How It Works

Lambda right-sizing answers one question: **what memory setting gives the best cost/performance balance for this specific function?**

AWS Lambda bills on two dimensions: memory allocated and duration. These pull against each other:
- Lower memory = cheaper per ms, but slower execution (less CPU)
- Higher memory = more expensive per ms, but faster execution (more CPU)

The optimal setting is where `memory × duration` is minimised — not always the smallest memory.

### How right-sizing is done

**Pre-production — AWS Lambda Power Tuning**
Before a function has real traffic, use the open-source [Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) tool (deployed from AWS Serverless Application Repository). It runs the function at multiple memory sizes with a representative test payload, measures actual duration at each size, and calculates cost per invocation. The result is a recommendation and a visualisation graph.

This is what was done for all three functions in this project. Results are recorded below.

**Production — AWS Compute Optimizer**
Once a function has 14+ days of real production traffic, AWS Compute Optimizer analyses actual invocation patterns automatically and generates memory recommendations based on real workloads — no test payload needed. Enable once per account:

```bash
aws compute-optimizer update-enrollment-status \
  --status Active \
  --include-member-accounts \
  --region us-east-1
At scale this replaces manual Power Tuning runs — Compute Optimizer monitors every function continuously and surfaces recommendations as traffic patterns change.


Where right-sizing fits in FinOps
FinOps has three phases: Inform → Optimise → Operate.

Phase	What it means	This project
Inform	Make cost visible — who spends what	Cost Allocation Tags + Cost Explorer
Optimise	Reduce waste — right-size, eliminate idle spend	Lambda Power Tuning results below
Operate	Continuous governance — alert on anomalies, enforce budgets	AWS Budgets + Cost Anomaly Detection (Steps 4–5)
Right-sizing sits in the Optimise phase. It is only meaningful after the Inform phase is in place — you need visibility before you can optimise. That is why Cost Allocation Tags were activated first.
---

## Lambda Power Tuning Results

> Run with AWS Lambda Power Tuning from Serverless Application Repository.
> Date: TBC — fill in after Step 3.

### order-service

| 128 MB  | higher  | higher  | |
| 256 MB  | higher  | higher  | |
| 512 MB  | 13.71 ms | $0.000000102 | ← optimal (balanced) = current |
| 1024 MB | faster  | higher cost | Diminishing returns |

**Optimal memory:** 512 MB (current setting confirmed correct)
**Cost saving vs current:** No change required — already at optimal

### debit-service

| 128 MB  | higher  | higher  | |
| 256 MB  | slower  | higher  | Previous setting |
| 512 MB  | 18.47 ms | $0.000000129 | ← optimal (balanced) |
| 1024 MB | faster  | higher cost | |

**Optimal memory:** 512 MB (increased from 256 MB)
**Cost saving vs current:** Better duration/cost balance at 512 MB — current 256 MB setting is under-provisioned for the DynamoDB query workload

### fraud-service

| 128 MB  | higher  | higher  | Slowest — CPU bottleneck |
| 256 MB  | moderate | moderate | Previous setting |
| 512 MB  | faster  | lower   | |
| 1024 MB | 2.16 ms | $0.0000000408 | ← optimal (balanced) |

**Optimal memory:** 1024 MB (increased from 256 MB)
**Cost saving vs current:**  Lower cost per invocation despite 4x memory — duration dropped enough to offset the higher memory price

---

## DynamoDB Billing Model

**Mode:** PAY_PER_REQUEST (on-demand)

**Rationale:** Transaction volume is unpredictable at launch. PAY_PER_REQUEST means zero cost during dev/test with no idle capacity charge. Switch to PROVISIONED + Auto Scaling once production traffic establishes a stable baseline (typically after 30 days of production data).

---

## Cost Allocation Tags

All resources tagged at CDK stack level:

| Tag | Value | Purpose |
|---|---|---|
| `Environment` | dev / prod | Separate dev vs prod spend |
| `Service` | payments-compute / payments-orchestration / payments-api / payments-data | Per-service breakdown |
| `CostCentre` | bnpl-core | Chargeback to BNPL business unit |
| `ManagedBy` | cdk | Filter CDK-managed vs console resources |

These tags are activated as **Cost Allocation Tags** in AWS Billing → Cost Allocation Tags.
Once activated, they appear as filters and group-by dimensions in AWS Cost Explorer.

---

## AWS Budget Alert

Budget: **$50/month** on the `bnpl-core` cost centre tag.  
Alert threshold: 80% actual spend ($40) → email to `jndiforad@gmail.com`.

Created via CLI (see Step 5 of Day 4 plan).

---

## Cost Anomaly Detection

Anomaly monitor on the `bnpl-core` cost centre.  
Alert threshold: anomaly impact > $10 → SNS → email.

Created via CLI (see Step 6 of Day 4 plan).

---

## Infracost CI Integration

Every PR shows a cost delta in the GitHub Actions pipeline.

| Change type | Expected signal |
|---|---|
| Add a Lambda | Small increase (ARM64 + pay-per-use) |
| Add DynamoDB GSI | Minimal — GSI is billed on R/W capacity used |
| Add CloudWatch Log Group with longer retention | Measurable increase in storage cost |
| Increase Lambda memory | May decrease cost if duration drops proportionally |

---

## Cost Optimisation Backlog

- [ ] Fill in real Power Tuning numbers and adjust Lambda memory if optimal differs from current
- [ ] Switch DynamoDB to PROVISIONED mode once 30-day production baseline is established
- [ ] Evaluate Step Functions Express Workflow for in-store QR terminal flow (synchronous execution, lower cost per execution)
- [ ] Review CloudWatch log retention — 3 months may be reducible for non-prod
