import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface DatabaseStackProps extends cdk.StackProps {
  env_name: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Customer-managed KMS key — PCI DSS Req 3.5 (protect stored cardholder data)
    this.encryptionKey = new kms.Key(this, 'PjnTableKey', {
      alias: `pjn/${props.env_name}/dynamo`,
      description: 'PJN payment table encryption key — PCI DSS Req 3.5',
      enableKeyRotation: true,         // annual rotation — PCI DSS Req 3.7
      removalPolicy: props.env_name === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Single-table design
    // PK / SK patterns:
    //   ORDER#{orderId}    / ORDER#{orderId}          → order record
    //   ORDER#{orderId}    / INSTALMENT#{seq}          → instalment record
    // GSI1: consumer orders  →  gsi1pk = CONSUMER#{id},    gsi1sk = createdAt
    // GSI2: daily debit run  →  gsi2pk = DUE#{yyyy-mm-dd}, gsi2sk = INSTALMENT#{id}
    this.table = new dynamodb.Table(this, 'PjnPaymentsTable', {
      tableName: `pjn-payments-${props.env_name}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // PCI DSS Req 9
      timeToLiveAttribute: 'ttl',      // declined orders auto-expire after 90 days
      removalPolicy: props.env_name === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // GSI1 — query all orders for a consumer
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1-consumer-orders-index',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2 — daily debit run: fetch all SCHEDULED instalments due today
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2-due-date-index',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'TableName',   { value: this.table.tableName });
    new cdk.CfnOutput(this, 'TableArn',    { value: this.table.tableArn });
    new cdk.CfnOutput(this, 'KmsKeyAlias', { value: `alias/pjn/${props.env_name}/dynamo` });

    // ── Tags (FinOps cost allocation) ─────────────────────────────────────────
    cdk.Tags.of(this).add('Environment',  props.env_name);
    cdk.Tags.of(this).add('Service',      'payments-database');
    cdk.Tags.of(this).add('CostCentre',   'bnpl-core');
    cdk.Tags.of(this).add('DataClass',    'pci-in-scope');
    cdk.Tags.of(this).add('ManagedBy',    'cdk');
  }
}
