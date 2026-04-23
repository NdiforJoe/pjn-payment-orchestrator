# POPIA Data Manifest

## Personal Information Stored

| Field | Table | Record type | Retention | Legal basis |
|---|---|---|---|---|
| consumerId | pjn-payments-dev | ORDER, INSTALMENT | Order lifecycle | Contract performance |
| merchantId | pjn-payments-dev | ORDER | Order lifecycle | Contract performance |
| totalAmount | pjn-payments-dev | ORDER | Order lifecycle | Contract performance |

## Data Minimisation Controls
- Declined orders: TTL = 90 days (DynamoDB auto-delete)
- No name, email, phone, or ID number stored in this service
- PII limited to opaque consumer IDs — resolved by identity service (out of scope)

## Encryption
- At rest: KMS CMK (arn:aws:kms:us-east-1:373233583934:key/785a3c73...)
- In transit: TLS 1.2+ enforced by API Gateway and DynamoDB endpoints
