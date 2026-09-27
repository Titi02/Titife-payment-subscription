/**
 * Transaction / TransactionFlag writers.
 *
 * Transaction is the per-attempt "current state" summary; PaymentLog is the
 * append-only system of record. These helpers keep the Transaction row in
 * step with the lifecycle events without touching the log's idempotency
 * guarantees. Money is always an integer number of kobo (AGENTS.md Section 2).
 */

import { prisma } from "@/server/db/prisma";
import { Prisma } from "@prisma/client";
import type {
  BillingInterval,
  PlanType,
  Transaction,
  TransactionFlagType,
  TransactionStatus,
} from "@prisma/client";

interface UpsertTransactionParams {
  userId: string;
  providerReference: string;
  /** Amount in kobo. Always an integer. */
  amount: number;
  currency?: string;
  planType?: PlanType | null;
  interval?: BillingInterval | null;
  status?: TransactionStatus;
  paystackTransactionId?: string | null;
  tx?: Prisma.TransactionClient;
}

/**
 * Creates or updates the Transaction row for a given providerReference.
 * providerReference is deliberately NOT unique on Transaction (AGENTS.md
 * Section 2: idempotency belongs to PaymentLog's composite constraints), so
 * this is a find-then-create/update rather than a DB-level upsert. Guards
 * against double-entitlement live in PaymentLog; this row is only a
 * per-attempt summary.
 */
export async function upsertTransaction(
  params: UpsertTransactionParams
): Promise<Transaction> {
  const client = params.tx ?? prisma;
  const existing = await client.transaction.findFirst({
    where: { providerReference: params.providerReference },
  });

  if (!existing) {
    return client.transaction.create({
      data: {
        userId: params.userId,
        providerReference: params.providerReference,
        amount: params.amount,
        currency: params.currency ?? "ngn",
        planType: params.planType ?? null,
        interval: params.interval ?? null,
        status: params.status ?? "INITIATED",
        paystackTransactionId: params.paystackTransactionId ?? null,
      },
    });
  }

  return client.transaction.update({
    where: { id: existing.id },
    data: {
      amount: params.amount,
      currency: params.currency ?? "ngn",
      ...(params.planType !== undefined ? { planType: params.planType } : {}),
      ...(params.interval !== undefined ? { interval: params.interval } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.paystackTransactionId !== undefined
        ? { paystackTransactionId: params.paystackTransactionId }
        : {}),
    },
  });
}

interface AdvanceTransactionStatusParams {
  providerReference: string;
  userId: string;
  /** Amount in kobo. Always an integer. */
  amount: number;
  currency?: string;
  planType?: PlanType | null;
  interval?: BillingInterval | null;
  paystackTransactionId?: string | null;
  status: TransactionStatus;
}

/**
 * Advances the Transaction summary to a later lifecycle stage without ever
 * regressing a terminal one. The documented lifecycle is
 * INITIATED -> VERIFIED -> SUCCESS, with FAILED/REFUNDED terminal for their
 * own paths (schema.prisma). A redelivered webhook (or a verification-first
 * flow where the return view already fulfilled) must not overwrite SUCCESS or
 * REFUNDED back to VERIFIED. Non-status fields are always backfilled so a late
 * webhook can still attach paystackTransactionId to a return-view-fulfilled
 * transaction.
 */
export async function advanceTransactionStatus(
  params: AdvanceTransactionStatusParams
): Promise<Transaction> {
  const existing = await prisma.transaction.findFirst({
    where: { providerReference: params.providerReference },
    orderBy: { createdAt: "asc" },
  });

  if (!existing) {
    return upsertTransaction({ ...params });
  }

  const nonTerminal =
    existing.status === "INITIATED" || existing.status === "VERIFIED";

  return prisma.transaction.update({
    where: { id: existing.id },
    data: {
      amount: params.amount,
      currency: params.currency ?? "ngn",
      ...(nonTerminal ? { status: params.status } : {}),
      ...(params.planType !== undefined ? { planType: params.planType } : {}),
      ...(params.interval !== undefined ? { interval: params.interval } : {}),
      ...(params.paystackTransactionId !== undefined
        ? { paystackTransactionId: params.paystackTransactionId }
        : {}),
    },
  });
}

/**
 * Adds a typed flag to a Transaction. Idempotent via
 * @@unique([transactionId, flagType]) — a second call for the same flag type
 * updates the existing row instead of duplicating it.
 */
export async function flagTransaction(params: {
  transactionId: string;
  flagType: TransactionFlagType;
  note?: string;
  metadata?: Record<string, unknown>;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  const client = params.tx ?? prisma;
  await client.transactionFlag.upsert({
    where: {
      transactionId_flagType: {
        transactionId: params.transactionId,
        flagType: params.flagType,
      },
    },
    create: {
      transactionId: params.transactionId,
      flagType: params.flagType,
      note: params.note,
      metadata: params.metadata
        ? (params.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
    update: {
      note: params.note,
      metadata: params.metadata
        ? (params.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });
}
