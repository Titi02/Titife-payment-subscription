/**
 * Paystack API client — thin fetch wrapper.
 * Test-mode keys only, sourced from env vars, never hardcoded.
 * (AGENTS.md Section 2: locked payment provider)
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error("PAYSTACK_SECRET_KEY is not set in environment variables");
  }
  return key;
}

interface PaystackRequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export async function paystackRequest<T>(
  options: PaystackRequestOptions
): Promise<PaystackResponse<T>> {
  const { method, path, body } = options;

  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Paystack API error (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as PaystackResponse<T>;
  return data;
}
