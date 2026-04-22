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

    // ── EventBridge: Daily Instalment Debit ───────────────────────────────────
    //
    // PayJustNow instalments are scheduled 30 days apart from purchase date,
    // meaning due dates fall on any day of the month (not fixed to the 25th).
    // The debit batch runs daily at 08:00 SAST (06:00 UTC) and queries DynamoDB
    // GSI2 for all SCHEDULED instalments due today.

    const dailyDebitRule = new events.Rule(this, 'DailyDebitRule', {
      ruleName: `pjn-daily-debit-${env_name}`,
      description: 'Daily instalment debit run — queries GSI2 for all due today',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', month: '*', year: '*' }),
      enabled: env_name === 'prod',
    });
    dailyDebitRule.addTarget(new targets.LambdaFunction(debitServiceFn, {
      event: events.RuleTargetInput.fromObject({ action: 'RUN_DEBIT_BATCH', trigger: 'DAILY_SCHEDULED' }),
      retryAttempts: 2,
    }));

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-orchestration');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
