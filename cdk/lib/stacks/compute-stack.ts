import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import * as path from 'path';

interface ComputeStackProps extends cdk.StackProps {
  env_name: string;
  table: dynamodb.Table;
  encryptionKey: kms.Key;
}

export class ComputeStack extends cdk.Stack {
  public readonly orderServiceFn: lambdaNodejs.NodejsFunction;
  public readonly debitServiceFn: lambdaNodejs.NodejsFunction;
  public readonly fraudServiceFn: lambdaNodejs.NodejsFunction;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { env_name, table, encryptionKey } = props;
    const isProd = env_name === 'prod';

    const commonEnv = {
      TABLE_NAME:              table.tableName,
      ENVIRONMENT:             env_name,
      LOG_LEVEL:               isProd ? 'INFO' : 'DEBUG',
      POWERTOOLS_SERVICE_NAME: 'pjn-payment-orchestrator',
    };

    // ── Dead Letter Queues ────────────────────────────────────────────────────
    const orderDlq = new sqs.Queue(this, 'OrderServiceDlq', {
      queueName: `pjn-order-service-dlq-${env_name}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
    });
    const debitDlq = new sqs.Queue(this, 'DebitServiceDlq', {
      queueName: `pjn-debit-service-dlq-${env_name}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
    });
    const fraudDlq = new sqs.Queue(this, 'FraudServiceDlq', {
      queueName: `pjn-fraud-service-dlq-${env_name}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
    });

    // ── Bundling (AWS SDK v3 ships with Node.js 20 runtime — keep external) ──
    const bundling: lambdaNodejs.BundlingOptions = {
      minify: isProd,
      sourceMap: !isProd,
      target: 'node20',
      externalModules: ['@aws-sdk/*'],
    };

    const srcRoot = path.join(__dirname, '../../../src');

    // ── order-service ─────────────────────────────────────────────────────────
    this.orderServiceFn = new lambdaNodejs.NodejsFunction(this, 'OrderService', {
      functionName: `pjn-order-service-${env_name}`,
      entry: path.join(srcRoot, 'order-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...commonEnv, SERVICE_NAME: 'order-service' },
      bundling,
      deadLetterQueue: orderDlq,
      retryAttempts: 2,
      logGroup: new logs.LogGroup(this, 'OrderServiceLogs', {
        logGroupName: `/pjn/${env_name}/order-service`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ── debit-service ─────────────────────────────────────────────────────────
    this.debitServiceFn = new lambdaNodejs.NodejsFunction(this, 'DebitService', {
      functionName: `pjn-debit-service-${env_name}`,
      entry: path.join(srcRoot, 'debit-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...commonEnv, SERVICE_NAME: 'debit-service' },
      bundling,
      deadLetterQueue: debitDlq,
      retryAttempts: 0,   // payment debit must NOT auto-retry — idempotency risk
      logGroup: new logs.LogGroup(this, 'DebitServiceLogs', {
        logGroupName: `/pjn/${env_name}/debit-service`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ── fraud-service ─────────────────────────────────────────────────────────
    this.fraudServiceFn = new lambdaNodejs.NodejsFunction(this, 'FraudService', {
      functionName: `pjn-fraud-service-${env_name}`,
      entry: path.join(srcRoot, 'fraud-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...commonEnv, SERVICE_NAME: 'fraud-service' },
      bundling,
      deadLetterQueue: fraudDlq,
      retryAttempts: 2,
      logGroup: new logs.LogGroup(this, 'FraudServiceLogs', {
        logGroupName: `/pjn/${env_name}/fraud-service`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ── IAM grants (least privilege) ──────────────────────────────────────────
    table.grantReadWriteData(this.orderServiceFn);
    table.grantReadWriteData(this.debitServiceFn);
    table.grantReadData(this.fraudServiceFn);
    encryptionKey.grantDecrypt(this.orderServiceFn);
    encryptionKey.grantDecrypt(this.debitServiceFn);
    encryptionKey.grantDecrypt(this.fraudServiceFn);

    // ── Step Functions: Order Approval Flow ───────────────────────────────────
    // Lives here (not OrchestrationStack) so we can wire STATE_MACHINE_ARN back
    // to order-service without a cross-stack circular dependency.
    //
    // Flow: FraudCheck → [score >= 75 → DeclineOrder | otherwise → ApproveOrder]

    const fraudCheckTask = new tasks.LambdaInvoke(this, 'FraudCheck', {
      lambdaFunction: this.fraudServiceFn,
      comment: 'Score fraud risk 0-100. score >= 75 → DECLINE.',
      resultPath: '$.fraudResult',
      retryOnServiceExceptions: true,
    });

    const approveOrderTask = new tasks.LambdaInvoke(this, 'ApproveOrder', {
      lambdaFunction: this.orderServiceFn,
      comment: 'Mark order ACTIVE.',
      payload: sfn.TaskInput.fromObject({
        action: 'APPROVE',
        input: {
          'orderId.$':    '$.orderId',
          'fraudScore.$': '$.fraudResult.Payload.fraudScore',
        },
      }),
      resultPath: '$.approvalResult',
    });

    // Debit instalment 1 immediately after approval — PayJustNow charges the
    // first instalment at point of purchase, not on a future scheduled date.
    const debitFirstInstalmentTask = new tasks.LambdaInvoke(this, 'DebitFirstInstalment', {
      lambdaFunction: this.debitServiceFn,
      comment: 'Immediately debit instalment #1 at checkout. Instalments 2–3 are scheduled by daily EventBridge.',
      payload: sfn.TaskInput.fromObject({
        'instalmentId.$':   '$.firstInstalment.instalmentId',
        'orderId.$':        '$.orderId',
        'consumerId.$':     '$.consumerId',
        'sequenceNumber.$': '$.firstInstalment.sequenceNumber',
        'amount.$':         '$.firstInstalment.amount',
        'dueDate.$':        '$.firstInstalment.dueDate',
      }),
      resultPath: '$.debitResult',
    });

    const declineOrderTask = new tasks.LambdaInvoke(this, 'DeclineOrder', {
      lambdaFunction: this.orderServiceFn,
      comment: 'Mark order DECLINED; set 90-day TTL for POPIA data minimisation.',
      payload: sfn.TaskInput.fromObject({
        action: 'DECLINE',
        input: {
          'orderId.$':    '$.orderId',
          'fraudScore.$': '$.fraudResult.Payload.fraudScore',
        },
      }),
      resultPath: '$.declineResult',
    });

    const orderApproved = new sfn.Succeed(this, 'OrderApproved');
    const orderDeclined = new sfn.Succeed(this, 'OrderDeclined');

    approveOrderTask.next(debitFirstInstalmentTask).next(orderApproved);
    declineOrderTask.next(orderDeclined);

    const fraudDecision = new sfn.Choice(this, 'FraudDecision')
      .when(
        sfn.Condition.numberGreaterThanEquals('$.fraudResult.Payload.fraudScore', 75),
        declineOrderTask,
      )
      .otherwise(approveOrderTask);

    fraudCheckTask.next(fraudDecision);

    // SF execution logs — PCI DSS Req 10 (all activity must be auditable)
    const smLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/pjn/${env_name}/order-orchestrator`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'OrderOrchestrator', {
      stateMachineName: `pjn-order-orchestrator-${env_name}`,
      definitionBody: sfn.DefinitionBody.fromChainable(fraudCheckTask),
      tracingEnabled: true,
      logs: {
        destination: smLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      timeout: cdk.Duration.minutes(2),
    });

    // Break the circular dependency: state machine references orderServiceFn (for APPROVE/DECLINE
    // tasks), so we cannot also let the Lambda's IAM policy reference the state machine resource.
    // Instead, construct the ARN from pseudo-parameters (AWS::Region / AWS::AccountId) — these
    // resolve at deploy time without creating a CloudFormation resource dependency.
    const smArn = cdk.Stack.of(this).formatArn({
      service:      'states',
      resource:     'stateMachine',
      resourceName: `pjn-order-orchestrator-${env_name}`,
      arnFormat:    cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    this.orderServiceFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['states:StartExecution'],
      resources: [smArn],
    }));
    this.orderServiceFn.addEnvironment('STATE_MACHINE_ARN', smArn);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'OrderServiceArn',  { value: this.orderServiceFn.functionArn });
    new cdk.CfnOutput(this, 'DebitServiceArn',  { value: this.debitServiceFn.functionArn });
    new cdk.CfnOutput(this, 'FraudServiceArn',  { value: this.fraudServiceFn.functionArn });
    new cdk.CfnOutput(this, 'StateMachineArn',  { value: this.stateMachine.stateMachineArn });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-compute');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
