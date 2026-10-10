import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db/prisma";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import type { BillingInterval, PlanType } from "@prisma/client";

/**
 * No-charge pending plan change — FR-21, FR-22, FR-23a, FR-24.
 *
 * Both downgrades are scheduled, never immediate, and charge nothing here:
 *   - Yearly -> Monthly: the Yearly plan and its access stay live until the
 *     current period ends; at that boundary the expiry sweep applies the
 *     pending Monthly change. No term is bought by this request — the system
 *     never auto-charges (non-recurring, PRD 5.1), so the user must start a
 *     Monthly payment themselves once the boundary passes.
 *   - Paid (Monthly or Yearly) -> Free: the paid term runs to the period end,
 *     then the sweep clears the period fields and the user reverts to Free
 *     (FR-23a).
 *
 * This route records intent only; it grants nothing (FR-8). FR-24: a second
 * request overwrites whatever change was already pending.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let planType: PlanType | null = null;
  try {
    const json = await req.json();
    planType = json.planType;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (planType !== "MONTHLY" && planType !== "FREE") {
    return NextResponse.json(
      { error: "Invalid downgrade target" },
      { status: 400 }
    );
  }

  const entitlement = await getUserEntitlement(user.id);

  // Allow downgrade when paid term is still active (including subscriptions
  // already scheduled for cancellation at period end). Do not rely solely on
  // the derived status label.
  const paidTermActive =
    entitlement.planType !== "FREE" &&
    entitlement.currentPeriodEnd !== null &&
    new Date() <= entitlement.currentPeriodEnd;

  if (!paidTermActive) {
    return NextResponse.json(
      { error: "No active subscription to downgrade" },
      { status: 400 }
    );
  }

  if (planType === "MONTHLY" && entitlement.planType !== "YEARLY") {
    return NextResponse.json(
      { error: "Only the Yearly plan can be downgraded to Monthly" },
      { status: 400 }
    );
  }

  if (planType === "FREE" && entitlement.planType === "FREE") {
    return NextResponse.json(
      { error: "Subscription is already Free" },
      { status: 400 }
    );
  }

  // FR-22: recorded as a pending change, no charge. Free has no interval.
  const pendingInterval: BillingInterval | null =
    planType === "MONTHLY" ? "MONTHLY" : null;

  await prisma.subscription.update({
    where: { userId: user.id },
    data: {
      pendingPlanType: planType,
      pendingInterval,
    },
  });

  return NextResponse.json({ success: true });
}
