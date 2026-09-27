/**
 * Proration — PRD Section 5.11 / FR-18.
 *
 * The single implementation of the unused-time credit formula, reused by every
 * caller that needs the amount. The upgrade preview (GET) and the upgrade
 * charge (POST) both run through getUpgradeQuote -> calculateProration, so the
 * number shown to the user and the number charged come from the same code
 * path. Money is always a whole-number integer in kobo (AGENTS.md Section 2):
 * the daily-rate division is rounded to the kobo with integer arithmetic only,
 * never a float intermediate.
 *
 *   credit = round(daysRemaining * oldPlanPrice / totalDays)  (round half up)
 *   charge = newPlanPrice - credit
 *
 * `totalDays` and `daysRemaining` come from the real period dates via
 * getDaysBetween — never a hardcoded day count (PRD 5.11, last paragraph).
 *
 * Proration is defined for upgrades only. If the unused credit ever exceeds
 * the new-plan price (a downgrade or a price drop), this function throws
 * instead of silently discarding the excess (fail closed).
 */

import { getDaysBetween } from "@/lib/dates";

export interface ProrationBreakdown {
  /** Total calendar days in the current paid period. */
  totalDays: number;
  /** Calendar days left in the current paid period, clamped to [0, totalDays]. */
  daysRemaining: number;
  /** Value of the unused time on the old plan, in kobo. */
  creditAppliedKobo: number;
  /** New-plan price minus credit, in kobo. Never negative. */
  amountToChargeKobo: number;
}

/**
 * Round-half-up of numerator / denominator using integer arithmetic only:
 * floor((2n + d) / (2d)). No float division touches money math.
 */
function roundHalfUpKobo(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function calculateProration(params: {
  /** Full price of the plan the user is leaving, in kobo. */
  oldPriceKobo: number;
  /** Full price of the plan the user is buying, in kobo. */
  newPriceKobo: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}): ProrationBreakdown {
  const now = params.now ?? new Date();

  const totalDays = getDaysBetween(
    params.currentPeriodStart,
    params.currentPeriodEnd
  );
  const rawDaysRemaining = getDaysBetween(now, params.currentPeriodEnd);
  const daysRemaining = Math.max(0, Math.min(rawDaysRemaining, totalDays));

  const creditAppliedKobo =
    totalDays > 0
      ? roundHalfUpKobo(daysRemaining * params.oldPriceKobo, totalDays)
      : 0;

  const amountToChargeKobo = params.newPriceKobo - creditAppliedKobo;
  if (amountToChargeKobo < 0) {
    throw new Error(
      `Proration credit ${creditAppliedKobo} kobo exceeds new-plan price ` +
        `${params.newPriceKobo} kobo; proration is upgrade-only (FR-18)`
    );
  }

  return { totalDays, daysRemaining, creditAppliedKobo, amountToChargeKobo };
}
