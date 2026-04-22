import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

interface OrchestrationStackProps extends cdk.StackProps {
  env_name: string;
  debitServiceFn: lambdaNodejs.NodejsFunction;
}

export class OrchestrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const { env_name, debitServiceFn } = props;

    // ── EventBridge: Payday Debit Scheduler ───────────────────────────────────
    //
    // South African salary cycle: payday is the 25th of each month.
    // If the 25th falls on a weekend, employees are paid the preceding Friday.
    // Two cron rules cover both cases — debit-service handles deduplication.

    // Primary: 25th of every month at 08:00 SAST (06:00 UTC)
    const rule25th = new events.Rule(this, 'PaydayDebitRule25th', {
      ruleName: `pjn-payday-debit-25th-${env_name}`,
      description: 'SA payday debit run — 25th of each month',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', day: '25', month: '*', year: '*' }),
      enabled: env_name === 'prod',
    });
    rule25th.addTarget(new targets.LambdaFunction(debitServiceFn, {
      event: events.RuleTargetInput.fromObject({ action: 'RUN_DEBIT_BATCH', trigger: 'PAYDAY_25TH' }),
      retryAttempts: 2,
    }));

    // Fallback: Friday before the weekend when 25th falls on Saturday (day=24, Fri)
    const ruleFri = new events.Rule(this, 'PaydayDebitRuleFri', {
      ruleName: `pjn-payday-debit-fri-${env_name}`,
      description: 'SA payday debit run — Friday before weekend 25th',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', day: '24', month: '*', year: '*' }),
      enabled: env_name === 'prod',
    });
    ruleFri.addTarget(new targets.LambdaFunction(debitServiceFn, {
      event: events.RuleTargetInput.fromObject({ action: 'RUN_DEBIT_BATCH', trigger: 'PAYDAY_FRI_FALLBACK' }),
      retryAttempts: 2,
    }));

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-orchestration');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
