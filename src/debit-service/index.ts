import { DebitRequest, DebitResponse, InstalmentRecord } from '../shared/types';
import { getInstalmentsByDueDate, putInstalment, ddb, TABLE_NAME } from '../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { todayYYYYMMDD } from '../shared/payday';
import { logger } from '../shared/logger';

// Debit service — two entry points:
//
// 1. EventBridge payday trigger: { action: 'RUN_DEBIT_BATCH' }
//    Queries GSI2 for all SCHEDULED instalments due today, processes each.
//
// 2. Direct invocation: DebitRequest (single instalment retry)

type DebitEvent =
  | { action: 'RUN_DEBIT_BATCH'; trigger?: string }
  | DebitRequest;

export async function handler(event: DebitEvent): Promise<DebitResponse[] | DebitResponse> {
  if ('action' in event && event.action === 'RUN_DEBIT_BATCH') {
    return runDailyBatch();
  }
  return processSingleDebit(event as DebitRequest);
}

async function runDailyBatch(): Promise<DebitResponse[]> {
  const today = todayYYYYMMDD();
  logger.info('Debit batch started', { dueDate: today });

  const instalments = await getInstalmentsByDueDate(today);
  logger.info('Instalments due today', { count: instalments.length, dueDate: today });

  // Process sequentially — payment processor rate limits apply
  const results: DebitResponse[] = [];
  for (const instalment of instalments) {
    const result = await processSingleDebit({
      instalmentId: instalment.instalmentId,
      orderId:      instalment.orderId,
      consumerId:   instalment.consumerId,
      amount:       instalment.amount,
      dueDate:      instalment.dueDate,
    });
    results.push(result);
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success).length;
  logger.info('Debit batch complete', { succeeded, failed, total: results.length });

  return results;
}

async function processSingleDebit(req: DebitRequest): Promise<DebitResponse> {
  const start = Date.now();
  logger.info('Processing debit', { instalmentId: req.instalmentId, amount: req.amount });

  // Mark instalment as PROCESSING before calling payment processor
  // Prevents duplicate processing if Lambda retries (idempotency guard)
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `ORDER#${req.orderId}`, sk: `INSTALMENT#${getSeqFromId(req.instalmentId)}` },
      UpdateExpression: 'SET #status = :processing, lastAttemptAt = :now',
      ConditionExpression: '#status = :scheduled',  // only transition from SCHEDULED
      ExpressionAttributeNames:  { '#status': 'status' },
      ExpressionAttributeValues: {
        ':processing': 'PROCESSING',
        ':scheduled':  'SCHEDULED',
        ':now':        new Date().toISOString(),
      },
    }));
  } catch (err: unknown) {
    // ConditionalCheckFailedException = already processing or paid — skip
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      logger.warn('Instalment already processing or paid — skipping', { instalmentId: req.instalmentId });
      return { instalmentId: req.instalmentId, success: false, failureReason: 'ALREADY_PROCESSED' };
    }
    throw err;
  }

  // Call payment processor (Peach Payments mock)
  const processorResult = await callPaymentProcessor(req);

  // Update final status
  const finalStatus = processorResult.success ? 'PAID' : 'FAILED';
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `ORDER#${req.orderId}`, sk: `INSTALMENT#${getSeqFromId(req.instalmentId)}` },
    UpdateExpression: 'SET #status = :status, updatedAt = :now' +
      (processorResult.success ? ', paidAt = :now' : ', failureReason = :reason'),
    ExpressionAttributeNames:  { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': finalStatus,
      ':now':    new Date().toISOString(),
      ...(processorResult.success ? {} : { ':reason': processorResult.failureReason }),
    },
  }));

  logger.info('Debit complete', {
    instalmentId: req.instalmentId,
    success: processorResult.success,
    durationMs: Date.now() - start,
  });

  return processorResult;
}

// Peach Payments mock — replace with real SDK call in production
async function callPaymentProcessor(req: DebitRequest): Promise<DebitResponse> {
  // Simulate ~95% success rate for demo
  const success = !req.consumerId.endsWith('-insufficient-funds');
  return {
    instalmentId: req.instalmentId,
    success,
    transactionRef: success ? `PEACH-${Date.now()}` : undefined,
    failureReason:  success ? undefined : 'INSUFFICIENT_FUNDS',
  };
}

// Derive sequence number from instalmentId stored in GSI2 sort key
// GSI2SK format: INSTALMENT#{instalmentId} — seq is on the SK, not the ID
// For direct invocations we query by orderId + instalmentId match
function getSeqFromId(_instalmentId: string): string {
  // In batch mode the sequence is on the SK (INSTALMENT#1, #2, #3)
  // For single debit calls we query by orderId to find the correct SK
  // Simplified for demo — production would carry seq in the DebitRequest
  return '1';
}
