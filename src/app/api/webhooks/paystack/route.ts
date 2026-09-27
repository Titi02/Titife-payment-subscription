import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/server/paystack/verify-webhook-signature";
import { writePaymentLog, jsonToMetadataRecord } from "@/server/payments/log";
import { isEventAlreadyRecorded } from "@/server/payments/idempotency";
import {
  upsertTransaction,
  flagTransaction,
  advanceTransactionStatus,
} from "@/server/payments/transaction";
import { prisma } from "@/server/db/prisma";
import { addBillingInterval } from "@/lib/dates";
import { Prisma } from "@prisma/client";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import { refundTransaction } from "@/server/paystack/refund-transaction";

/**
 * Paystack Webhook Handler — FR-11, FR-12, FR-13, FR-14
 * Phase 5: Auto-refunds duplicate payments and uses derived entitlement.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-paystack-signature");

  const isValid = verifyWebhookSignature(rawBody, signatureHeader);
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const payload = JSON.parse(rawBody);
  const eventName: string = payload.event;
  const data = payload.data;

  // FR-12 / FR-13: record the authenticated callback BEFORE any business
  // logic runs. CALLBACK_VERIFIED means only that the x-paystack-signature
  // HMAC matched — it does NOT mean the payment succeeded. Payment success
  // or failure is recorded separately as CHARGE_SUCCESS / CHARGE_FAILURE.
  await recordCallbackVerified(data);

  if (eventName === "charge.success") {
    return handleChargeSuccess(data);
  }

  if (eventName === "charge.failed") {
    return handleChargeFailed(data);
  }

  return NextResponse.json({ status: "ignored - unhandled event type" });
}

/**
 * Records a CALLBACK_VERIFIED PaymentLog row after (and only after) the
 * webhook signature has passed verification. Idempotent via the composite
 * constraints, and attributed to the user through the INITIATION row.
 */
async function recordCallbackVerified(data: Record<string, unknown>): Promise<void> {
  const reference = data.reference as string;
  if (!reference) {
    return;
  }

  const initiation = await prisma.paymentLog.findFirst({
    where: { providerReference: reference, eventType: "INITIATION" },
    select: { userId: true, planType: true, interval: true, transactionId: true },
  });

  if (!initiation) {
    return;
  }

  const paystackTransactionId = data.id != null ? String(data.id) : undefined;

  const alreadyRecorded = await isEventAlreadyRecorded({
    providerReference: reference,
    eventType: "CALLBACK_VERIFIED",
    paystackTransactionId,
  });

  if (alreadyRecorded) {
    return;
  }

  try {
    await writePaymentLog({
      userId: initiation.userId,
      eventType: "CALLBACK_VERIFIED",
      providerReference: reference,
      paystackTransactionId,
      amount: (data.amount as number) ?? 0,
      currency: (data.currency as string) ?? "ngn",
      planType: initiation.planType ?? undefined,
      interval: initiation.interval ?? undefined,
      transactionId: initiation.transactionId ?? undefined,
    });
  } catch (err: unknown) {
    if (!isPrismaUniqueConstraintError(err)) {
      console.error("Failed to log CALLBACK_VERIFIED event:", err);
    }
  }
}

async function handleChargeSuccess(data: Record<string, unknown>): Promise<NextResponse> {
  const reference = data.reference as string;
  const paystackTxId = String(data.id);

  try {
    const initiationEvent = await prisma.paymentLog.findFirst({
      where: {
        providerReference: reference,
        eventType: "INITIATION",
      },
    });

    if (!initiationEvent) {
      return NextResponse.json({ status: "ignored - unknown reference" });
    }

    const userId = initiationEvent.userId;
    const requestedPlanType = initiationEvent.planType;
    const requestedInterval = initiationEvent.interval;

    // FR-14: Idempotency check, run BEFORE touching the Transaction summary so
    // a redelivered (or return-view-first) charge.success can never regress the
    // terminal status. On first delivery this row does not exist yet.
    const alreadyFulfilled = await isEventAlreadyRecorded({
      providerReference: reference,
      eventType: "FULFILMENT",
      paystackTransactionId: paystackTxId,
    });

    if (alreadyFulfilled) {
      // The charge is confirmed paid; move the summary to its terminal SUCCESS
      // if it is still mid-flight (INITIATED/VERIFIED). SUCCESS/REFUNDED are
      // left untouched — advanceTransactionStatus never regresses a terminal
      // state.
      await advanceTransactionStatus({
        userId,
        providerReference: reference,
        paystackTransactionId: paystackTxId,
        amount: (data.amount as number) ?? 0,
        currency: (data.currency as string) ?? "ngn",
        planType: requestedPlanType ?? undefined,
        interval: requestedInterval ?? undefined,
        status: "SUCCESS",
      });
      await safeLogDuplicate(userId, reference, paystackTxId, data);
      return NextResponse.json({ status: "ignored - already fulfilled" });
    }

    // Keep the Transaction summary in step: Paystack has processed the charge.
    const transaction = await upsertTransaction({
      userId,
      providerReference: reference,
      paystackTransactionId: paystackTxId,
      amount: (data.amount as number) ?? 0,
      currency: (data.currency as string) ?? "ngn",
      planType: requestedPlanType ?? undefined,
      interval: requestedInterval ?? undefined,
      status: "VERIFIED",
    });

    const alreadyChargeSucceeded = await isEventAlreadyRecorded({
      providerReference: reference,
      eventType: "CHARGE_SUCCESS",
      paystackTransactionId: paystackTxId,
    });

    if (!alreadyChargeSucceeded) {
      try {
        await writePaymentLog({
          userId,
          eventType: "CHARGE_SUCCESS",
          providerReference: reference,
          paystackTransactionId: paystackTxId,
          amount: data.amount as number,
          currency: data.currency as string,
          planType: requestedPlanType ?? undefined,
          interval: requestedInterval ?? undefined,
          transactionId: transaction.id,
        });
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err)) {
          await safeLogDuplicate(userId, reference, paystackTxId, data);
          return NextResponse.json({ status: "ignored - duplicate charge success" });
        }
        throw err;
      }
    }

    // Phase 5: Auto-refund duplicate checkout
    // A duplicate checkout is a new checkout (reference starts with "sub_") 
    // for the exact same plan the user is already ACTIVE on.
    const entitlement = await getUserEntitlement(userId);
    if (
      entitlement.status === "ACTIVE" &&
      entitlement.planType === requestedPlanType &&
      reference.startsWith("sub_")
    ) {
      console.log(`Detected duplicate checkout for user ${userId}. Issuing auto-refund.`);
      try {
        await refundTransaction(paystackTxId);

        // Record the refund as its own lifecycle event (REFUND_PROCESSED).
        await writePaymentLog({
          userId,
          eventType: "REFUND_PROCESSED",
          providerReference: reference,
          paystackTransactionId: paystackTxId,
          amount: data.amount as number,
          currency: data.currency as string,
          planType: requestedPlanType,
          interval: requestedInterval ?? undefined,
          transactionId: transaction.id,
          metadata: { reason: "Duplicate active payment" },
        });

        // Move the Transaction summary to REFUNDED and flag the duplicate.
        await upsertTransaction({
          userId,
          providerReference: reference,
          paystackTransactionId: paystackTxId,
          amount: data.amount as number,
          currency: data.currency as string,
          planType: requestedPlanType,
          interval: requestedInterval ?? undefined,
          status: "REFUNDED",
        });
        await flagTransaction({
          transactionId: transaction.id,
          flagType: "DUPLICATE_CHARGE",
          note: "Duplicate active payment detected and auto-refunded",
          metadata: { originalReference: reference },
        });

        // Log FULFILMENT with refunded metadata
        await writePaymentLog({
          userId,
          eventType: "FULFILMENT",
          providerReference: reference,
          paystackTransactionId: paystackTxId,
          amount: data.amount as number,
          currency: data.currency as string,
          planType: requestedPlanType,
          interval: requestedInterval ?? undefined,
          transactionId: transaction.id,
          metadata: { refunded: true, reason: "Duplicate active payment" },
        });

        // Log DUPLICATE_IGNORED event as per PRD
        await safeLogDuplicate(userId, reference, paystackTxId, data);

        return NextResponse.json({ status: "success - refunded duplicate" });
      } catch (refundError) {
        console.error("Auto-refund failed:", refundError);
        // If refund fails, we just fall through or abort. Better to abort so we don't double-grant.
        return NextResponse.json({ error: "Failed to issue refund for duplicate payment" }, { status: 500 });
      }
    }

    // Normal Fulfilment
    if (requestedPlanType && requestedInterval) {
      const now = new Date();
      const periodEnd = addBillingInterval(now, requestedInterval);
      const authorization = data.authorization as Record<string, unknown> | undefined;
      const authCode = authorization?.authorization_code as string | undefined;

      // upg_ references are paid plan changes (upgrade): a prorated charge buys
      // a fresh Yearly term starting today (PRD 5.11 / FR-19). Mirrors the
      // return view so the charge.success path behaves identically on
      // webhook-first. Downgrades are no-charge pending changes and never reach
      // Paystack's checkout, so they are not handled here.
      const isUpgrade = reference.startsWith("upg_");
      const planChangeSubscription = isUpgrade
        ? await prisma.subscription.findUnique({ where: { userId } })
        : null;
      const initiationMetadata = jsonToMetadataRecord(initiationEvent.metadata);

      try {
        await prisma.$transaction(async (tx) => {
          if (isUpgrade) {
            // An upgrade builds on the period that was credited. Fail closed
            // without it so an upgrade can never grant a term for nothing
            // (FR-18).
            if (
              !planChangeSubscription ||
              !planChangeSubscription.currentPeriodStart ||
              !planChangeSubscription.currentPeriodEnd
            ) {
              throw new Error(
                `Cannot fulfil upgrade ${reference}: no current paid period`
              );
            }

            const previousPeriodStart =
              planChangeSubscription.currentPeriodStart;
            const previousPeriodEnd = planChangeSubscription.currentPeriodEnd;
            const previousInterval =
              planChangeSubscription.interval ?? "MONTHLY";

            const creditApplied =
              typeof initiationMetadata?.creditApplied === "number"
                ? initiationMetadata.creditApplied
                : null;
            const upgradeStart = new Date();

            // FR-19: the prorated charge buys a fresh Yearly term from today.
            await tx.subscription.update({
              where: { userId },
              data: {
                planType: requestedPlanType,
                interval: requestedInterval,
                status: "ACTIVE",
                currentPeriodStart: upgradeStart,
                currentPeriodEnd: addBillingInterval(
                  upgradeStart,
                  requestedInterval
                ),
                cancelAtPeriodEnd: false,
                cancelledAt: null,
                cancellationReason: null,
                cancellationNote: null,
                pendingPlanType: null,
                pendingInterval: null,
                paystackAuthorizationCode: authCode,
              },
            });

            await tx.transaction.update({
              where: { id: transaction.id },
              data: { status: "SUCCESS" },
            });

            // FR-20a: record the credit and the before-period on the log.
            await writePaymentLog({
              userId,
              eventType: "FULFILMENT",
              providerReference: reference,
              paystackTransactionId: paystackTxId,
              amount: data.amount as number,
              currency: data.currency as string,
              planType: requestedPlanType,
              interval: requestedInterval,
              transactionId: transaction.id,
              metadata: {
                creditApplied,
                previousInterval,
                newInterval: requestedInterval,
                previousPeriodStart: previousPeriodStart.toISOString(),
                previousPeriodEnd: previousPeriodEnd.toISOString(),
              },
              tx,
            });
          } else {
            // Normal subscription: the row is the projection the entitlement
            // reader reports, so planType and status are written with the new
            // period (FR-15a clears any prior cancellation state).
            await tx.subscription.upsert({
              where: { userId },
              update: {
                planType: requestedPlanType,
                interval: requestedInterval,
                status: "ACTIVE",
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                cancelAtPeriodEnd: false,
                cancelledAt: null,
                cancellationReason: null,
                cancellationNote: null,
                pendingPlanType: null,
                pendingInterval: null,
                paystackAuthorizationCode: authCode,
              },
              create: {
                userId,
                planType: requestedPlanType,
                interval: requestedInterval,
                status: "ACTIVE",
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                paystackAuthorizationCode: authCode,
              },
            });

            await tx.transaction.update({
              where: { id: transaction.id },
              data: { status: "SUCCESS" },
            });

            await writePaymentLog({
              userId,
              eventType: "FULFILMENT",
              providerReference: reference,
              paystackTransactionId: paystackTxId,
              amount: data.amount as number,
              currency: data.currency as string,
              planType: requestedPlanType,
              interval: requestedInterval,
              transactionId: transaction.id,
              metadata: jsonToMetadataRecord(initiationEvent.metadata),
              tx,
            });
          }
        });
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err)) {
          await safeLogDuplicate(userId, reference, paystackTxId, data);
          return NextResponse.json({ status: "ignored - duplicate fulfilment" });
        }
        throw err;
      }
    }

    return NextResponse.json({ status: "success" });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function handleChargeFailed(data: Record<string, unknown>): Promise<NextResponse> {
  const reference = data.reference as string;
  const paystackTxId = String(data.id);

  try {
    const initiationEvent = await prisma.paymentLog.findFirst({
      where: {
        providerReference: reference,
        eventType: "INITIATION",
      },
    });

    if (!initiationEvent) {
      return NextResponse.json({ status: "ignored - unknown reference" });
    }

    const alreadyRecorded = await isEventAlreadyRecorded({
      providerReference: reference,
      eventType: "CHARGE_FAILURE",
      paystackTransactionId: paystackTxId,
    });

    if (alreadyRecorded) {
      return NextResponse.json({ status: "ignored - failure already recorded" });
    }

    const transaction = await upsertTransaction({
      userId: initiationEvent.userId,
      providerReference: reference,
      paystackTransactionId: paystackTxId,
      amount: (data.amount as number) ?? 0,
      currency: (data.currency as string) ?? "ngn",
      planType: initiationEvent.planType ?? undefined,
      interval: initiationEvent.interval ?? undefined,
      status: "FAILED",
    });

    try {
      await writePaymentLog({
        userId: initiationEvent.userId,
        eventType: "CHARGE_FAILURE",
        providerReference: reference,
        paystackTransactionId: paystackTxId,
        amount: data.amount as number,
        currency: data.currency as string,
        planType: initiationEvent.planType ?? undefined,
        interval: initiationEvent.interval ?? undefined,
        transactionId: transaction.id,
      });
    } catch (err: unknown) {
      if (isPrismaUniqueConstraintError(err)) {
        return NextResponse.json({ status: "ignored - duplicate failure" });
      }
      throw err;
    }

    return NextResponse.json({ status: "failure recorded" });
  } catch (error) {
    console.error("Webhook charge.failed processing error:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

async function safeLogDuplicate(
  userId: string,
  originalReference: string,
  paystackTxId: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await writePaymentLog({
      userId,
      eventType: "DUPLICATE_IGNORED",
      providerReference: `dup_${originalReference}_${Date.now()}`,
      paystackTransactionId: paystackTxId,
      amount: (data.amount as number) ?? 0,
      currency: (data.currency as string) ?? "ngn",
      metadata: {
        originalReference,
        reason: "Duplicate webhook delivery absorbed by idempotency guard",
      },
    });
  } catch (logError) {
    console.error("Failed to log DUPLICATE_IGNORED event:", logError);
  }
}
