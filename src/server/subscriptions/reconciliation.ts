import { prisma } from "@/server/db/prisma";
import { flagTransaction } from "@/server/payments/transaction";

/**
 * Phase 4 — Reconciliation sweep
 * 
 * FR-16a: A VERIFICATION row with no corresponding FULFILMENT row after 15 minutes
 * is treated as a stuck transaction. This query surfaces these stuck transactions
 * for manual auditing and intervention, and stamps the parent Transaction with a
 * STUCK flag (idempotent) so the state is durable rather than recomputed each run.
 */
export async function findStuckTransactions() {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  // Find all VERIFICATION events older than 15 minutes
  const verifications = await prisma.paymentLog.findMany({
    where: {
      eventType: "VERIFICATION",
      createdAt: {
        lt: fifteenMinutesAgo,
      },
    },
  });

  const stuckTransactions: { providerReference: string; userId: string; createdAt: Date }[] = [];

  for (const v of verifications) {
    // Check if there's a corresponding FULFILMENT for this providerReference
    const fulfilment = await prisma.paymentLog.findFirst({
      where: {
        providerReference: v.providerReference,
        eventType: "FULFILMENT",
      },
    });

    if (!fulfilment) {
      stuckTransactions.push({
        providerReference: v.providerReference,
        userId: v.userId,
        createdAt: v.createdAt,
      });

      const transaction = await prisma.transaction.findFirst({
        where: { providerReference: v.providerReference },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      if (transaction) {
        await flagTransaction({
          transactionId: transaction.id,
          flagType: "STUCK",
          note: "VERIFICATION recorded with no FULFILMENT after 15 minutes",
        });
      }
    }
  }

  return stuckTransactions;
}
