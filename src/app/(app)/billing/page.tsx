import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import { formatKoboToNaira, MONTHLY_PRICE_KOBO, YEARLY_PRICE_KOBO } from "@/lib/money";
import { UpgradeButton } from "@/components/UpgradeButton";
import { DowngradeButton } from "@/components/DowngradeButton";
import { CancelSubscriptionCard } from "@/components/CancelSubscriptionCard";

/**
 * Billing View — FR-30, FR-24a, FR-17, FR-21, FR-25
 */

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  CANCELED: "Canceled",
};

function formatDate(date: Date | null): string {
  if (!date) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function humanize(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const entitlement = await getUserEntitlement(user.id);
  const { hasSubscription, planType, status, currentPeriodEnd } = entitlement;

  const isFree = !hasSubscription || planType === "FREE";
  const statusLabel = status ? (STATUS_LABELS[status] ?? humanize(status)) : "Free";
  // Cancelled = cancellation-at-period-end is scheduled (entitlement derives
  // CANCELED from cancelAtPeriodEnd while access is retained until the term end).
  const subscriptionLabel =
    status === "ACTIVE" ? "Active" : status === "CANCELED" ? "Cancelled" : "—";

  // A cancelled subscription keeps its paid term but will not renew (FR-27 /
  // FR-28); the user can still upgrade it back onto a paid plan (FR-17).
  const isCancelled = hasSubscription && status === "CANCELED";
  const hasPendingChange = entitlement.pendingPlanType !== null;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Billing</h1>
        <p className="page-subtitle">Manage your subscription, plan, and payment details.</p>
      </header>

      <div className="billing-layout">
        <section className="billing-section">
          <header className="billing-section__header">
            <h2 className="billing-section__title">Current Plan</h2>
            <span className={`status-badge status-badge--${(status ?? "free").toLowerCase()}`}>
              {statusLabel}
            </span>
          </header>

          <div className="billing-plan">
            <dl className="billing-plan__details">
              <div className="billing-stat">
                <dt className="billing-stat__label">Current Plan</dt>
                <dd className="billing-stat__value">{humanize(planType)}</dd>
              </div>
              <div className="billing-stat">
                <dt className="billing-stat__label">Subscription</dt>
                <dd className="billing-stat__value">{subscriptionLabel}</dd>
              </div>
              <div className="billing-stat">
                <dt className="billing-stat__label">Access Ends</dt>
                <dd className="billing-stat__value">{formatDate(currentPeriodEnd)}</dd>
              </div>
            </dl>
          </div>

          {entitlement.pendingPlanType && (
            <div className="billing-banner billing-banner--info">
              <strong>Pending change:</strong>
              <span>
                {entitlement.pendingPlanType === "FREE"
                  ? "Free is scheduled for the end of the current billing cycle and your plan will revert to Free when it ends."
                  : `Your ${humanize(entitlement.pendingPlanType)} plan is scheduled to take effect when your current period ends on ${formatDate(entitlement.currentPeriodEnd)}. You keep your paid access until then; no payment is taken now.`}
              </span>
            </div>
          )}

          {status === "CANCELED" && entitlement.currentPeriodEnd && (
            <div className="billing-banner billing-banner--warning">
              <strong>Subscription cancelled.</strong>
              <span>
                Your access stays active until <strong>{formatDate(currentPeriodEnd)}</strong>,
                then your plan reverts to Free.
              </span>
            </div>
          )}
        </section>

        <section className="billing-section">
          <header className="billing-section__header">
            <h2 className="billing-section__title">Switch Plan</h2>
          </header>

          <div className="pricing-switch-grid">
            <div className={`plan-card ${planType === "MONTHLY" ? "plan-card--current" : ""}`}>
              {planType === "MONTHLY" && <div className="plan-card__badge">Current Plan</div>}
              <h2 className="plan-card__name">Monthly</h2>
              <div className="plan-card__price">
                <span className="plan-card__amount">{formatKoboToNaira(MONTHLY_PRICE_KOBO)}</span>
                <span className="plan-card__interval">/ month</span>
              </div>
              <p className="plan-card__description">Full access, billed monthly.</p>

              {planType === "MONTHLY" && isCancelled ? (
                <UpgradeButton label="Upgrade Plan" />
              ) : planType === "MONTHLY" ? (
                <button className="btn btn--current btn--full-width" disabled>
                  Current Plan
                </button>
              ) : planType === "FREE" ? (
                <form action="/api/checkout/initiate" method="POST">
                  <input type="hidden" name="interval" value="MONTHLY" />
                  <button type="submit" className="btn btn--primary btn--full-width">
                    Subscribe Monthly
                  </button>
                </form>
              ) : planType === "YEARLY" ? (
                entitlement.pendingPlanType === "MONTHLY" ? (
                  <button className="btn btn--disabled btn--full-width" disabled>
                    Downgrade Pending
                  </button>
                ) : (
                  <DowngradeButton
                    targetPlan="MONTHLY"
                    label="Downgrade to Monthly"
                    className="btn btn--outline"
                  />
                )
              ) : null}
            </div>

            <div className={`plan-card ${planType === "YEARLY" ? "plan-card--current" : ""}`}>
              {planType === "YEARLY" && <div className="plan-card__badge">Current Plan</div>}
              <h2 className="plan-card__name">Yearly</h2>
              <div className="plan-card__price">
                <span className="plan-card__amount">{formatKoboToNaira(YEARLY_PRICE_KOBO)}</span>
                <span className="plan-card__interval">/ year</span>
              </div>
              <p className="plan-card__description">
                Full access, billed yearly. <span className="plan-card__savings">Save 2 months</span>
              </p>

              {planType === "YEARLY" ? (
                <button className="btn btn--current btn--full-width" disabled>
                  Current Plan
                </button>
              ) : planType === "FREE" ? (
                <form action="/api/checkout/initiate" method="POST">
                  <input type="hidden" name="interval" value="YEARLY" />
                  <button type="submit" className="btn btn--primary btn--full-width">
                    Subscribe Yearly
                  </button>
                </form>
              ) : planType === "MONTHLY" &&
                (status === "ACTIVE" || isCancelled) &&
                !hasPendingChange ? (
                <UpgradeButton
                  label={isCancelled ? "Upgrade Plan" : "Upgrade to Yearly"}
                />
              ) : null}
            </div>
          </div>
        </section>

        {!isFree && (
          <section className="billing-section">
            <header className="billing-section__header">
              <h2 className="billing-section__title">Cancel Subscription</h2>
            </header>
            <CancelSubscriptionCard
              isActive={status === "ACTIVE"}
              periodEndDate={formatDate(currentPeriodEnd)}
            />
          </section>
        )}

        </div>
    </>
  );
}