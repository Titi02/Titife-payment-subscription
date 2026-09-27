import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { verifyTransaction } from "@/server/paystack/verify-transaction";
import { writePaymentLog, jsonToMetadataRecord } from "@/server/payments/log";
import {
  isEventAlreadyRecorded,
  runFulfilmentTransaction,
} from "@/server/payments/idempotency";
import { prisma } from "@/server/db/prisma";
import { addBillingInterval } from "@/lib/dates";
import { formatKoboToNaira } from "@/lib/money";
import { Prisma, type BillingInterval, type PlanType } from "@prisma/client";

// Statuses that are a decisive payment failure (FR-16 CHARGE_FAILURE lifecycle).
// The customer is NOT entitled to anything for these, and the CHARGE_FAILURE
// event is recorded in the payment log.
const DECISIVE_FAILURE_STATUSES = new Set(["failed", "abandoned"]);

// Statuses where the transaction is still progressing through Paystack —
// not failed yet, so no CHARGE_FAILURE event is written and the user is told to
// refresh rather than retry.
const IN_PROGRESS_STATUSES = new Set(["pending", "ongoing", "processing", "queued"]);

/**
 * Return View — FR-7, FR-8, FR-9, FR-10
 * This view receives the user after checkout.
 * Rule: NEVER grant entitlement from the URL alone (FR-8).
 * We MUST call the server-side verifyTransaction endpoint.
 */
export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const { reference, trxref } = await searchParams;
  const paymentRef = reference || trxref;

  if (!paymentRef) {
    return (
      <div className="return-container">
        <div className="return-icon return-icon--error">?</div>
        <h1 className="return-title">Payment reference missing</h1>
        <p className="return-message">
          We couldn&apos;t find a payment reference in your request. Please return to the plans page and try again.
        </p>
        <Link href="/plans" className="btn btn--primary">
          Back to Plans
        </Link>
      </div>
    );
  }

  try {
    // FR-8: Server-side verification directly against Paystack
    const verifyData = await verifyTransaction(paymentRef);
    const isSuccess = verifyData.status === "success";
    const paystackTxId = String(verifyData.id);

    if (!isSuccess) {
      // FR-8: a non-success verification grants NOTHING. Distinct states
      // for decisive failure, in-progress, and anything unexpected.
      if (DECISIVE_FAILURE_STATUSES.has(verifyData.status)) {
        return handleFailedPayment(verifyData, user.id);
      }

      if (IN_PROGRESS_STATUSES.has(verifyData.status)) {
        return (
          <div className="return-container">
            <div className="return-icon return-icon--info">?</div>
            <h1 className="return-title">Payment still processing</h1>
            <p className="return-message">
              Paystack reports this payment as &quot;{verifyData.status}&quot;. We
              haven&apos;t confirmed it yet, so no charge is recorded — refresh in a
              moment or check your bank app.
            </p>
            <div style={{ display: "flex", gap: "16px" }}>
              <Link
                href={`/checkout/return?reference=${paymentRef}`}
                className="btn btn--primary"
              >
                Refresh Status
              </Link>
              <Link href="/plans" className="btn btn--outline">
                Back to Plans
              </Link>
            </div>
          </div>
        );
      }

      // Unexpected status (e.g. "reversed", "timeout", unknown) — no
      // entitlement, no CHARGE_FAILURE row, and a safe generic state (FR-10).
      return (
        <div className="return-container">
          <div className="return-icon return-icon--error">!</div>
          <h1 className="return-title">Payment not confirmed</h1>
          <p className="return-message">
            We couldn&apos;t confirm this payment. Paystack reports the status as
            &quot;{verifyData.status}&quot;. If you believe you were charged, check your
            billing later or contact support.
          </p>
          <div style={{ display: "flex", gap: "16px" }}>
            <Link href="/plans" className="btn btn--primary">
              Try Again
            </Link>
            <Link href="/billing" className="btn btn--outline">
              Back to Dashboard
            </Link>
          </div>
        </div>
      );
    }

    // FR-14: Idempotency check. Have we already processed VERIFICATION?
    const alreadyVerified = await isEventAlreadyRecorded({
      providerReference: paymentRef,
      eventType: "VERIFICATION",
      paystackTransactionId: paystackTxId,
    });

    if (alreadyVerified) {
      return (
        <div className="return-container">
          <div className="return-icon return-icon--success">✓</div>
          <h1 className="return-title">Payment already processed</h1>
          <p className="return-message">
            This payment was already successfully processed. Your subscription is active.
          </p>
          <Link href="/billing" className="btn btn--primary">
            Go to Billing
          </Link>
        </div>
      );
    }

    // Retrieve the original INITIATION event to get the requested plan and interval
    const initiationEvent = await prisma.paymentLog.findUnique({
      where: {
        providerReference_eventType: {
          providerReference: paymentRef,
          eventType: "INITIATION",
        },
      },
    });

    if (!initiationEvent) {
      throw new Error(`Initiation event not found for reference: ${paymentRef}`);
    }

    const requestedPlanType = initiationEvent.planType;
    const requestedInterval = initiationEvent.interval;

    if (!requestedPlanType || !requestedInterval) {
      throw new Error("Initiation event missing plan details");
    }

    // FR-8 security rule: the verified transaction must match what this
    // system expected to charge BEFORE any fulfilment is considered — both
    // the amount (exact, kobo) and the currency. Paystack returns "NGN"
    // while this system stores lowercase "ngn", so compare case-insensitively.
    if (verifyData.amount !== initiationEvent.amount) {
      throw new Error(`Amount mismatch. Expected ${initiationEvent.amount}, got ${verifyData.amount}`);
    }
    if (verifyData.currency.toLowerCase() !== initiationEvent.currency.toLowerCase()) {
      throw new Error(
        `Currency mismatch. Expected ${initiationEvent.currency}, got ${verifyData.currency}`
      );
    }

    // FR-16: Write VERIFICATION row
    await writePaymentLog({
      userId: user.id,
      eventType: "VERIFICATION",
      providerReference: paymentRef,
      paystackTransactionId: paystackTxId,
      amount: verifyData.amount,
      currency: verifyData.currency,
      planType: requestedPlanType ?? undefined,
      interval: requestedInterval ?? undefined,
    });

    // FR-15: Fulfilment - Create or update the Subscription row
    const now = new Date();
    const periodEnd = addBillingInterval(now, requestedInterval);
    const authCode = verifyData.authorization?.authorization_code;

    // upg_ references come from the paid plan-change checkout (upgrade). The
    // upgrade is prorated (PRD 5.11): the remaining Monthly time is credited
    // against the Yearly price, and on verified success the plan switches
    // immediately — currentPeriodStart resets to now and the new term runs one
    // full interval from there (FR-19). Downgrades are no-charge pending changes
    // and never travel through this paid checkout return view.
    const isUpgrade = paymentRef.startsWith("upg_");
    let alreadyFulfilled = false;

    if (isUpgrade) {
      const subscription = await prisma.subscription.findUnique({
        where: { userId: user.id },
      });

      // An upgrade always builds on the current paid term. Fail closed rather
      // than grant a term counted from nothing: without the period that was
      // credited there is no proration to honour (FR-18).
      if (
        !subscription ||
        !subscription.currentPeriodStart ||
        !subscription.currentPeriodEnd
      ) {
        throw new Error(
          `Cannot fulfil upgrade ${paymentRef}: subscription has no current paid period`
        );
      }

      const previousPeriodStart = subscription.currentPeriodStart;
      const previousPeriodEnd = subscription.currentPeriodEnd;
      const previousInterval = subscription.interval ?? "MONTHLY";
      const initiationMetadata = jsonToMetadataRecord(initiationEvent.metadata);

      // Prorated upgrade (Monthly -> Yearly).
      const creditApplied =
        typeof initiationMetadata?.creditApplied === "number"
          ? initiationMetadata.creditApplied
          : null;
      const upgradeStart = new Date();

      alreadyFulfilled = await runFulfilmentTransaction(async (tx) => {
        // FR-19: the prorated charge buys a fresh Yearly term starting today.
        await tx.subscription.update({
          where: { userId: user.id },
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

        // FR-20a: capture the credit and the before-period on the log so the
        // upgrade is reconstructable without recomputation.
        await writePaymentLog({
          userId: user.id,
          eventType: "FULFILMENT",
          providerReference: paymentRef,
          paystackTransactionId: paystackTxId,
          amount: verifyData.amount,
          currency: verifyData.currency,
          planType: requestedPlanType,
          interval: requestedInterval,
          metadata: {
            creditApplied,
            previousInterval,
            newInterval: requestedInterval,
            previousPeriodStart: previousPeriodStart.toISOString(),
            previousPeriodEnd: previousPeriodEnd.toISOString(),
          },
          tx,
        });
      });
    }

    if (!isUpgrade && !alreadyFulfilled) {
      // Use a transaction to ensure FULFILMENT log and Subscription update are atomic
      alreadyFulfilled = await runFulfilmentTransaction(async (tx) => {
        // 1. Update/Create Subscription
        // FR-15a: clear out cancellation fields if they exist
        await tx.subscription.upsert({
          where: { userId: user.id },
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
            userId: user.id,
            planType: requestedPlanType,
            interval: requestedInterval,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            paystackAuthorizationCode: authCode,
          },
        });

        // 2. Write FULFILMENT event (FR-16)
        await writePaymentLog({
          userId: user.id,
          eventType: "FULFILMENT",
          providerReference: paymentRef,
          paystackTransactionId: paystackTxId,
          amount: verifyData.amount,
          currency: verifyData.currency,
          planType: requestedPlanType,
          interval: requestedInterval,
          metadata: jsonToMetadataRecord(initiationEvent.metadata),
          tx,
        });
      });
    }

    if (alreadyFulfilled) {
      // The webhook (or a concurrent return-view) already committed this
      // FULFILMENT atomically with the Subscription write. Nothing further to
      // do — treat as success rather than surfacing a duplicate-write error.
      return (
        <div className="return-container">
          <div className="return-icon return-icon--success">✓</div>
          <h1 className="return-title">Payment already processed</h1>
          <p className="return-message">
            This payment was already fulfilled. Your subscription is active.
          </p>
          <Link href="/billing" className="btn btn--primary">
            Go to Billing
          </Link>
        </div>
      );
    }

    // Success view
    const newPlanLabel = requestedInterval === "YEARLY" ? "Yearly" : "Monthly";
    const successMessage = isUpgrade
      ? `Your ${newPlanLabel} plan is now active. We credited your unused Monthly time against the Yearly price and charged ${formatKoboToNaira(verifyData.amount)}.`
      : "Your subscription has been activated successfully.";
    return (
      <div className="return-container">
        <div className="return-icon return-icon--success">✓</div>
        <h1 className="return-title">Payment successful</h1>
        <p className="return-message">{successMessage}</p>
        <Link href="/billing" className="btn btn--primary">
          Go to Billing
        </Link>
      </div>
    );
  } catch (error) {
    console.error("Verification failed:", error);
    // FR-10: Catch-all for API timeouts or unexpected errors
    return (
      <div className="return-container">
        <div className="return-icon return-icon--error">!</div>
        <h1 className="return-title">Payment could not be verified</h1>
        <p className="return-message">
          We couldn&apos;t confirm this payment with Paystack right now. Nothing has been
          granted on the strength of this page. If you were charged, your plan will be
          updated automatically and you can check your billing page later.
        </p>
        <div style={{ display: "flex", gap: "16px" }}>
          <Link href={`/checkout/return?reference=${paymentRef}`} className="btn btn--primary">
            Try Again
          </Link>
          <Link href="/billing" className="btn btn--outline">
            Go to Billing
          </Link>
        </div>
      </div>
    );
  }
}

/**
 * Decisive failure from server-side verification.
 * - Records a CHARGE_FAILURE PaymentLog row (FR-16), idempotently — the
 *   webhook may also have recorded it, or the customer may revisit.
 * - Grants NO entitlement, by definition — nothing is written to the
 *   Subscription table.
 * - Marks the parent Transaction FAILED (idempotent) so a verification-only
 *   failure (e.g. an abandoned checkout, which never emits a charge.failed
 *   webhook) is represented in the per-attempt summary, not just the log.
 * - Offers "Try Again" (re-initiates checkout for the same plan the
 *   customer attempted) and "Go to Billing".
 */
async function handleFailedPayment(
  verifyData: Awaited<ReturnType<typeof verifyTransaction>>,
  userId: string
) {
  let attemptedInterval: BillingInterval | null = null;
  let attemptedPlan: PlanType | null = null;

  try {
    const initiationEvent = await prisma.paymentLog.findUnique({
      where: {
        providerReference_eventType: {
          providerReference: verifyData.reference,
          eventType: "INITIATION",
        },
      },
    });

    if (initiationEvent) {
      attemptedInterval = initiationEvent.interval;
      attemptedPlan = initiationEvent.planType;
    }

    // FR-16 / FR-14: CHARGE_FAILURE event, idempotency-guarded. A redelivered
    // webhook or a page refresh must not write a second CHARGE_FAILURE row.
    const alreadyRecorded = await isEventAlreadyRecorded({
      providerReference: verifyData.reference,
      eventType: "CHARGE_FAILURE",
      paystackTransactionId: String(verifyData.id),
    });

    if (!alreadyRecorded) {
      try {
        await writePaymentLog({
          userId,
          eventType: "CHARGE_FAILURE",
          providerReference: verifyData.reference,
          paystackTransactionId: String(verifyData.id),
          amount: verifyData.amount,
          currency: verifyData.currency,
          planType: attemptedPlan ?? undefined,
          interval: attemptedInterval ?? undefined,
        });
      } catch (err: unknown) {
        // Duplicate between return view and webhook — safe to ignore;
        // the first write already recorded this failure.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
          console.error("Failed to log CHARGE_FAILURE event:", err);
        }
      }
    }

    // Keep the per-attempt Transaction summary accurate for failures that
    // arrive via verification only. Abandoned checkouts never produce a
    // charge.failed webhook, so the return view is the only place this
    // failure is ever observed — without this the Transaction would stay
    // INITIATED forever even though the CHARGE_FAILURE log row exists.
    // Idempotent: a restart or refresh re-runs the same update. updateMany,
    // because providerReference is deliberately not unique on Transaction
    // (AGENTS.md Section 2); 0 rows updated is a harmless no-op.
    try {
      await prisma.transaction.updateMany({
        where: { providerReference: verifyData.reference },
        data: {
          status: "FAILED",
          paystackTransactionId: String(verifyData.id),
        },
      });
    } catch (txErr: unknown) {
      console.error("Failed to mark Transaction FAILED:", txErr);
    }
  } catch (logError) {
    console.error("Failed to record declined payment:", logError);
  }

  const isAbandoned = verifyData.status === "abandoned";

    // Plan changes (upg_) must be retried through their own flow so the correct
    // business rule is preserved (prorated charge, new term starting today).
    // Re-initiating a raw checkout here would bypass those rules.
    const isPlanChange = verifyData.reference.startsWith("upg_");

  return (
    <div className="return-container">
      <div className="return-icon return-icon--error">!</div>
      <h1 className="return-title">
        {isAbandoned ? "Payment not completed" : "Payment declined"}
      </h1>
      <p className="return-message">
        {isAbandoned
          ? "You cancelled or left the payment before it was completed. You have not been charged and your current plan is unchanged."
          : "Your payment was declined. You have not been charged and your current plan is unchanged."}
      </p>
      <div style={{ display: "flex", gap: "16px" }}>
        {isPlanChange ? (
          <Link href="/billing" className="btn btn--primary">
            Try Again
          </Link>
        ) : attemptedInterval ? (
          <form action="/api/checkout/initiate" method="POST">
            <input type="hidden" name="interval" value={attemptedInterval} />
            <button type="submit" className="btn btn--primary">
              Try Again
            </button>
          </form>
        ) : (
          <Link href="/plans" className="btn btn--primary">
            Try Again
          </Link>
        )}
        <Link href="/billing" className="btn btn--outline">
          Go to Billing
        </Link>
      </div>
    </div>
  );
}
