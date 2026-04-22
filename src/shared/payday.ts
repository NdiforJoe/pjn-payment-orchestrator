/**
 * South African salary cycle: payday is the 25th of each month.
 * If the 25th falls on a weekend, payment is due the preceding Friday.
 * Instalments are scheduled on the next 3 consecutive payday dates from order creation.
 */

function lastWorkingDayOnOrBefore25th(year: number, month: number): Date {
  const d = new Date(year, month - 1, 25);
  const dow = d.getDay(); // 0=Sun, 6=Sat
  if (dow === 0) d.setDate(23); // Sunday → Friday
  if (dow === 6) d.setDate(24); // Saturday → Friday
  return d;
}

export function nextPayday(from: Date): Date {
  const year = from.getFullYear();
  const month = from.getMonth() + 1; // 1-based

  const thisMonthPayday = lastWorkingDayOnOrBefore25th(year, month);
  // If we're still before this month's payday, use it; otherwise next month
  if (from < thisMonthPayday) return thisMonthPayday;

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return lastWorkingDayOnOrBefore25th(nextYear, nextMonth);
}

export function instalmentDueDates(orderCreatedAt: Date, count: 3 | 12): string[] {
  const dates: string[] = [];
  let cursor = orderCreatedAt;
  for (let i = 0; i < count; i++) {
    const payday = nextPayday(cursor);
    dates.push(payday.toISOString().split('T')[0]); // yyyy-mm-dd
    // advance cursor past this payday so next iteration finds the following month
    cursor = new Date(payday.getFullYear(), payday.getMonth(), 26);
  }
  return dates;
}

export function todayYYYYMMDD(): string {
  return new Date().toISOString().split('T')[0];
}
