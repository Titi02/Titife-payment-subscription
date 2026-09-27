import { prisma } from "@/server/db/prisma";

/**
 * Expiry sweep — scheduled job at period boundaries (PRD 5.1).
 *
 * The app is non-recurring: it never auto-renews and never initiates a charge.
 * A subscription is a fixed, pre-paid term. When currentPeriodEnd passes this
 * sweep does exactly one of two things:
 *
 *   1. If a no-charge pending plan change is recorded (Yearly -> Monthly), it
 *      applies that plan and interval. No new term is granted and nothing is
 *      charged — the system never auto-charges, so the user must start a
 *      payment themselves to regain access.
 *   2. Otherwise it lapses the subscription to Free (FR-23a / FR-29). This
 *      covers a plain term expiry and a pending paid -> Free downgrade.
 *
 * In both cases the period fields are cleared, so the stored row matches the
 * derived entitlement (see entitlement.ts): with no active period the user
 * reads as Free until they buy a new term.
 */
export async function runExpirySweep() {
  console.log("Starting expiry sweep...");
  const now = new Date();

  const dueSubs = await prisma.subscription.findMany({
    where: {
      currentPeriodEnd: { not: null, lte: now },
    },
  });

  for (const sub of dueSubs) {
    // A pending Yearly -> Monthly change is applied at the boundary, but it
    // grants no access and charges nothing: the paid term has ended.
    if (sub.pendingPlanType !== null && sub.pendingInterval !== null) {
      console.log(
        `Applying pending plan change ${sub.pendingPlanType} to ${sub.id}`
      );
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          planType: sub.pendingPlanType,
          interval: sub.pendingInterval,
          status: "CANCELED",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          pendingPlanType: null,
          pendingInterval: null,
        },
      });
      continue;
    }

    console.log(`Lapsing expired subscription ${sub.id} to Free`);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        planType: "FREE",
        interval: null,
        status: "CANCELED",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pendingPlanType: null,
        pendingInterval: null,
      },
    });
  }

  console.log("Expiry sweep completed.");
}
