export type Environment = 'dev' | 'staging' | 'prod';
export type Product = 'PAY_IN_3' | 'PAY_IN_12';

export type OrderStatus =
  | 'PENDING_FRAUD_CHECK'
  | 'APPROVED'
  | 'DECLINED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'DEFAULTED'
  | 'REFUNDED';

export type InstalmentStatus =
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'OVERDUE'
  | 'WAIVED';

export type DeclineReason =
  | 'FRAUD_RISK_TOO_HIGH'
  | 'INSUFFICIENT_CREDIT_LIMIT'
  | 'CONSUMER_BLACKLISTED'
  | 'MERCHANT_INACTIVE'
  | 'AFFORDABILITY_FAILED';

// DynamoDB single-table key shapes
// PK: ORDER#{orderId}      SK: ORDER#{orderId}          → order record
// PK: ORDER#{orderId}      SK: INSTALMENT#{seq}         → instalment record
// GSI1PK: CONSUMER#{id}    GSI1SK: {createdAt}          → orders by consumer
// GSI2PK: DUE#{yyyy-mm-dd} GSI2SK: INSTALMENT#{id}      → instalments due today

export interface OrderRecord {
  pk: string;               // ORDER#{orderId}
  sk: string;               // ORDER#{orderId}
  gsi1pk: string;           // CONSUMER#{consumerId}
  gsi1sk: string;           // ISO timestamp
  entityType: 'ORDER';
  orderId: string;
  consumerId: string;
  merchantId: string;
  merchantName: string;
  product: Product;
  totalAmount: number;      // in cents (ZAR)
  currency: 'ZAR';
  status: OrderStatus;
  declineReason?: DeclineReason;
  fraudScore?: number;      // 0-100
  instalmentCount: number;
  createdAt: string;        // ISO 8601
  updatedAt: string;
  ttl?: number;             // epoch seconds — for declined orders (90-day retention)
}

export interface InstalmentRecord {
  pk: string;               // ORDER#{orderId}
  sk: string;               // INSTALMENT#{sequenceNumber}
  gsi2pk: string;           // DUE#{yyyy-mm-dd}
  gsi2sk: string;           // INSTALMENT#{instalmentId}
  entityType: 'INSTALMENT';
  instalmentId: string;
  orderId: string;
  consumerId: string;
  sequenceNumber: number;   // 1, 2, 3
  amount: number;           // in cents
  currency: 'ZAR';
  dueDate: string;          // yyyy-mm-dd — payday-aware
  status: InstalmentStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  paidAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

// Lambda event/response shapes

export interface CreateOrderRequest {
  consumerId: string;
  merchantId: string;
  merchantName: string;
  product: Product;
  totalAmount: number;      // cents
  currency: 'ZAR';
  merchantCallbackUrl: string;
}

export interface CreateOrderResponse {
  orderId: string;
  status: OrderStatus;
  declineReason?: DeclineReason;
  instalments?: InstalmentSummary[];
  redirectUrl?: string;
}

export interface InstalmentSummary {
  sequenceNumber: number;
  amount: number;
  dueDate: string;
}

export interface FraudCheckRequest {
  orderId: string;
  consumerId: string;
  amount: number;
  merchantId: string;
}

export interface FraudCheckResponse {
  orderId: string;
  fraudScore: number;       // 0-100; >= 75 = decline
  decision: 'APPROVE' | 'DECLINE' | 'REVIEW';
  reasons: string[];
}

export interface DebitRequest {
  instalmentId: string;
  orderId: string;
  consumerId: string;
  sequenceNumber: number;   // needed to build DynamoDB SK: INSTALMENT#{sequenceNumber}
  amount: number;
  dueDate: string;
}

export interface DebitResponse {
  instalmentId: string;
  success: boolean;
  transactionRef?: string;
  failureReason?: string;
}

// Step Functions state machine input/output

export interface OrderOrchestratorInput {
  request: CreateOrderRequest;
}

export interface OrderOrchestratorOutput {
  orderId: string;
  status: OrderStatus;
  instalments?: InstalmentSummary[];
}

// Structured log shape (JSON logs for CloudWatch Insights)
export interface StructuredLog {
  level: 'INFO' | 'WARN' | 'ERROR';
  service: string;
  traceId?: string;
  orderId?: string;
  consumerId?: string;
  message: string;
  durationMs?: number;
  [key: string]: unknown;
}
