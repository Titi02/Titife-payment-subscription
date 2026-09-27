"use client";

import { createPortal } from "react-dom";
import { formatKoboToNaira } from "@/lib/money";

interface PlanChangeModalProps {
  open: boolean;
  title: string;
  currentPlanLabel: string;
  /** Days remaining on the current paid period. Null when not applicable. */
  daysRemaining: number | null;
  newPlanLabel: string;
  /** Amount to charge today, in kobo (new-plan price minus credit). */
  amountKobo: number | null;
  /** Unused-time credit applied to this charge, in kobo. 0 when none. */
  creditKobo?: number;
  /** True while the live quote is being fetched from the server. */
  loading?: boolean;
  /** Non-null when the live quote could not be fetched. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}

/**
 * Confirmation popup for a paid plan change.
 *
 * For the prorated upgrade (Monthly -> Yearly, FR-18) it shows the exact
 * calculation — days remaining, the credit from unused Monthly time, and the
 * resulting charge — so the number confirmed here is the number charged
 * (PRD 5.11); while the live quote loads it shows a loading state and disables
 * confirm on error (never a stale number, never a blank panel).
 */
export function PlanChangeModal({
  open,
  title,
  currentPlanLabel,
  daysRemaining,
  newPlanLabel,
  amountKobo,
  creditKobo = 0,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
  confirming = false,
}: PlanChangeModalProps) {
  if (!open) {
    return null;
  }

  const canConfirm = !loading && !error && amountKobo !== null && !confirming;

  // Portal to <body> so no transformed ancestor (e.g. .plan-card hover or
  // .btn:active transforms) can become the containing block for this fixed
  // overlay and drag the modal around the viewport while it's open.
  return createPortal(
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-change-modal-title"
    >
      <div className="modal">
        <h2 id="plan-change-modal-title" className="modal__title">
          {title}
        </h2>

        {loading ? (
          <p className="modal__note">Calculating your prorated total…</p>
        ) : error ? (
          <p className="modal__note modal__note--error">{error}</p>
        ) : (
          <dl className="modal__summary">
            <div className="modal__row">
              <dt>Current plan</dt>
              <dd>{currentPlanLabel}</dd>
            </div>
            {daysRemaining !== null && (
              <div className="modal__row">
                <dt>Remaining access</dt>
                <dd>
                  {daysRemaining} {daysRemaining === 1 ? "day" : "days"} remaining
                </dd>
              </div>
            )}
            <div className="modal__row">
              <dt>New plan</dt>
              <dd>{newPlanLabel}</dd>
            </div>
            {creditKobo > 0 && (
              <div className="modal__row">
                <dt>Unused {currentPlanLabel} credit</dt>
                <dd>-{formatKoboToNaira(creditKobo)}</dd>
              </div>
            )}
            <div className="modal__row modal__row--amount">
              <dt>Amount to charge today</dt>
              <dd>{amountKobo === null ? "—" : formatKoboToNaira(amountKobo)}</dd>
            </div>
          </dl>
        )}

        {!loading && !error && (
          <p className="modal__note">
            {`Your unused ${currentPlanLabel} time is credited against the ${newPlanLabel} price, so you are charged only the difference. Your ${newPlanLabel} plan starts today.`}
          </p>
        )}

        <div className="modal__actions">
          <button
            className="btn btn--primary"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {confirming ? "Processing..." : "Confirm & Pay"}
          </button>
          <button
            className="btn btn--outline"
            onClick={onCancel}
            disabled={confirming}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
