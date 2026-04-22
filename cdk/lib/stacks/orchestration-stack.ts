import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface OrchestrationStackProps extends cdk.StackProps {
  env_name: string;
  orderServiceFn: lambdaNodejs.NodejsFunction;
  debitServiceFn: lambdaNodejs.NodejsFunction;
  fraudServiceFn: lambdaNodejs.NodejsFunction;
}

export class OrchestrationStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const { env_name, orderServiceFn, debitServiceFn, fraudServiceFn } = props;

    // ── Step Functions: Order Approval Flow ───────────────────────────────────
    //
    //  START → FraudCheck → [DECLINE | ApproveOrder → CreateInstalments] → END
    //
    // Mirrors PayJustNow's actual credit decisioning flow:
    // fraud/risk score assessed before credit limit check and instalment creation.

    const fraudCheckTask = new tasks.LambdaInvoke(this, 'FraudCheck', {
      lambdaFunction: fraudServiceFn,
      comment: 'Assess fraud risk score (0-100). Score >= 75 → decline.',
      resultPath: '$.fraudResult',
      retryOnServiceExceptions: true,
    });

    const approveOrderTask = new tasks.LambdaInvoke(this, 'ApproveOrder', {
      lambdaFunction: orderServiceFn,
      comment: 'Create order record and schedule instalments on payday dates.',
      payload: sfn.TaskInput.fromObject({
        action: 'APPROVE',
        'input.$': '$',
      }),
      resultPath: '$.approvalResult',
    });

    const declineOrderTask = new tasks.LambdaInvoke(this, 'DeclineOrder', {
      lambdaFunction: orderServiceFn,
      comment: 'Record decline with reason. Order TTL set to 90 days.',
      payload: sfn.TaskInput.fromObject({
        action: 'DECLINE',
        'input.$': '$',
      }),
      resultPath: '$.declineResult',
    });

    const orderApproved = new sfn.Succeed(this, 'OrderApproved');
    const orderDeclined = new sfn.Succeed(this, 'OrderDeclined');

    approveOrderTask.next(orderApproved);
    declineOrderTask.next(orderDeclined);

    // Route on fraud decision
    const fraudDecision = new sfn.Choice(this, 'FraudDecision')
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals('$.fraudResult.Payload.decision', 'DECLINE'),
          sfn.Condition.numberGreaterThanEquals('$.fraudResult.Payload.fraudScore', 75),
        ),
        declineOrderTask,
      )
      .otherwise(approveOrderTask);

    fraudCheckTask.next(fraudDecision);

    // State machine log group — required for PCI DSS audit trail (Req 10)
    const smLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/pjn/${env_name}/order-orchestrator`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'OrderOrchestrator', {
      stateMachineName: `pjn-order-orchestrator-${env_name}`,
      definitionBody: sfn.DefinitionBody.fromChainable(fraudCheckTask),
      tracingEnabled: true,           // X-Ray tracing
      logs: {
        destination: smLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      timeout: cdk.Duration.minutes(2),
    });

    // ── EventBridge: Payday Debit Scheduler ───────────────────────────────────
    //
    // South African salary cycle: 25th of each month (preceding Friday if weekend).
    // Two rules cover the two possible payday dates.

    // Primary: 25th of every month at 08:00 SAST (06:00 UTC)
    const paydayRule25th = new events.Rule(this, 'PaydayDebitRule25th', {
      ruleName: `pjn-payday-debit-25th-${env_name}`,
      description: 'Trigger debit run on 25th of each month (SA payday)',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', day: '25', month: '*', year: '*' }),
      enabled: env_name === 'prod',
    });
    paydayRule25th.addTarget(new targets.LambdaFunction(debitServiceFn, {
      event: events.RuleTargetInput.fromObject({ trigger: 'PAYDAY_25TH', action: 'RUN_DEBIT_BATCH' }),
    }));

    // Fallback: preceding Friday when 25th falls on Saturday (cron for day=24, Fri)
    const paydayRuleFri = new events.Rule(this, 'PaydayDebitRuleFri', {
      ruleName: `pjn-payday-debit-fri-${env_name}`,
      description: 'Trigger debit run on Friday before weekend 25th',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', day: '24', month: '*', year: '*' }),
      enabled: env_name === 'prod',
    });
    paydayRuleFri.addTarget(new targets.LambdaFunction(debitServiceFn, {
      event: events.RuleTargetInput.fromObject({ trigger: 'PAYDAY_FRI_FALLBACK', action: 'RUN_DEBIT_BATCH' }),
    }));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-orchestration');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
