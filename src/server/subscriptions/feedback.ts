"use server";

import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth";

/**
 * Persists optional post-cancellation feedback into cancellationNote.
 *
 * This is a cosmetic, optional capture: it only applies to a subscription
 * that is already cancelled at period end (cancelAtPeriodEnd = true). It
 * never changes plan, status, period boundaries, authorization codes, or
 * any payment/proration state (FR-27 / FR-28 behaviour is untouched).
 */
export async function saveCancellationFeedback(
  feedback: string
): Promise<{ ok: boolean; error?: string }> {
  const text = feedback.trim();
  if (!text) {
    return { ok: true };
  }

  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "Not signed in" };
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
  });

  if (!subscription || !subscription.cancelAtPeriodEnd) {
    return { ok: false, error: "No cancellation in progress" };
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancellationNote: text },
  });

  return { ok: true };
}