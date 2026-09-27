/**
 * Paystack Verify Transaction — FR-8
 * Server-to-server verification of a completed transaction.
 *
 * FR-8 is "the single most important rule in the system":
 * entitlement is NEVER granted on redirect alone. This function
 * is the only path to confirming a payment actually succeeded.
 */

import { paystackRequest } from "./client";

interface VerifyTransactionAuthorization {
  authorization_code: string;
  bin: string;
  last4: string;
  exp_month: string;
  exp_year: string;
  channel: string;
  card_type: string;
  bank: string;
  country_code: string;
  brand: string;
  reusable: boolean;
}

interface VerifyTransactionCustomer {
  id: number;
  customer_code: string;
  email: string;
}

export interface VerifyTransactionData {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  channel: string;
  paid_at: string;
  authorization: VerifyTransactionAuthorization;
  customer: VerifyTransactionCustomer;
  metadata: Record<string, unknown> | null;
}

export async function verifyTransaction(
  reference: string
): Promise<VerifyTransactionData> {
  const response = await paystackRequest<VerifyTransactionData>({
    method: "GET",
    path: `/transaction/verify/${encodeURIComponent(reference)}`,
  });

  return response.data;
}
