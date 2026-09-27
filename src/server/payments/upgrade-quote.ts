/**
 * Shared guard + proration for the upgrade preview (GET) and the upgrade
 * charge (POST), so the number shown to the user and the number charged are
 * computed by the exact same code path (FR-18 / AGENTS.md Rule 8).
 *
 * The proration's `now` is sampled once here, inside a single
 * calculateProration call, so daysRemaining, credit, and amount are always
 * mutually consistent within one quote.
 */

import { prisma } from "@/server/db/prisma";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import { MONTHLY_PRICE_KOBO, YEARLY_PRICE_KOBO } from "@/lib/money";
import { calculateProration } from "@/server/payments/proration";

export interface UpgradeQuote {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  daysRemaining: number;
  creditKobo: number;
  amountKobo: number;
}

export class UpgradeQuoteError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "UpgradeQuoteError";
  }
}

export async function getUpgradeQuote(userId: string): Promise<UpgradeQuote> {
  const entitlement = await getUserEntitlement(userId);
  // A cancelled Monthly subscription still has a paid term running (FR-27 /
  // FR-28), so an upgrade is allowed from either ACTIVE or the derived
  // CANCELED display state. Only the current plan must be Monthly.
  if (
    entitlement.planType !== "MONTHLY" ||
    (entitlement.status !== "ACTIVE" && entitlement.status !== "CANCELED")
  ) {
    throw new UpgradeQuoteError("Invalid subscription state for upgrade", 400);
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  if (
    !subscription ||
    !subscription.currentPeriodStart ||
    !subscription.currentPeriodEnd
  ) {
    throw new UpgradeQuoteError("Missing active period for upgrade", 400);
  }

  const proration = calculateProration({
    oldPriceKobo: MONTHLY_PRICE_KOBO,
    newPriceKobo: YEARLY_PRICE_KOBO,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
  });

  return {
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    daysRemaining: proration.daysRemaining,
    creditKobo: proration.creditAppliedKobo,
    amountKobo: proration.amountToChargeKobo,
  };
}
