"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

interface DowngradeButtonProps {
  targetPlan: "MONTHLY" | "FREE";
  label: string;
  className?: string;
}

/**
 * Downgrade control — FR-21, FR-22, FR-23a, FR-24, FR-25.
 *
 * Both downgrades are no-charge pending changes: nothing is charged now, the
 * current paid plan and its access stay live until the period ends, and the
 * change takes effect at that boundary (applied by the expiry sweep). A
 * Yearly -> Monthly downgrade is therefore scheduled, not bought — because this
 * system never auto-charges, the user must start a Monthly payment themselves
 * once the boundary passes.
 *
 * Requires an explicit confirmation step (FR-25), shown as a styled in-page
 * dialog rather than a native browser confirm(). The server call only records
 * intent and grants nothing (FR-8).
 */
export function DowngradeButton({
  targetPlan,
  label,
  className,
}: DowngradeButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const targetLabel = targetPlan === "MONTHLY" ? "Monthly" : "Free";
  const detail =
    targetPlan === "MONTHLY"
      ? "You keep your Yearly access until the current billing cycle ends. At that point your plan changes to Monthly, and you will need to start a Monthly payment to keep access."
      : "You keep access until the current billing cycle ends. Your plan then reverts to Free.";

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/subscriptions/downgrade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ planType: targetPlan }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to downgrade");
      }

      setOpen(false);
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        className={className ?? "btn btn--outline"}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={loading}
      >
        {loading ? "Processing..." : label}
      </button>

      {error && (
        <div
          style={{
            color: "var(--color-error)",
            marginTop: "4px",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {open &&
        createPortal(
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="downgrade-modal-title"
          >
            <div className="modal">
              <h2 id="downgrade-modal-title" className="modal__title">
                {`Downgrade to ${targetLabel}?`}
              </h2>
              <p className="modal__note">{detail}</p>
              <div className="modal__actions">
                <button
                  className="btn btn--primary"
                  onClick={handleConfirm}
                  disabled={loading}
                >
                  {loading ? "Processing..." : "Confirm downgrade"}
                </button>
                <button
                  className="btn btn--outline"
                  onClick={() => setOpen(false)}
                  disabled={loading}
                >
                  Keep current plan
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
