/**
 * Webhook signature verification — FR-12
 * HMAC-SHA512 of the raw request body against the Paystack secret key,
 * compared to the x-paystack-signature header.
 *
 * This MUST be called before any parsing of the webhook body for
 * business logic. (AGENTS.md Section 3, Rule 3)
 */

import { createHmac } from "crypto";

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not set in environment variables");
  }

  const hash = createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");

  return hash === signatureHeader;
}
