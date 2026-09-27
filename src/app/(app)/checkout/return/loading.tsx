/**
 * Return View loading boundary — "Verifying payment" state (FR-7, FR-8).
 *
 * The return page below verifies the transaction server-side against Paystack
 * before rendering any result, so this boundary shows while that verification
 * is in flight. Distinct from the result states (success / failed / declined /
 * could not be verified) rendered by page.tsx.
 */
export default function CheckoutReturnLoading() {
  return (
    <div className="return-container">
      <div className="return-icon return-icon--loading">✓</div>
      <h1 className="return-title">Verifying payment</h1>
      <p className="return-message">
        We&apos;re checking your payment status with Paystack. This usually takes a
        moment. Please don&apos;t close this page.
      </p>
    </div>
  );
}