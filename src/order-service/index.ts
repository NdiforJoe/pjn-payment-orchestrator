import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderRecord,
  InstalmentRecord,
} from '../shared/types';
import { putOrder, putInstalment, updateOrderStatus, getOrder } from '../shared/dynamo';
import { instalmentDueDates } from '../shared/payday';
import { logger } from '../shared/logger';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

// ── Entry point ───────────────────────────────────────────────────────────────
// Three callers:
//   1. API Gateway  → POST /orders (create order + start SF execution)
//   2. API Gateway  → GET  /orders/{orderId} (fetch order status)
//   3. Step Functions → { action: 'APPROVE' | 'DECLINE', orderId, ... }

export async function handler(
  event: APIGatewayProxyEvent | StepFnAction,
): Promise<APIGatewayProxyResult | CreateOrderResponse> {
  if (isStepFnAction(event)) {
    return handleStepFnAction(event);
  }

  const httpEvent = event as APIGatewayProxyEvent;
  const method = httpEvent.httpMethod;

  if (method === 'GET') {
    return handleGetOrder(httpEvent);
  }

  if (method === 'POST') {
    return handleCreateOrder(httpEvent);
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
}

// ── Step Functions action handler ─────────────────────────────────────────────
interface StepFnAction {
  action: 'APPROVE' | 'DECLINE';
  input: {
    orderId: string;
    fraudScore?: number;
    declineReason?: string;
  };
}

function isStepFnAction(event: unknown): event is StepFnAction {
  return typeof event === 'object' && event !== null && 'action' in event;
}

async function handleStepFnAction(event: StepFnAction): Promise<CreateOrderResponse> {
  const { action, input } = event;
  const { orderId } = input;

  if (action === 'APPROVE') {
    await updateOrderStatus(orderId, 'ACTIVE', {
      fraudScore: input.fraudScore,
    });
    logger.info('Order approved', { orderId, fraudScore: input.fraudScore });
    return { orderId, status: 'ACTIVE' };
  }

  // DECLINE: set TTL 90 days for GDPR-style data minimisation (POPIA Section 14)
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  await updateOrderStatus(orderId, 'DECLINED', {
    fraudScore: input.fraudScore,
    declineReason: 'FRAUD_RISK_TOO_HIGH',
    ttl,
  });
  logger.info('Order declined', { orderId, fraudScore: input.fraudScore });
  return { orderId, status: 'DECLINED', declineReason: 'FRAUD_RISK_TOO_HIGH' };
}

// ── GET /orders/{orderId} ─────────────────────────────────────────────────────
async function handleGetOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const orderId = event.pathParameters?.orderId;
  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderId path parameter required' }) };
  }

  const order = await getOrder(orderId);
  if (!order) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };
  }

  return { statusCode: 200, body: JSON.stringify(order) };
}

// ── POST /orders ──────────────────────────────────────────────────────────────
async function handleCreateOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const start = Date.now();

  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
  }

  let request: CreateOrderRequest;
  try {
    request = JSON.parse(event.body) as CreateOrderRequest;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const validationError = validateRequest(request);
  if (validationError) {
    return { statusCode: 400, body: JSON.stringify({ error: validationError }) };
  }

  try {
    const result = await createOrder(request);
    logger.info('Order created and SF execution started', {
      orderId: result.orderId,
      product: request.product,
      durationMs: Date.now() - start,
    });
    // 202 Accepted — fraud check and approval happen async in Step Functions
    return { statusCode: 202, body: JSON.stringify(result) };
  } catch (err) {
    logger.error('Order creation failed', err, { consumerId: request.consumerId });
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
}

function validateRequest(req: CreateOrderRequest): string | null {
  if (!req.consumerId)   return 'consumerId is required';
  if (!req.merchantId)   return 'merchantId is required';
  if (!req.totalAmount || req.totalAmount <= 0) return 'totalAmount must be positive (cents)';
  if (!['PAY_IN_3', 'PAY_IN_12'].includes(req.product)) return 'product must be PAY_IN_3 or PAY_IN_12';
  return null;
}

async function createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
  const orderId = uuidv4();
  const now     = new Date().toISOString();
  const count   = req.product === 'PAY_IN_3' ? 3 : 12;
  const dueDates = instalmentDueDates(new Date(), count);

  const instalmentAmount = Math.floor(req.totalAmount / count);
  const lastAmount = req.totalAmount - instalmentAmount * (count - 1); // absorbs rounding

  const order: OrderRecord = {
    pk: `ORDER#${orderId}`,
    sk: `ORDER#${orderId}`,
    gsi1pk: `CONSUMER#${req.consumerId}`,
    gsi1sk: now,
    entityType: 'ORDER',
    orderId,
    consumerId: req.consumerId,
    merchantId: req.merchantId,
    merchantName: req.merchantName ?? req.merchantId,
    product: req.product,
    totalAmount: req.totalAmount,
    currency: 'ZAR',
    status: 'PENDING_FRAUD_CHECK',
    instalmentCount: count,
    createdAt: now,
    updatedAt: now,
  };

  await putOrder(order);

  const instalments = await Promise.all(
    dueDates.map(async (dueDate, i) => {
      const seq = i + 1;
      const amount = seq === count ? lastAmount : instalmentAmount;
      const instalmentId = uuidv4();

      const record: InstalmentRecord = {
        pk: `ORDER#${orderId}`,
        sk: `INSTALMENT#${seq}`,
        gsi2pk: `DUE#${dueDate}`,
        gsi2sk: `INSTALMENT#${instalmentId}`,
        entityType: 'INSTALMENT',
        instalmentId,
        orderId,
        consumerId: req.consumerId,
        sequenceNumber: seq,
        amount,
        currency: 'ZAR',
        dueDate,
        status: 'SCHEDULED',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      await putInstalment(record);
      return { sequenceNumber: seq, amount, dueDate };
    }),
  );

  // Start Step Functions approval flow — async, consumer gets 202 immediately
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: orderId,  // idempotent — SF rejects duplicate execution names
    input: JSON.stringify({
      orderId,
      consumerId: req.consumerId,
      merchantId: req.merchantId,
      amount: req.totalAmount,
    }),
  }));

  return { orderId, status: 'PENDING_FRAUD_CHECK', instalments };
}
