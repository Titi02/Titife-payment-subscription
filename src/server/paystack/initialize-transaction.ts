/**
 * Paystack Initialize Transaction — FR-4
 * Creates a new transaction and returns the authorization URL
 * for redirect to Paystack's hosted checkout.
 *
 * This is the ONLY way a first-time subscription charge is initiated.
 * (AGENTS.md Section 2: never use Paystack's Subscriptions/Plans endpoints)
 */

import { paystackRequest } from "./client";

interface InitializeTransactionParams {
  email: string;
  /** Amount in kobo (NGN minor unit). Always an integer. (AGENTS.md Section 2) */
  amountInKobo: number;
  reference: string;
  callbackUrl: string;
  /** URL Paystack sends the customer to when they cancel/abandon checkout (FR-7). */
  cancelUrl: string;
  metadata?: Record<string, unknown>;
}

interface InitializeTransactionData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializeTransaction(
  params: InitializeTransactionParams
): Promise<InitializeTransactionData> {
  const response = await paystackRequest<InitializeTransactionData>({
    method: "POST",
    path: "/transaction/initialize",
    body: {
      email: params.email,
      amount: params.amountInKobo,
      reference: params.reference,
      callback_url: params.callbackUrl,
      currency: "NGN",
      metadata: {
        ...(params.metadata ?? {}),
        // FR-7: Paystack only auto-redirects back to callback_url on success.
        // Declined/failed/cancelled checkouts stall on Paystack's page unless
        // cancel_action is set — point it at our return view so failure
        // outcomes also come back to Titife.
        cancel_action: params.cancelUrl,
      },
    },
  });

  return response.data;
}
