/**
 * PayJustNow instalment schedule:
 *   - Instalment 1: deducted immediately at checkout (dueDate = purchase date)
 *   - Instalment 2: purchase date + 30 days
 *   - Instalment 3: purchase date + 60 days (PAY_IN_3)
 *   - Instalments 2–12: each 30 days apart (PAY_IN_12)
 *
 * The 30-day interval naturally lands near SA payday (25th) depending on purchase date.
 */

export function instalmentDueDates(orderCreatedAt: Date, count: 3 | 12): string[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(orderCreatedAt);
    date.setDate(date.getDate() + i * 30);
    return date.toISOString().split('T')[0]; // yyyy-mm-dd
  });
}

export function todayYYYYMMDD(): string {
  return new Date().toISOString().split('T')[0];
}
