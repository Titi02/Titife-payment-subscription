import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getUserEntitlement } from "@/server/subscriptions/entitlement";
import { formatKoboToNaira, MONTHLY_PRICE_KOBO, YEARLY_PRICE_KOBO } from "@/lib/money";
import { UpgradeButton } from "@/components/UpgradeButton";
import { DowngradeButton } from "@/components/DowngradeButton";

export default async function PlansPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const entitlement = await getUserEntitlement(user.id);
  const currentPlan = entitlement.planType;

  // The only current-plan-affecting pending state: a Yearly user who has
  // already scheduled the Monthly downgrade. The Monthly control is disabled
  // until the pending change takes effect at the period boundary (FR-24a) so
  // it can't be requested twice.
  const hasPendingMonthly = entitlement.pendingPlanType === "MONTHLY";

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Choose your plan</h1>
        <p className="page-subtitle">Simple pricing, no hidden fees.</p>
      </header>

      <div className="plans-grid">
        {/* Free Plan */}
        <div className={`plan-card ${currentPlan === "FREE" ? "plan-card--current" : ""}`}>
          {currentPlan === "FREE" && <div className="plan-card__badge">Current</div>}
          <h2 className="plan-card__name">Free</h2>
          <div className="plan-card__price">
            <span className="plan-card__amount">₦0</span>
            <span className="plan-card__interval">/ month</span>
          </div>
          <p className="plan-card__description">Basic access to features.</p>

          {currentPlan === "FREE" ? (
            <button className="btn btn--current btn--full-width" disabled>
              Current Plan
            </button>
          ) : (
            <DowngradeButton
              targetPlan="FREE"
              label="Downgrade to Free"
              className="btn btn--primary btn--full-width"
            />
          )}
        </div>

        {/* Monthly Plan */}
        <div className={`plan-card ${currentPlan === "MONTHLY" ? "plan-card--current" : ""}`}>
          {currentPlan === "MONTHLY" && <div className="plan-card__badge">Current</div>}
          <h2 className="plan-card__name">Monthly</h2>
          <div className="plan-card__price">
            <span className="plan-card__amount">{formatKoboToNaira(MONTHLY_PRICE_KOBO)}</span>
            <span className="plan-card__interval">/ month</span>
          </div>
          <p className="plan-card__description">Full access, billed monthly.</p>

          {currentPlan === "MONTHLY" ? (
            <button className="btn btn--current btn--full-width" disabled>
              Current Plan
            </button>
          ) : currentPlan === "YEARLY" ? (
            hasPendingMonthly ? (
              <button className="btn btn--disabled btn--full-width" disabled>
                Downgrade Pending
              </button>
            ) : (
              <DowngradeButton
                targetPlan="MONTHLY"
                label="Downgrade to Monthly"
                className="btn btn--primary btn--full-width"
              />
            )
          ) : (
            <form action="/api/checkout/initiate" method="POST">
              <input type="hidden" name="interval" value="MONTHLY" />
              <button type="submit" className="btn btn--primary btn--full-width">
                Subscribe Monthly
              </button>
            </form>
          )}
        </div>

        {/* Yearly Plan */}
        <div className={`plan-card ${currentPlan === "YEARLY" ? "plan-card--current" : ""}`}>
          {currentPlan === "YEARLY" && <div className="plan-card__badge">Current</div>}
          <h2 className="plan-card__name">Yearly</h2>
          <div className="plan-card__price">
            <span className="plan-card__amount">{formatKoboToNaira(YEARLY_PRICE_KOBO)}</span>
            <span className="plan-card__interval">/ year</span>
          </div>
          <p className="plan-card__description">
            Full access, billed yearly. <span className="plan-card__savings">Save 2 months</span>
          </p>

          {currentPlan === "YEARLY" ? (
            <button className="btn btn--current btn--full-width" disabled>
              Current Plan
            </button>
          ) : currentPlan === "MONTHLY" ? (
            <UpgradeButton label="Upgrade to Yearly" />
          ) : (
            <form action="/api/checkout/initiate" method="POST">
              <input type="hidden" name="interval" value="YEARLY" />
              <button type="submit" className="btn btn--primary btn--full-width">
                Subscribe Yearly
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
