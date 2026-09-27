/**
 * Paystack Refund API — Phase 5 (Excellent Band)
 * Used solely for auto-refunding detected duplicate charges
 * while the user is already ACTIVE on the same plan.
 *
 * PRD Section 14: "reject and auto-refund the second charge via
 * Paystack's Refund API"
 */

import { paystackRequest } from "./client";

interface RefundData {
  transaction: number;
  status: string;
  amount: number;
  currency: string;
}

/**
 * Initiate a full refund on a Paystack transaction.
 * @param paystackTransactionId - Paystack's numeric transaction ID (data.id from webhook)
 */
export async function refundTransaction(paystackTransactionId: string): Promise<RefundData> {
  const response = await paystackRequest<RefundData>({
    method: "POST",
    path: "/refund",
    body: { transaction: paystackTransactionId },
  });

  return response.data;
}
