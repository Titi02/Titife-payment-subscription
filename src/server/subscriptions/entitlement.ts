/**
 * Entitlement reader — 7.2
 * Single source of truth for "what is the user's entitlement right now."
 *
 * The Subscription row is the projection the system keeps in step with the
 * append-only PaymentLog: subscribe, upgrade, and the scheduled expiry sweep
 * all write planType / interval / period boundaries / status there. This
 * reader reports those stored values (not a re-derivation from log metadata),
 * so a plan change applied at a period boundary is reflected immediately and
 * the before/after period math lives only in the payment log (FR-20a).
 *
 * Cancellation semantics (FR-27 / FR-28): the row's stored status is
 * CANCELLING while access is retained. For display we surface CANCELED, which
 * is the effective "will not renew" state; planType and currentPeriodEnd are
 * preserved so access lasts until currentPeriodEnd. Only the expiry sweep
 * lapses the subscription to Free once the paid term ends (FR-23a / FR-29).
 */

import { prisma } from "@/server/db/prisma";
import type {
  PlanType,
  BillingInterval,
  SubscriptionStatus,
} from "@prisma/client";

export interface UserEntitlement {
  planType: PlanType;
  interval: BillingInterval | null;
  status: SubscriptionStatus | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanType: PlanType | null;
  pendingInterval: BillingInterval | null;
  hasSubscription: boolean;
}

export async function getUserEntitlement(
  userId: string
): Promise<UserEntitlement> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  // FR-3: no subscription row means Free by default
  if (!subscription) {
    return {
      planType: "FREE",
      interval: null,
      status: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      pendingPlanType: null,
      pendingInterval: null,
      hasSubscription: false,
    };
  }

  const now = new Date();
  const periodEnd = subscription.currentPeriodEnd;

  // Access exists only while the paid term is active. If the stored plan is
  // Free, or the paid period has already ended, the user is Free. The expiry
  // sweep clears the period fields at the end of the term; this branch also
  // covers the window before the sweep runs, so an ended paid term can never
  // derive access past its end date.
  const paidTermActive =
    subscription.planType !== "FREE" && periodEnd !== null && now <= periodEnd;

  if (!paidTermActive) {
    return {
      planType: "FREE",
      interval: null,
      status:
        subscription.planType !== "FREE"
          ? ("CANCELED" as SubscriptionStatus)
          : null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      pendingPlanType: null,
      pendingInterval: null,
      hasSubscription: true,
    };
  }

  return {
    planType: subscription.planType,
    interval: subscription.interval,
    // Within the paid term, access is retained regardless of cancellation
    // (FR-27 / FR-28). A cancellation-at-period-end derives CANCELED for
    // display while the row keeps the plan and period boundaries intact.
    status: subscription.cancelAtPeriodEnd
      ? ("CANCELED" as SubscriptionStatus)
      : ("ACTIVE" as SubscriptionStatus),
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    // FR-24a: a pending change (downgrade) is shown until the sweep applies it.
    pendingPlanType: subscription.pendingPlanType,
    pendingInterval: subscription.pendingInterval,
    hasSubscription: true,
  };
}
