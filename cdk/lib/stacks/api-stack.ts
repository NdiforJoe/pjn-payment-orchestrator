import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  env_name: string;
  orderServiceFn: lambdaNodejs.NodejsFunction;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { env_name, orderServiceFn } = props;

    // Access log group — PCI DSS Req 10 (audit trail for all API calls)
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/pjn/${env_name}/api-access`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'PjnApi', {
      restApiName: `pjn-api-${env_name}`,
      description: 'PJN payment orchestration API',
      deployOptions: {
        stageName: env_name,
        tracingEnabled: true,             // X-Ray on API Gateway
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId:    '$context.requestId',
          ip:           '$context.identity.sourceIp',
          method:       '$context.httpMethod',
          path:         '$context.path',
          status:       '$context.status',
          latency:      '$context.responseLatency',
          userAgent:    '$context.identity.userAgent',
        })),
        throttlingBurstLimit: 50,
        throttlingRateLimit:  100,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      },
    });

    const orderIntegration = new apigateway.LambdaIntegration(orderServiceFn, {
      proxy: true,
      timeout: cdk.Duration.seconds(15),
    });

    // POST /orders — create a new BNPL order, triggers Step Functions approval flow
    const orders = this.api.root.addResource('orders');
    orders.addMethod('POST', orderIntegration, {
      operationName: 'CreateOrder',
      methodResponses: [
        { statusCode: '202' },  // Accepted — SF execution started async
        { statusCode: '400' },
        { statusCode: '500' },
      ],
    });

    // GET /orders/{orderId} — fetch order + instalment status
    const order = orders.addResource('{orderId}');
    order.addMethod('GET', orderIntegration, {
      operationName: 'GetOrder',
    });

    // GET /health — readiness probe
    const health = this.api.root.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode":200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'PJN API base URL',
    });
    new cdk.CfnOutput(this, 'OrdersEndpoint', {
      value: `${this.api.url}orders`,
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', env_name);
    cdk.Tags.of(this).add('Service',     'payments-api');
    cdk.Tags.of(this).add('CostCentre',  'bnpl-core');
    cdk.Tags.of(this).add('ManagedBy',   'cdk');
  }
}
