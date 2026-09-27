import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { checkCheckoutRateLimit } from "@/server/rate-limit/checkout-limiter";
import { initializeTransaction } from "@/server/paystack/initialize-transaction";
import { writePaymentLog } from "@/server/payments/log";
import { upsertTransaction } from "@/server/payments/transaction";
import { MONTHLY_PRICE_KOBO, YEARLY_PRICE_KOBO, CURRENCY } from "@/lib/money";
import { randomUUID } from "crypto";

/**
 * Checkout Initiation — FR-4, FR-5, FR-6
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // FR-5: Rate limiting via database-backed RateLimitBucket
  const rateLimit = await checkCheckoutRateLimit(user.id);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  // Parse form data from the plans page
  let interval: string | null = null;
  
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    interval = formData.get("interval") as string;
  } else {
    try {
      const json = await req.json();
      interval = json.interval;
    } catch (e) {
      // Ignored
    }
  }

  if (interval !== "MONTHLY" && interval !== "YEARLY") {
    return NextResponse.json({ error: "Invalid interval" }, { status: 400 });
  }

  const amountKobo = interval === "MONTHLY" ? MONTHLY_PRICE_KOBO : YEARLY_PRICE_KOBO;
  
  // FR-14 / FR-6: Generate a unique provider reference for this transaction attempt
  const providerReference = `sub_${randomUUID()}`;

  const transaction = await upsertTransaction({
    userId: user.id,
    providerReference,
    amount: amountKobo,
    currency: CURRENCY,
    planType: interval === "MONTHLY" ? "MONTHLY" : "YEARLY",
    interval: interval === "MONTHLY" ? "MONTHLY" : "YEARLY",
    status: "INITIATED",
  });

  // FR-6: Write the INITIATION PaymentLog row BEFORE redirecting to Paystack
  await writePaymentLog({
    userId: user.id,
    eventType: "INITIATION",
    providerReference,
    amount: amountKobo,
    currency: CURRENCY,
    planType: interval === "MONTHLY" ? "MONTHLY" : "YEARLY",
    interval: interval === "MONTHLY" ? "MONTHLY" : "YEARLY",
    transactionId: transaction.id,
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }

  try {
    // FR-4: Call Paystack Initialize Transaction (server-side, never exposing keys to client)
    //
    // FR-7: send declines/cancels home too. The reference is known here, so it is
    // embedded in cancel_action — Paystack redirects to cancel_action when the customer
    // cancels a declined/abandoned checkout (success uses callback_url instead), and the
    // reference must be present for the return view to verify + record the FAILURE.
    const cancelUrl = `${appUrl}/checkout/return?reference=${providerReference}`;
    const initResponse = await initializeTransaction({
      email: user.email,
      amountInKobo: amountKobo,
      reference: providerReference,
      callbackUrl: `${appUrl}/checkout/return`,
      cancelUrl,
    });

    // Redirect to Paystack hosted checkout
    return NextResponse.redirect(initResponse.authorization_url, 303);
  } catch (error) {
    console.error("Paystack initialization failed:", error);
    // Note: We don't write a FAILURE event for initialize failures since
    // the user never even reached checkout, but doing so would be valid too.
    return NextResponse.json(
      { error: "Failed to initialize payment." },
      { status: 500 }
    );
  }
}
