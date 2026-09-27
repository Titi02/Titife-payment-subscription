/**
 * Money formatting helpers — kobo <-> display conversion.
 * AGENTS.md Section 2: all amounts are stored as integers in kobo.
 * This is the ONLY module that touches money math.
 */

/**
 * Formats a kobo amount as a human-readable Naira string.
 * e.g. 1200000 -> "₦12,000.00"
 */
export function formatKoboToNaira(kobo: number): string {
  const naira = kobo / 100;
  return `₦${naira.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Converts a Naira amount to kobo.
 * Only used for defining constants — runtime money is always kobo.
 */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

/** Monthly plan price in kobo: ₦12,000 = 1,200,000 kobo */
export const MONTHLY_PRICE_KOBO = 1_200_000;

/** Yearly plan price in kobo: ₦120,000 = 12,000,000 kobo */
export const YEARLY_PRICE_KOBO = 12_000_000;

/** Currency code — always NGN */
export const CURRENCY = "ngn" as const;
