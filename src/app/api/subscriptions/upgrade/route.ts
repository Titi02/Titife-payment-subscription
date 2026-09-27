import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { CURRENCY } from "@/lib/money";
import {
  getUpgradeQuote,
  UpgradeQuoteError,
} from "@/server/payments/upgrade-quote";
import { checkCheckoutRateLimit } from "@/server/rate-limit/checkout-limiter";
import { initializeTransaction } from "@/server/paystack/initialize-transaction";
import { writePaymentLog } from "@/server/payments/log";
import { upsertTransaction } from "@/server/payments/transaction";
import { randomUUID } from "crypto";

/**
 * Upgrade (Monthly -> Yearly, mid-cycle) — FR-17, FR-18, FR-20, FR-20a.
 *
 * The charge is prorated: unused time on the current Monthly period is turned
 * into credit against the Yearly price (PRD 5.11). The exact amount is
 * computed via the same getUpgradeQuote helper the preview endpoint uses, so
 * the number the user confirmed is the number Paystack charges (FR-18).
 *
 * No subscription change happens here: entitlement is granted by the return
 * view (or the verified webhook) after server-side verification (FR-8). This
 * route only writes the INITIATION lifecycle row and hands off to Paystack's
 * hosted checkout (AGENTS.md Section 2: hosted checkout, never Charge
 * Authorization).
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let quote;
  try {
    quote = await getUpgradeQuote(user.id);
  } catch (error) {
    if (error instanceof UpgradeQuoteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    throw error;
  }

  // FR-5 / AGENTS.md Rule 17: checkout initiation is rate-limited.
  const rateLimit = await checkCheckoutRateLimit(user.id);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  const amountKobo = quote.amountKobo;
  const providerReference = `upg_${randomUUID()}`;

  const transaction = await upsertTransaction({
    userId: user.id,
    providerReference,
    amount: amountKobo,
    currency: CURRENCY,
    planType: "YEARLY",
    interval: "YEARLY",
    status: "INITIATED",
  });

  // FR-20: INITIATION event is written before redirecting to Paystack. The
  // proration breakdown rides along so the FULFILMENT row can record it
  // verbatim (FR-20a) without recomputation.
  await writePaymentLog({
    userId: user.id,
    eventType: "INITIATION",
    providerReference,
    amount: amountKobo,
    currency: CURRENCY,
    planType: "YEARLY",
    interval: "YEARLY",
    transactionId: transaction.id,
    metadata: {
      changeType: "upgrade",
      previousInterval: "MONTHLY",
      newInterval: "YEARLY",
      creditApplied: quote.creditKobo,
      previousPeriodStart: quote.currentPeriodStart.toISOString(),
      previousPeriodEnd: quote.currentPeriodEnd.toISOString(),
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }

  try {
    // FR-4: hosted checkout handoff, same pattern as subscribe.
    const cancelUrl = `${appUrl}/checkout/return?reference=${providerReference}`;
    const initResponse = await initializeTransaction({
      email: user.email,
      amountInKobo: amountKobo,
      reference: providerReference,
      callbackUrl: `${appUrl}/checkout/return`,
      cancelUrl,
    });

    return NextResponse.redirect(initResponse.authorization_url, 303);
  } catch (error) {
    console.error("Paystack initialization failed for upgrade:", error);
    return NextResponse.json(
      { error: "Failed to initialize payment." },
      { status: 500 }
    );
  }
}
