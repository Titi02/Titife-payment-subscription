"use client";

import { useEffect, useRef, useState } from "react";
import { PlanChangeModal } from "@/components/PlanChangeModal";

interface UpgradeQuoteResponse {
  daysRemaining: number;
  creditKobo: number;
  amountKobo: number;
}

interface UpgradeButtonProps {
  /** Button label. Defaults to "Upgrade to Yearly". */
  label?: string;
}

/**
 * Upgrade (Monthly -> Yearly) control — FR-17, FR-18.
 *
 * Opens a confirmation popup and fetches the live prorated breakdown from the
 * server when it opens, so the days/credit/amount shown are computed at the
 * moment of confirmation rather than baked in at page render time. Confirm &
 * Pay POSTs to /api/subscriptions/upgrade (which recomputes through the same
 * server helper) and the browser follows the 303 to Paystack's hosted
 * checkout; the Yearly term is granted server-side after verification.
 */
export function UpgradeButton({ label = "Upgrade to Yearly" }: UpgradeButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null);
  const [amountKobo, setAmountKobo] = useState<number | null>(null);
  const [creditKobo, setCreditKobo] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const confirmFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch("/api/subscriptions/upgrade/preview")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`preview ${res.status}`);
        }
        return res.json() as Promise<UpgradeQuoteResponse>;
      })
      .then((quote) => {
        if (cancelled) {
          return;
        }
        setDaysRemaining(quote.daysRemaining);
        setAmountKobo(quote.amountKobo);
        setCreditKobo(quote.creditKobo);
      })
      .catch(() => {
        if (!cancelled) {
          setError("We couldn't calculate your upgrade price. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleConfirm = () => {
    setConfirming(true);
    confirmFormRef.current?.requestSubmit();
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      <PlanChangeModal
        open={open}
        title="Confirm Upgrade"
        currentPlanLabel="Monthly"
        daysRemaining={daysRemaining}
        newPlanLabel="Yearly"
        amountKobo={amountKobo}
        creditKobo={creditKobo}
        loading={loading}
        error={error}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
        confirming={confirming}
      />

      <form ref={confirmFormRef} action="/api/subscriptions/upgrade" method="POST">
        <input type="hidden" name="planType" value="YEARLY" />
        <input type="hidden" name="interval" value="YEARLY" />
      </form>
    </>
  );
}
