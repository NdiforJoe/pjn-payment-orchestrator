import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { CreateOrderRequest, CreateOrderResponse, OrderRecord, InstalmentRecord } from '../shared/types';
import { putOrder, putInstalment, updateOrderStatus } from '../shared/dynamo';
import { instalmentDueDates } from '../shared/payday';
import { logger } from '../shared/logger';

export async function handler(event: APIGatewayProxyEvent | Record<string, unknown>): Promise<APIGatewayProxyResult | CreateOrderResponse> {
  const start = Date.now();

  // Step Functions calls with action field; API Gateway calls via HTTP
  const isStepFn = 'action' in event;

  if (isStepFn) {
    return handleStepFnAction(event as { action: string; input: Record<string, unknown> });
  }

  const httpEvent = event as APIGatewayProxyEvent;
  if (!httpEvent.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Request body required' }) };
  }

  let request: CreateOrderRequest;
  try {
    request = JSON.parse(httpEvent.body) as CreateOrderRequest;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  try {
    const result = await createOrder(request);
    logger.info('Order created', { orderId: result.orderId, durationMs: Date.now() - start });
    return { statusCode: 201, body: JSON.stringify(result) };
  } catch (err) {
    logger.error('Order creation failed', err, { consumerId: request.consumerId });
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
}

async function handleStepFnAction(event: { action: string; input: Record<string, unknown> }): Promise<CreateOrderResponse> {
  const { action, input } = event;
  const orderId = (input as { request?: { orderId?: string }; orderId?: string }).orderId
    ?? (input as { request?: { orderId?: string } }).request?.orderId
    ?? '';

  if (action === 'APPROVE') {
    await updateOrderStatus(orderId, 'ACTIVE');
    return { orderId, status: 'ACTIVE' };
  }

  if (action === 'DECLINE') {
    await updateOrderStatus(orderId, 'DECLINED', { declineReason: 'FRAUD_RISK_TOO_HIGH' });
    return { orderId, status: 'DECLINED', declineReason: 'FRAUD_RISK_TOO_HIGH' };
  }

  throw new Error(`Unknown Step Functions action: ${action}`);
}

async function createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
  const orderId  = uuidv4();
  const now      = new Date().toISOString();
  const count    = req.product === 'PAY_IN_3' ? 3 : 12;
  const dueDates = instalmentDueDates(new Date(), count);
  const instalmentAmount = Math.floor(req.totalAmount / count);
  // last instalment absorbs rounding remainder
  const lastAmount = req.totalAmount - instalmentAmount * (count - 1);

  const order: OrderRecord = {
    pk: `ORDER#${orderId}`,
    sk: `ORDER#${orderId}`,
    gsi1pk: `CONSUMER#${req.consumerId}`,
    gsi1sk: now,
    entityType: 'ORDER',
    orderId,
    consumerId: req.consumerId,
    merchantId: req.merchantId,
    merchantName: req.merchantName,
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

  return { orderId, status: 'PENDING_FRAUD_CHECK', instalments };
}
