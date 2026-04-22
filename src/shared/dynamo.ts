import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { OrderRecord, InstalmentRecord } from './types';

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

export async function getOrder(orderId: string): Promise<OrderRecord | undefined> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `ORDER#${orderId}`, sk: `ORDER#${orderId}` },
  }));
  return result.Item as OrderRecord | undefined;
}

export async function putOrder(order: OrderRecord): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: order,
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
}

export async function updateOrderStatus(
  orderId: string,
  status: OrderRecord['status'],
  extra?: Partial<OrderRecord>,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const extraKeys = Object.keys(extra ?? {});
  const extraExpr = extraKeys.map(k => `, #${k} = :${k}`).join('');
  const extraNames = Object.fromEntries(extraKeys.map(k => [`#${k}`, k]));
  const extraValues = Object.fromEntries(extraKeys.map(k => [`:${k}`, (extra as Record<string, unknown>)[k]]));

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `ORDER#${orderId}`, sk: `ORDER#${orderId}` },
    UpdateExpression: `SET #status = :status, #updatedAt = :updatedAt${extraExpr}`,
    ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', ...extraNames },
    ExpressionAttributeValues: { ':status': status, ':updatedAt': updatedAt, ...extraValues },
  }));
}

export async function putInstalment(instalment: InstalmentRecord): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: instalment,
  }));
}

export async function getInstalmentsByDueDate(dueDate: string): Promise<InstalmentRecord[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'gsi2-due-date-index',
    KeyConditionExpression: 'gsi2pk = :pk',
    ExpressionAttributeValues: { ':pk': `DUE#${dueDate}` },
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));
  return (result.Items ?? []) as InstalmentRecord[];
}
