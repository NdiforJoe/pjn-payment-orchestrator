#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { OrchestrationStack } from '../lib/stacks/orchestration-stack';
import { ApiStack } from '../lib/stacks/api-stack';

const app = new cdk.App();

const env_name = app.node.tryGetContext('env') ?? 'dev';

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'af-south-1', // Cape Town — data residency
};

// ── Stacks ────────────────────────────────────────────────────────────────────

const dbStack = new DatabaseStack(app, `PjnDatabase-${env_name}`, {
  env,
  env_name,
  description: 'PJN payment orchestrator — DynamoDB single-table + KMS (PCI DSS Req 3.5)',
});

const computeStack = new ComputeStack(app, `PjnCompute-${env_name}`, {
  env,
  env_name,
  table:         dbStack.table,
  encryptionKey: dbStack.encryptionKey,
  description:   'PJN payment orchestrator — Lambda compute (order, debit, fraud services)',
});
computeStack.addDependency(dbStack);

const orchestrationStack = new OrchestrationStack(app, `PjnOrchestration-${env_name}`, {
  env,
  env_name,
  debitServiceFn: computeStack.debitServiceFn,
  description:    'PJN payment orchestrator — EventBridge payday debit scheduler',
});
orchestrationStack.addDependency(computeStack);

const apiStack = new ApiStack(app, `PjnApi-${env_name}`, {
  env,
  env_name,
  orderServiceFn: computeStack.orderServiceFn,
  description: 'PJN payment orchestrator — API Gateway (REST) → order-service Lambda',
});
apiStack.addDependency(orchestrationStack); // ensure SF ARN is wired before API goes live

// ── Stack-level tags (FinOps cost allocation) ─────────────────────────────────
cdk.Tags.of(app).add('Project',     'pjn-payment-orchestrator');
cdk.Tags.of(app).add('Environment', env_name);
cdk.Tags.of(app).add('CostCentre',  'bnpl-core');
cdk.Tags.of(app).add('ManagedBy',   'cdk');
cdk.Tags.of(app).add('Team',        'payments-platform');
