// Standing orders: the payments that fell due are booked on the member's record.
import { parseUtcDate, safeList } from './util';
import type { Payment, Person, StandingOrder } from './types';

/**
 * Books all standing-order payments that fell due up to today (weekend dates move to Monday) and drops expired
 * orders. Returns the updated person or null when nothing changed.
 */
export function checkAndExecuteStandingOrders<P extends Pick<Person, 'payments' | 'standingOrders'>>(person: P): P | null {
  if (!Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;
  const payments = [...safeList<Payment>(person.payments)];
  const existingIds = new Set(payments.map(p => p.id));
  const now = new Date();
  const limit = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const isoDay = (d: Date) => d.toISOString().split('T')[0];
  const nextMonth = (date: Date, day: number) => {
    const next = new Date(date);
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
    return next;
  };
  let modified = false;
  const remaining: StandingOrder[] = [];
  for (const so of person.standingOrders) {
    const order = { ...so };
    const day = parseUtcDate(order.startDate).getUTCDate();
    let lastAuto: Date | null = order.lastAutoPayment ? parseUtcDate(order.lastAutoPayment) : null;
    const endDate = order.endDate ? parseUtcDate(order.endDate) : null;
    endDate?.setUTCHours(23, 59, 59, 999);
    let due = lastAuto ? nextMonth(lastAuto, day) : parseUtcDate(order.startDate);
    let booked = false;
    for (let safety = 0; safety < 1200 && !(endDate && due > endDate); safety++) {
      const execution = new Date(due);
      const weekday = execution.getUTCDay();
      if (weekday === 6 || weekday === 0) execution.setUTCDate(execution.getUTCDate() + (weekday === 6 ? 2 : 1));
      if (execution > limit) break;
      const id = `auto_${order.id}_${isoDay(due)}`;
      if (!existingIds.has(id)) {
        payments.push({ id, amount: parseFloat(String(order.amount)), date: isoDay(execution), description: (order.note || 'Dauerauftrag') + ' (Auto)', isAuto: true });
        existingIds.add(id);
        booked = true;
      }
      lastAuto = new Date(due);
      due = nextMonth(due, day);
    }
    if (booked && lastAuto) order.lastAutoPayment = isoDay(lastAuto);
    if (endDate && endDate < limit) {
      modified = true;
    } else {
      remaining.push(order);
      modified ||= booked;
    }
  }
  return modified ? { ...person, payments, standingOrders: remaining } : null;
}
