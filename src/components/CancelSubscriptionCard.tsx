"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CancellationReason } from "@prisma/client";
import { saveCancellationFeedback } from "@/server/subscriptions/feedback";

/**
 * CancelSubscriptionCard — FR-25, FR-26
 * Inline cancellation flow that lives entirely on the Billing page:
 *   idle   -> "Cancel Subscription" button
 *   confirm-> inline confirmation with "Keep plan" / "Yes, cancel" buttons,
 *             plus an optional reason (FR-26). Nothing is POSTed until
 *             "Yes, cancel" is clicked.
 *   success-> "Subscription cancelled", the access-until date, and an
 *             optional feedback input, all on the same page (no redirect).
 * After a successful cancellation the derived subscription status becomes
 * CANCELLING, so the card's success state is also driven by !isActive and
 * therefore survives a reload (the cancellation persists at period end).
 */

const REASON_OPTIONS: { value: CancellationReason; label: string }[] = [
  { value: "TOO_EXPENSIVE", label: "Too expensive" },
  { value: "MISSING_FEATURES", label: "Missing features" },
  { value: "SWITCHING_PROVIDER", label: "Switching to another provider" },
  { value: "TEMPORARY_PAUSE", label: "Taking a temporary pause" },
  { value: "OTHER", label: "Other" },
];

interface CancelSubscriptionCardProps {
  isActive: boolean;
  periodEndDate: string;
}

export function CancelSubscriptionCard({
  isActive,
  periodEndDate,
}: CancelSubscriptionCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [reason, setReason] = useState<CancellationReason | "">("");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // True right after a successful cancel, and also after a re-render or
  // reload once the derived status has flipped away from ACTIVE.
  const showCancelled = cancelled || !isActive;

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);

    try {
      const body: Record<string, string> = {};
      if (reason) {
        body.reason = reason;
      }
      if (reason === "OTHER" && note.trim()) {
        body.note = note.trim();
      }

      const res = await fetch("/api/subscriptions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to cancel subscription");
      }

      setCancelled(true);
      setConfirming(false);
      // Refresh the server data (Current Plan card) without navigating away.
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleFeedback = async () => {
    const text = feedback.trim();
    if (!text) {
      setFeedbackSent(true);
      return;
    }

    setFeedbackSaving(true);
    setError(null);
    try {
      const result = await saveCancellationFeedback(text);
      if (!result.ok) {
        throw new Error(result.error || "Could not save feedback");
      }
      setFeedbackSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not save feedback");
    } finally {
      setFeedbackSaving(false);
    }
  };

  if (!showCancelled) {
    return (
      <div>
        <p className="billing-cancel__text">
          Leaving? Your access stays active until{" "}
          <strong>{periodEndDate}</strong>, then your plan reverts to Free.
        </p>

        {!confirming ? (
          <button className="btn btn--danger" onClick={() => setConfirming(true)}>
            Cancel Subscription
          </button>
        ) : (
          <div
            className="billing-card"
            style={{ marginTop: "16px", border: "2px solid var(--color-error)" }}
          >
            <h3 style={{ margin: "0 0 8px 0" }}>Cancel your subscription?</h3>
            <p style={{ color: "var(--color-on-surface-variant, #666)", margin: "0 0 16px 0" }}>
              Your access stays active until <strong>{periodEndDate}</strong>, then your plan
              reverts to Free. Nothing is cancelled until you press{" "}
              <strong>&ldquo;Yes, cancel&rdquo;</strong>.
            </p>

            {/* FR-26: optional reason from fixed list */}
            <div style={{ marginBottom: "12px" }}>
              <label
                htmlFor="cancel-reason"
                style={{ display: "block", marginBottom: "6px", fontWeight: 500 }}
              >
                Reason for cancelling (optional)
              </label>
              <select
                id="cancel-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as CancellationReason | "")}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border, #ccc)",
                  fontSize: "14px",
                }}
              >
                <option value="">— Skip —</option>
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* FR-26: free-text only when OTHER is selected */}
            {reason === "OTHER" && (
              <div style={{ marginBottom: "12px" }}>
                <label
                  htmlFor="cancel-note"
                  style={{ display: "block", marginBottom: "6px", fontWeight: 500 }}
                >
                  Tell us more (optional)
                </label>
                <textarea
                  id="cancel-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "10px",
                    borderRadius: "8px",
                    border: "1px solid var(--color-border, #ccc)",
                    fontSize: "14px",
                    resize: "vertical",
                  }}
                />
              </div>
            )}

            {error && (
              <div style={{ color: "var(--color-error, #d32f2f)", marginBottom: "12px" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
              <button
                className="btn btn--outline"
                onClick={() => {
                  setConfirming(false);
                  setReason("");
                  setNote("");
                  setError(null);
                }}
                disabled={loading}
              >
                Keep plan
              </button>
              <button
                className="btn btn--danger"
                onClick={handleConfirm}
                disabled={loading}
              >
                {loading ? "Cancelling..." : "Yes, cancel"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="billing-banner billing-banner--warning">
        <h3 style={{ margin: 0 }}>Subscription cancelled</h3>
        <p style={{ margin: "6px 0 0 0" }}>
          Access until <strong>{periodEndDate}</strong>. Your plan reverts to Free after that.
        </p>
      </div>

      <div style={{ marginTop: "16px", maxWidth: "480px" }}>
        <label
          htmlFor="cancel-feedback"
          style={{ display: "block", marginBottom: "6px", fontWeight: 500 }}
        >
          Feedback (optional)
        </label>
        <textarea
          id="cancel-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={3}
          placeholder="What could we have done better?"
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: "8px",
            border: "1px solid var(--color-border, #ccc)",
            fontSize: "14px",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "12px", marginTop: "10px", alignItems: "center" }}>
          <button
            className="btn btn--outline"
            onClick={handleFeedback}
            disabled={feedbackSaving}
          >
            {feedbackSaving ? "Saving..." : "Send feedback"}
          </button>
          {feedbackSent && (
            <span style={{ color: "var(--color-success, #2e7d32)", fontSize: "0.85rem" }}>
              Thanks for your feedback.
            </span>
          )}
        </div>
        {error && (
          <div style={{ color: "var(--color-error, #d32f2f)", marginTop: "8px" }}>{error}</div>
        )}
      </div>
    </div>
  );
}