import { DebitRequest, DebitResponse } from '../shared/types';
import { getInstalmentsByDueDate, ddb, TABLE_NAME } from '../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { todayYYYYMMDD } from '../shared/payday';
import { logger } from '../shared/logger';

// Debit service — two entry points:
//
// 1. EventBridge payday trigger  → { action: 'RUN_DEBIT_BATCH' }
//    Queries GSI2 for all SCHEDULED instalments due today, processes each.
//
// 2. Direct invocation (retry)   → DebitRequest (single instalment)

type DebitEvent =
  | { action: 'RUN_DEBIT_BATCH'; trigger?: string }
  | DebitRequest;

export async function handler(event: DebitEvent): Promise<DebitResponse[] | DebitResponse> {
  if ('action' in event && event.action === 'RUN_DEBIT_BATCH') {
    return runDailyBatch();
  }
  return processSingleDebit(event as DebitRequest);
}

// ── Daily batch ───────────────────────────────────────────────────────────────
async function runDailyBatch(): Promise<DebitResponse[]> {
  const today = todayYYYYMMDD();
  logger.info('Debit batch started', { dueDate: today });

  const instalments = await getInstalmentsByDueDate(today);
  logger.info('Instalments due today', { count: instalments.length, dueDate: today });

  if (instalments.length === 0) {
    logger.info('No instalments to process', { dueDate: today });
    return [];
  }

  // Sequential processing — payment processor rate limits apply in production.
  // In production this would be chunked with Promise.allSettled for parallelism.
  const results: DebitResponse[] = [];
  for (const inst of instalments) {
    const result = await processSingleDebit({
      instalmentId:    inst.instalmentId,
      orderId:         inst.orderId,
      consumerId:      inst.consumerId,
      sequenceNumber:  inst.sequenceNumber,
      amount:          inst.amount,
      dueDate:         inst.dueDate,
    });
    results.push(result);
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success).length;
  logger.info('Debit batch complete', { succeeded, failed, total: results.length, dueDate: today });

  return results;
}

// ── Single instalment ─────────────────────────────────────────────────────────
async function processSingleDebit(req: DebitRequest): Promise<DebitResponse> {
  const start = Date.now();
  const sk    = `INSTALMENT#${req.sequenceNumber}`;

  logger.info('Processing debit', {
    instalmentId: req.instalmentId,
    orderId: req.orderId,
    amount: req.amount,
    sequenceNumber: req.sequenceNumber,
  });

  // Idempotency guard: only transition from SCHEDULED → PROCESSING.
  // ConditionalCheckFailedException means it's already being processed or paid.
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `ORDER#${req.orderId}`, sk },
      UpdateExpression: 'SET #status = :processing, lastAttemptAt = :now, attemptCount = attemptCount + :one',
      ConditionExpression: '#status = :scheduled',
      ExpressionAttributeNames:  { '#status': 'status' },
      ExpressionAttributeValues: {
        ':processing': 'PROCESSING',
        ':scheduled':  'SCHEDULED',
        ':now':        new Date().toISOString(),
        ':one':        1,
      },
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      logger.warn('Instalment already processing or paid — skipping', {
        instalmentId: req.instalmentId,
        orderId: req.orderId,
      });
      return { instalmentId: req.instalmentId, success: false, failureReason: 'ALREADY_PROCESSED' };
    }
    throw err;
  }

  // Call payment processor
  const processorResult = await callPaymentProcessor(req);
  const finalStatus     = processorResult.success ? 'PAID' : 'FAILED';
  const now             = new Date().toISOString();

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `ORDER#${req.orderId}`, sk },
    UpdateExpression: processorResult.success
      ? 'SET #status = :status, updatedAt = :now, paidAt = :now'
      : 'SET #status = :status, updatedAt = :now, failureReason = :reason',
    ExpressionAttributeNames:  { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': finalStatus,
      ':now':    now,
      ...(processorResult.success ? {} : { ':reason': processorResult.failureReason }),
    },
  }));

  logger.info('Debit complete', {
    instalmentId:   req.instalmentId,
    success:        processorResult.success,
    transactionRef: processorResult.transactionRef,
    durationMs:     Date.now() - start,
  });

  return processorResult;
}

// ── Peach Payments mock ───────────────────────────────────────────────────────
// Replace with real Peach Payments SDK call in production.
// Peach Payments is the primary SA payment processor used by PayJustNow.
async function callPaymentProcessor(req: DebitRequest): Promise<DebitResponse> {
  const success = !req.consumerId.endsWith('-nsf'); // nsf = non-sufficient funds test marker
  return {
    instalmentId:   req.instalmentId,
    success,
    transactionRef: success ? `PEACH-${Date.now()}-${req.instalmentId.slice(0, 8)}` : undefined,
    failureReason:  success ? undefined : 'INSUFFICIENT_FUNDS',
  };
}
