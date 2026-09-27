import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { prisma } from "@/server/db/prisma";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import type { CancellationReason } from "@prisma/client";

const VALID_REASONS: CancellationReason[] = [
  "TOO_EXPENSIVE",
  "MISSING_FEATURES",
  "SWITCHING_PROVIDER",
  "TEMPORARY_PAUSE",
  "OTHER",
];

/**
 * Cancel Subscription — FR-25, FR-26, FR-27, FR-28
 *
 * Sets status = CANCELLING and cancelAtPeriodEnd = true. planType and
 * currentPeriodEnd are preserved, so access is retained until the period ends
 * (see entitlement.ts). Does NOT alter currentPeriodEnd — user retains access
 * until that date (FR-28).
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entitlement = await getUserEntitlement(user.id);

  if (!entitlement.hasSubscription) {
    return NextResponse.json({ error: "No subscription found" }, { status: 400 });
  }

  // Only ACTIVE subscriptions can be cancelled
  if (entitlement.status !== "ACTIVE") {
    return NextResponse.json(
      { error: `Cannot cancel a subscription with derived status ${entitlement.status}` },
      { status: 400 }
    );
  }

  // Parse optional reason and note
  let reason: CancellationReason | null = null;
  let note: string | null = null;

  try {
    const body = await req.json();
    if (body.reason && VALID_REASONS.includes(body.reason)) {
      reason = body.reason as CancellationReason;
    }
    // FR-26: free-text only meaningful when reason = OTHER
    if (reason === "OTHER" && typeof body.note === "string") {
      note = body.note.trim() || null;
    }
  } catch {
    // Body is optional — no reason is allowed (FR-26: skipping it is allowed)
  }

  // FR-27: status = CANCELLING, cancelAtPeriodEnd = true, cancelledAt = now
  // FR-28: currentPeriodEnd is NOT changed — access retained until it passes
  await prisma.subscription.update({
    where: { userId: user.id },
    data: {
      status: "CANCELLING",
      cancelAtPeriodEnd: true,
      cancelledAt: new Date(),
      cancellationReason: reason,
      cancellationNote: note,
    },
  });

  return NextResponse.json({ success: true });
}
