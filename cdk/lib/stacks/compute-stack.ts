import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { env_name, table, encryptionKey } = props;
    const isProd = env_name === 'prod';

    // Shared Lambda environment variables
    const commonEnv = {
      TABLE_NAME:    table.tableName,
      ENVIRONMENT:   env_name,
      LOG_LEVEL:     isProd ? 'INFO' : 'DEBUG',
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

    // ── Shared NodejsFunction bundling options ────────────────────────────────
    const bundling: lambdaNodejs.BundlingOptions = {
      minify: isProd,
      sourceMap: !isProd,
      target: 'node20',
      externalModules: [],  // bundle everything — no Lambda layers
    };

    const srcRoot = path.join(__dirname, '../../../src');

    // ── order-service ─────────────────────────────────────────────────────────
    this.orderServiceFn = new lambdaNodejs.NodejsFunction(this, 'OrderService', {
      functionName: `pjn-order-service-${env_name}`,
      entry: path.join(srcRoot, 'order-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,   // Graviton — ~20% cheaper
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,             // X-Ray
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
      timeout: cdk.Duration.seconds(30),          // payment processor can be slow
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...commonEnv, SERVICE_NAME: 'debit-service' },
      bundling,
      deadLetterQueue: debitDlq,
      retryAttempts: 0,                           // debit must NOT auto-retry — idempotency risk
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

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'OrderServiceArn', { value: this.orderServiceFn.functionArn });
    new cdk.CfnOutput(this, 'DebitServiceArn', { value: this.debitServiceFn.functionArn });
    new cdk.CfnOutput(this, 'FraudServiceArn', { value: this.fraudServiceFn.functionArn });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-compute');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
