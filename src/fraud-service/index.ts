import { FraudCheckRequest, FraudCheckResponse } from '../shared/types';
import { logger } from '../shared/logger';

// Fraud scoring rules — deterministic rule engine that mirrors the
// shape of a real BNPL risk decisioning service. In production this
// would call a credit bureau (e.g. TransUnion SA) and an ML model.
// Score >= 75 → DECLINE. 50-74 → REVIEW. < 50 → APPROVE.

const DECLINE_THRESHOLD = 75;
const REVIEW_THRESHOLD  = 50;
const HIGH_AMOUNT_CENTS = 500_000; // R5,000

export async function handler(event: FraudCheckRequest): Promise<FraudCheckResponse> {
  const start = Date.now();
  logger.info('Fraud check started', { orderId: event.orderId, consumerId: event.consumerId });

  const { score, reasons } = scoreOrder(event);
  const decision = score >= DECLINE_THRESHOLD
    ? 'DECLINE'
    : score >= REVIEW_THRESHOLD
    ? 'REVIEW'
    : 'APPROVE';

  logger.info('Fraud check complete', {
    orderId: event.orderId,
    fraudScore: score,
    decision,
    durationMs: Date.now() - start,
  });

  return { orderId: event.orderId, fraudScore: score, decision, reasons };
}

function scoreOrder(req: FraudCheckRequest): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Rule 1: high transaction amount
  if (req.amount > HIGH_AMOUNT_CENTS) {
    score += 30;
    reasons.push('AMOUNT_EXCEEDS_HIGH_RISK_THRESHOLD');
  }

  // Rule 2: unverified merchant
  const knownMerchants = ['merchant-tfg', 'merchant-takealot', 'merchant-shoprite'];
  if (!knownMerchants.includes(req.merchantId)) {
    score += 20;
    reasons.push('UNVERIFIED_MERCHANT');
  }

  // Rule 3: high-velocity consumer (stub — production queries DynamoDB
  // for orders placed by this consumer in the last 24 hours)
  if (req.consumerId.endsWith('-flagged')) {
    score += 40;
    reasons.push('CONSUMER_HIGH_VELOCITY');
  }

  return { score: Math.min(score, 100), reasons };
}
