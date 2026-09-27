/**
 * Payment log writer — the ONLY place PaymentLog rows are written.
 * (AGENTS.md Section 4: /server/payments/log.ts)
 *
 * Every payment-affecting action produces a corresponding PaymentLog row.
 * (PRD Section 11, Success Metric 1: zero silent state changes)
 */

import { prisma } from "@/server/db/prisma";
import {
  Prisma,
  type PaymentLogType,
  type PlanType,
  type BillingInterval,
} from "@prisma/client";
import { isPrismaUniqueConstraintError } from "@/server/payments/idempotency";

interface WritePaymentLogParams {
  userId: string;
  eventType: PaymentLogType;
  providerReference: string;
  paystackTransactionId?: string;
  /** Amount in kobo. Always an integer. */
  amount: number;
  currency?: string;
  planType?: PlanType;
  interval?: BillingInterval;
  metadata?: Record<string, unknown>;
  /** Optional link to the parent Transaction row (per-attempt summary). */
  transactionId?: string;
  /**
   * Optional transaction client. When provided, the row is written as part
   * of the caller's $transaction so it commits atomically with the other
   * rows in that transaction. When omitted, the global client is used.
   */
  tx?: Prisma.TransactionClient;
}

export async function writePaymentLog(params: WritePaymentLogParams) {
  const client = params.tx ?? prisma;
  const event = await client.paymentLog.create({
    data: {
      userId: params.userId,
      eventType: params.eventType,
      providerReference: params.providerReference,
      paystackTransactionId: params.paystackTransactionId ?? null,
      amount: params.amount,
      currency: params.currency ?? "ngn",
      planType: params.planType ?? null,
      interval: params.interval ?? null,
      transactionId: params.transactionId ?? null,
      metadata: params.metadata ? (params.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });

  return event;
}

/**
 * Converts a Prisma Json field into a plain metadata record, or undefined when
 * the value is null/absent or not a JSON object (e.g. a scalar or array). Used
 * to pass an INITIATION row's metadata through to its FULFILMENT row so the
 * same before-and-after facts survive whichever path fulfils the charge.
 */
export function jsonToMetadataRecord(
  value: Prisma.JsonValue | null | undefined
): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Records a DUPLICATE_IGNORED row for a lifecycle event that a composite
 * unique constraint already absorbed (FR-14). Mirrors the webhook's
 * safeLogDuplicate behavior, so duplicate deliveries are audited rather
 * than silently dropped. Swallows its own P2002 so a second duplicate
 * cannot escalate into a 500.
 */
export async function logDuplicateIgnored(params: {
  userId: string;
  originalReference: string;
  paystackTransactionId: string;
  amount: number;
  currency?: string;
  planType?: PlanType;
  interval?: BillingInterval;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await writePaymentLog({
      userId: params.userId,
      eventType: "DUPLICATE_IGNORED",
      providerReference: `dup_${params.originalReference}_${Date.now()}`,
      paystackTransactionId: params.paystackTransactionId,
      amount: params.amount,
      currency: params.currency ?? "ngn",
      planType: params.planType,
      interval: params.interval,
      metadata: {
        originalReference: params.originalReference,
        reason: "Duplicate event delivery absorbed by idempotency guard",
        ...(params.metadata ?? {}),
      },
    });
  } catch (logError: unknown) {
    if (!isPrismaUniqueConstraintError(logError)) {
      console.error("Failed to log DUPLICATE_IGNORED event:", logError);
    }
  }
}
