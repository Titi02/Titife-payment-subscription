/**
 * Date helpers used by period and billing-day calculations.
 */

/**
 * Adds one billing interval to the given start date.
 * Used to calculate currentPeriodEnd for subscriptions and to extend a
 * pre-paid plan change's term at the period boundary (FR-15 / FR-31a).
 */
export function addBillingInterval(
  start: Date,
  interval: "MONTHLY" | "YEARLY"
): Date {
  const result = new Date(start);
  if (interval === "MONTHLY") {
    result.setMonth(result.getMonth() + 1);
  } else {
    result.setFullYear(result.getFullYear() + 1);
  }
  return result;
}

/**
 * Number of whole calendar days from `start` to `end`, ignoring time-of-day.
 * Both dates are normalized to UTC midnight of their local calendar date, so
 * daylight saving time is irrelevant and the result is an exact integer. Used
 * to report how many days of paid access remain on the current plan.
 */
export function getDaysBetween(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return (endUtc - startUtc) / (1000 * 60 * 60 * 24);
}
