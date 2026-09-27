/**
 * Idempotency check — FR-14
 * Before writing any INITIATION/VERIFICATION/FULFILMENT/CHARGE_* row,
 * check the composite constraints: (providerReference, eventType) and
 * (paystackTransactionId, eventType).
 *
 * A redelivered webhook must be recorded once and never trigger a
 * second entitlement change.
 */

import { prisma } from "@/server/db/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentLogType } from "@prisma/client";

/**
 * Returns true if the thrown error is a Prisma unique-constraint violation
 * (P2002). Callers absorb concurrent duplicate deliveries with this check
 * rather than surfacing a 500 (FR-14).
 */
export function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

/**
 * Returns true when the error is a P2002 raised specifically by a PaymentLog
 * composite constraint — i.e. `(providerReference, eventType)` or
 * `(paystackTransactionId, eventType)`. Both composites include `eventType`,
 * so a target containing that field identifies a duplicate lifecycle event
 * rather than some other unique violation. Used to tell a "duplicate
 * FULFILMENT" apart from unrelated constraint errors.
 */
export function isPaymentLogDuplicateError(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== "P2002"
  ) {
    return false;
  }
  const target = err.meta?.target as unknown;
  if (Array.isArray(target)) {
    return target.includes("eventType");
  }
  return typeof target === "string" && target.includes("eventType");
}

/**
 * Runs an atomic fulfilment transaction and reports whether the write was
 * absorbed by a concurrent actor (the webhook, or a second return-view
 * request) that already committed the FULFILMENT row for this reference.
 *
 * When the FULFILMENT PaymentLog write hits its composite constraint, Prisma
 * rolls the whole transaction back — including the sibling Subscription write.
 * That rollback is harmless: the winning actor's Subscription + FULFILMENT
 * were committed atomically, so the caller must treat a `true` result as
 * "already fulfilled" (success) rather than an error or a double entitlement.
 */
export async function runFulfilmentTransaction(
  work: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<boolean> {
  try {
    await prisma.$transaction(work);
    return false;
  } catch (err) {
    if (isPaymentLogDuplicateError(err)) {
      return true;
    }
    throw err;
  }
}

/**
 * Returns true if this (reference, eventType) combination has already
 * been recorded — meaning the caller should treat this as a duplicate.
 */
export async function isEventAlreadyRecorded(params: {
  providerReference: string;
  eventType: PaymentLogType;
  paystackTransactionId?: string;
}): Promise<boolean> {
  // Check by providerReference + eventType first
  const existingByRef = await prisma.paymentLog.findUnique({
    where: {
      providerReference_eventType: {
        providerReference: params.providerReference,
        eventType: params.eventType,
      },
    },
    select: { id: true },
  });

  if (existingByRef) {
    return true;
  }

  // If we have a paystackTransactionId, also check that composite
  if (params.paystackTransactionId) {
    const existingByTxId = await prisma.paymentLog.findUnique({
      where: {
        paystackTransactionId_eventType: {
          paystackTransactionId: params.paystackTransactionId,
          eventType: params.eventType,
        },
      },
      select: { id: true },
    });

    if (existingByTxId) {
      return true;
    }
  }

  return false;
}
