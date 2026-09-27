**PRD: The Payment and Subscription Slice**

*Revision 3 — Paystack / NGN, with all Round 1 and Round 2 review fixes applied*

# 1\. Product Summary

The Payment and Subscription Slice is a self-contained subscription billing system, built against Paystack in test mode, that lets a signed-in user hold one of three plan states: Free, Monthly, or Yearly. The product has no marketing surface. It has no pricing page, no landing page, and no feature gating beyond a single planType enum value (Free, Monthly, Yearly) on the user's account. The entire surface area is: view your plan, subscribe, upgrade, downgrade, cancel, and see your current plan and status reflected correctly at every step.

What is being built is the plumbing, not the storefront: a checkout handoff to Paystack, server-side payment verification, webhook processing with signature checks and idempotency, mid-cycle proration math, and end-of-period cancellation. The payment log is the system of record. The subscription table is a projection of it, not a substitute for it.

All amounts are in Nigerian Naira (NGN), stored as whole numbers in kobo (NGN's minor unit; 1 naira \= 100 kobo).

# 2\. Problem Statement

Most subscription demo projects fake the hard part. They grant access the moment a user lands on a /success URL, they store money as floats, they process the same webhook twice and double-charge or double-grant, and they cut off access the instant a user clicks cancel even though that user already paid for the rest of the period. Each of these is a real production incident waiting to happen, and each is trivial to avoid if the payment lifecycle is treated as three distinct, auditable stages instead of one client-side redirect.

This project exists to prove that subscription billing can be built correctly: entitlement is never granted on a frontend claim, every event that touches money is logged as its own row before anything else happens, duplicate webhook deliveries are absorbed safely, and a cancellation that already has 12 days of paid access left honors those 12 days. The problem is not “how do we take payments.” The problem is “how do we take payments in a way that survives an audit, a chargeback, a retried webhook, and a user closing the tab mid-checkout.”

# 3\. Goals and Non-Goals

## Goals

* Support exactly one paid plan, sold on two intervals (monthly, yearly), plus a Free tier.

* Grant entitlement only after server-side verification of a completed payment, never on redirect alone.

* Record every payment-related event (initiation, verification, fulfilment, failure) as its own immutable row in a payment log.

* Support mid-cycle upgrade with a correctly calculated, correctly charged, correctly displayed proration.

* Support downgrade that takes effect at the end of the current billing period, not immediately.

* Support cancellation that retains access through the end of the paid period, with a confirmation step and an optional reason capture.

* Handle webhook signature verification and idempotency so a redelivered webhook is recorded once and acted on once.

* Rate-limit the checkout initiation endpoint using a store that works correctly regardless of deployment topology.

* Never store card details anywhere in the system.

* Never leave a user on a blank page or a 404 anywhere in the payment path, including failure and edge-case states.

## Non-Goals

* No marketing or pricing page. Plan selection happens inside the signed-in shell only.

* No product features gated behind the paywall. The planType field is the entire product being sold.

* No team, organization, or seat-based billing. One user, one subscription.

* No multi-currency support. NGN only.

* No user-initiated refund processing or refund UI. **(An automatic refund solely to correct a detected duplicate charge is in scope only if pursuing the Excellent grading band — see Section 14 and Section 13, Phase 5\. For a Pass-level build, duplicate-charge handling is an accepted known limitation, not a refund feature.)**

* No email or notification system (renewal reminders, receipts, dunning emails).

* No support for more than one paid plan tier (i.e., no “Pro” vs “Business” tiers). One paid plan, two intervals.

*Fix applied: the Non-Goals carve-out previously stated the auto-refund was unconditionally in scope, while Section 14 stated it applied only to the Excellent grading band. The two are now worded identically so they cannot drift apart again.*

# 4\. User Personas

### Primary persona: The Solo Subscriber

A single individual with an account who wants to move between Free, Monthly, and Yearly access. They upgrade when they want annual savings, downgrade when they want to spend less next cycle, and cancel when they're done. They expect that cancelling doesn't instantly cut them off from something they already paid for, and they expect that if something goes wrong mid-checkout, they land somewhere sensible instead of a broken page.

### Secondary persona: The Auditor / Reviewer

Not a product user in the traditional sense, but a first-class consumer of this system: an engineer, grader, or support agent who needs to reconstruct exactly what happened to a given subscription from the payment log alone, without trusting the current value of the subscription's status column. For this project, evidence is gathered via direct, read-only SQL queries against the payment log, used specifically to produce the screenshots required in the assessment. In a production system this would be replaced by a dedicated read-only audit tool; that tool is out of scope here.

*ASSUMPTION: no admin UI is built for this phase; the Auditor is served by direct, read-only SQL access, not a designed production workflow.*

*Fix applied: the explicit ASSUMPTION label on this point was dropped in the prior revision, breaking this document's own labeling convention. Re-added.*

# 5\. Functional Requirements

Each requirement below is written as a specific, testable statement. Concept explanations required by the brief are embedded inline where the requirement depends on the concept.

## 5.1 Payment architecture decision (resolved)

Paystack's product model differs from Stripe in a way that matters here: Paystack's native Subscriptions/Plans object supports fixed recurring billing on a single plan, but it does not offer built-in mid-cycle proration or an equivalent to Stripe's proration\_behavior control on plan changes. Relying on it for upgrade/downgrade would mean fighting the API's assumptions instead of using them.

**Architecture chosen: self-managed periods.** This system does not use Paystack's native Subscription/Plan object at all. Every charge — the first subscription, an upgrade, or a renewal — is a discrete transaction against the Paystack Transactions API:

* The first charge for a new subscription uses Initialize Transaction (redirect to Paystack's hosted checkout), which, on success, returns a reusable authorization (an authorization\_code tied to the customer's card) when the card supports it.

* Every later charge — an upgrade's prorated amount, or a renewal at the next period boundary — uses Charge Authorization (POST /transaction/charge\_authorization) against the stored authorization\_code, with no user interaction and no redirect required.

* This system, not Paystack, owns currentPeriodStart and currentPeriodEnd, and a scheduled renewal job (not a Paystack webhook) is what triggers the next Charge Authorization call at the period boundary.

This resolves the double-proration risk that exists in Stripe-based designs: there is no second, Paystack-side proration engine running in the background, because Paystack's transaction and charge-authorization endpoints only ever charge the exact amount this system tells them to charge. There is exactly one number, calculated once, charged once.

*Fix applied: this section did not exist two revisions ago. The earlier draft implied two incompatible architectures (a Stripe-managed recurring Subscription object in one FR, and manual one-off invoicing in another) without resolving which was true. This is now stated as a single, explicit, load-bearing decision that the rest of Section 5 is written against.*

FR-0a (fallback): If Paystack does not return a reusable authorization\_code on the initial charge, or a later Charge Authorization attempt is declined specifically for lacking a valid authorization (as opposed to a normal insufficient-funds-style decline), the subscription cannot auto-renew by design. In that case, on the renewal attempt where this is discovered, the system sets status \= PAST\_DUE (the same state used for any other renewal failure, per FR-31) and the billing view surfaces an explicit “reauthorize payment” action. That action re-runs Initialize Transaction and captures a fresh authorization\_code. This is a manual, user-initiated re-entry into the checkout flow, not an email- or SMS-driven flow, so it does not violate the no-notifications Non-Goal in Section 3\.

*Fix applied: the architecture in this section assumed a stored authorization\_code always exists for every later charge, with no stated fallback for when Paystack doesn't return one or a bank blocks off-session use of one. This is not a rare edge case for card-based recurring billing, so it is now a first-class requirement rather than an unstated assumption.*

## 5.2 Plans view

* FR-1: The plans view displays exactly three plan cards: Free, Monthly (₦12,000/mo), Yearly (₦120,000/yr).

* FR-2: The user's current plan is visually indicated on this view, sourced from the subscription record's planType and status, not from client-side state.

* FR-3: If the user has no subscription record, they are treated as Free by default; no row is required to represent “Free.”

## 5.3 Checkout initiation

* FR-4: Clicking “Subscribe” on Monthly or Yearly calls a server route that creates a Paystack transaction via Initialize Transaction (test mode) and redirects the user to the authorization\_url Paystack returns. No payment form is rendered inside this application, and no card data ever touches this application's servers.

* FR-5: The checkout initiation endpoint is rate-limited to 10 requests per minute per authenticated user, enforced by a database-backed counter (a RateLimitBucket row keyed on userId and time window), not an in-memory counter. This exists because checkout initiation calls an external paid API and is a natural target for abuse or accidental retry loops from a broken frontend, and a database-backed counter continues to work correctly regardless of whether this app runs as one long-lived process or as multiple stateless serverless instances.

*ASSUMPTION: 10 requests/minute is an illustrative placeholder, not derived from traffic analysis. Adjust once real usage patterns are known.*

*Fix applied: the prior revision left the rate limiter's backing store as in-memory with no statement of deployment target, which silently fails to rate-limit anything under a serverless deployment (each invocation gets a fresh, empty counter). It is now database-backed so the requirement holds regardless of deployment topology.*

* FR-6: A PaymentEvent row of type INITIATION is written before the redirect to Paystack occurs, capturing the intended plan, interval, and amount (in kobo) against a providerReference generated by this system. This is the first entry in what becomes, for a successful transaction, a three-or-more-row audit trail.

## 5.4 Return view (post-checkout)

* FR-7: The user lands on a return view after Paystack checkout, regardless of outcome (success, cancel, or error). Paystack redirects to this view with the transaction reference in the query string.

FR-8: **The return view never grants entitlement by itself.** This is the single most important rule in the system. Landing on /checkout/return?reference=xyz proves nothing except that a browser navigated to that URL; a reference can be copied, replayed, or guessed at low cost by an attacker who has seen one. The return view's only job is to call a server-side verification endpoint that independently calls Paystack's Verify Transaction API (GET /transaction/verify/:reference) using the secret key, confirming that this specific reference actually completed with status “success” and that the amount and currency match what this system expected to charge. Only if that server-to-server check succeeds does the system proceed toward fulfilment. This is the trap named explicitly in the brief, and this requirement exists specifically to close it.

* FR-9: While verification is in flight, the return view shows a loading state, not a blank page.

* FR-10: If verification fails or times out, the return view shows a clear “we couldn't confirm this payment yet” state with a manual refresh/retry action, and never a 404 or unstyled error.

## 5.5 Webhook handling

* FR-11: A dedicated webhook endpoint receives Paystack events, principally charge.success (confirming a successful Initialize Transaction or Charge Authorization call), a charge-failure event (used to corroborate a failed Charge Authorization for the purposes of FR-31's renewal-failure handling), and refund.processed (confirming the safety-net auto-refund described in Section 14). Exact event names are confirmed against Paystack's current webhook documentation at build time; this PRD names the events by their documented purpose, not as a guarantee of exact string spelling.

*Fix applied: Section 5.10 relies on a charge-failure webhook to corroborate renewal failures, but the previous revision's FR-11 event list did not include one. Added here so the two sections describe the same webhook endpoint consistently.*

* FR-12: Every incoming webhook request's signature is verified before any parsing of the payload body for business logic. Verification is: compute an HMAC-SHA512 digest of the raw request body using the Paystack secret key, and compare it to the x-paystack-signature header. A request with a missing or mismatched signature is rejected with a 400 and is not written to the payment log as a legitimate event.

* FR-13: Fulfilment (granting or updating entitlement) happens only from a verified webhook event or from the server-side verification call in FR-8, never from the frontend.

FR-14: **Idempotency**: every Paystack transaction this system initiates is assigned a providerReference generated by this system itself. Paystack's webhook payload additionally carries its own numeric transaction id (data.id), which this system stores as paystackTransactionId. Neither column is unique on its own, because the same transaction legitimately produces multiple PaymentEvent rows over its lifecycle (INITIATION, then VERIFICATION, then FULFILMENT, per FR-16) and all of those rows share the same providerReference and paystackTransactionId. Idempotency is instead enforced by two composite unique constraints: (providerReference, eventType) and (paystackTransactionId, eventType). Together they guarantee that the same transaction cannot produce two rows for the same lifecycle stage, which is exactly the case a redelivered webhook or a retried verification call would otherwise create. Before acting on any webhook or verification result, the system checks whether that (reference, stage) pair already has a recorded outcome; if it does, the delivery is written to the payment log as a duplicate/ignored row (for auditability) but produces no second entitlement change and no second fulfilment.

*Fix applied: the prior revision made providerReference and paystackTransactionId standalone unique columns, which directly contradicted FR-16's requirement that a single transaction produces three separate log rows — the second row Prisma tried to write would have failed with a unique-constraint violation. Both columns are now plain (non-unique) fields, with the composite constraints doing the actual idempotency work.*

*Fix applied: the previous FR-12 mentioned logging invalid-signature requests as a “security event” with no corresponding table. That sentence has been removed; invalid-signature requests are simply rejected and not persisted as payment-lifecycle events.*

## 5.6 Subscribe (new subscription)

* FR-15: A user with no active subscription (or a Free/no-row state) can select Monthly or Yearly, complete Paystack checkout, and upon server-verified payment, a Subscription row is created with planType, interval, status \= ACTIVE, currentPeriodStart, and currentPeriodEnd (one month or one year out, per interval), and the returned authorization\_code is stored for future renewal charges.

* FR-15a: On resubscription after a full cancellation (a user who reached status \= CANCELED and later subscribes again), cancelledAt, cancellationReason, cancellationNote, pendingPlanType, and pendingInterval are all reset to null as part of creating the new active period. Because Subscription.userId is unique, the same row is reused, and none of its prior cancellation history is allowed to persist into the new active period.

*Fix applied: the prior revision reused the same Subscription row for a user across cancel/resubscribe cycles but never stated what happens to the leftover cancellation fields, which would otherwise show a stale cancelledAt date on a currently-active subscriber.*

* FR-16: A PaymentEvent row of type VERIFICATION and then FULFILMENT is written, in that order, with timestamps, completing the initiation → verification → fulfilment chain. These three stages are kept as three separate rows, not one row with three timestamp columns, because a corrupted or partially failed request should be diagnosable stage-by-stage: a row that stops at VERIFICATION with no FULFILMENT row tells you precisely where the failure occurred, which a single mutable row cannot.

* FR-16a: A VERIFICATION row with no corresponding FULFILMENT row after 15 minutes is treated as a stuck transaction. For this project's scope this is surfaced by a manual reconciliation query against the payment log (supported by the index added in Section 9); in a production system this would be an automated job that retries fulfilment or alerts a human, rather than leaving a paid, unfulfilled transaction silently unresolved.

*Fix applied: this requirement did not exist previously. Without it, a Paystack-confirmed payment that failed only at the local database-write step would leave a user charged with no subscription, and nothing in the design would ever surface that state.*

## 5.7 Upgrade (Monthly → Yearly, mid-cycle)

* FR-17: A user on an active Monthly plan can select “Upgrade to Yearly” from the billing view.

* FR-18: The system calculates a prorated charge using unused-time credit from the current monthly period, applied against the yearly price, and displays the calculation to the user (days remaining, credit amount, amount to be charged) before confirming the charge. See Section 5.11 for the worked example.

* FR-19: On confirmation, a Charge Authorization request is made against the stored authorization\_code for the prorated amount (test mode). On server-verified success, the Subscription row is updated in place: interval changes to YEARLY, currentPeriodStart resets to now, currentPeriodEnd moves to one year out.

* FR-20: A PaymentEvent row of type INITIATION, VERIFICATION, and FULFILMENT is recorded for the upgrade charge, exactly as with a new subscription, because an upgrade is a real charge and must leave the same audit trail as any other charge.

* FR-20a: The FULFILMENT event's metadata field for an upgrade includes previousPeriodStart and previousPeriodEnd (in addition to creditApplied, previousInterval, and newInterval), so the before-and-after period dates are reconstructable from the payment log alone and do not depend on a screenshot being taken at exactly the right moment.

*Fix applied: the append-only log is described throughout this PRD as the true system of record, but the prior revision's upgrade metadata never actually captured the prior period end — meaning the required “before and after” evidence depended on manual screenshot timing rather than the log itself. This closes that gap.*

## 5.8 Downgrade (Yearly → Monthly, or Monthly → Free)

* FR-21: A user can select “Downgrade” from the billing view. No charge occurs at the time of the request.

* FR-22: The downgrade is recorded as a pending change on the subscription (pendingPlanType, pendingInterval) rather than applied immediately. The user's current plan, price, and period end are unaffected until the current period ends.

* FR-23: At the natural period boundary, detected by this system's own scheduled renewal job (see Section 5.1), the pending change is applied: the subscription's live state moves to the downgraded plan, and if the downgrade is to a paid plan, the renewal job charges the new plan's price via Charge Authorization rather than the old plan's price.

* FR-23a: If the downgrade target is Free, no charge occurs, and at the period boundary interval, currentPeriodStart, and currentPeriodEnd are all set to null, matching the state of a user who has never subscribed (FR-3). paystackAuthorizationCode is retained, not cleared, so a future resubscription under FR-15a does not require the user to re-enter card details, unless the user separately and explicitly cancels rather than merely downgrading to Free.

*Fix applied: the previous revision specified what happens on a paid-to-paid downgrade but left the paid-to-Free path completely unspecified — nothing said what happened to the period fields or the stored authorization code, which risked a downgraded-to-Free user showing stale period dates on the billing view.*

* FR-24: If a user requests a second plan change (upgrade or downgrade) while one is already pending, the new request overwrites the previous pending change; only one pending change exists at a time.

* FR-24a: The billing view always shows the currently pending plan change, if any, so a user who changes their mind can see the latest pending state rather than assuming an earlier request is still queued.

*Fix applied: FR-24's overwrite behavior previously said nothing about whether the user could see that their earlier request had been replaced. Silently discarding a user's stated choice without showing them the current state is a usability trap, not just a technical rule.*

## 5.9 Cancellation

* FR-25: A user can select “Cancel” from the billing view. This opens a confirmation step; cancellation is never a single accidental click.

* FR-26: The confirmation step optionally prompts for a cancellation reason, selected from a fixed list (TOO\_EXPENSIVE, MISSING\_FEATURES, SWITCHING\_PROVIDER, TEMPORARY\_PAUSE, OTHER), with a free-text field enabled only when OTHER is selected. The reason is optional; skipping it is allowed.

* FR-27: On confirmation, the subscription's status is set to CANCELLING, cancelAtPeriodEnd is set to true, and currentPeriodEnd is not changed. The user retains full access until currentPeriodEnd passes.

FR-28: **The system never cuts off access immediately upon cancellation while the user has already paid for time remaining in the period.** This is the second trap named explicitly in the brief; see Section 5.12 for the fuller reasoning.

* FR-29: When currentPeriodEnd actually passes, detected by this system's own scheduled renewal/reconciliation job (there is no Paystack-managed subscription object to emit a period-end webhook, per Section 5.1), the subscription's status moves to CANCELED and the user reverts to Free.

* FR-30: The billing view, at all times, shows plan, status, renewal (or end-of-access) date, and a cancel control appropriate to current state (no “cancel” button shown on an already-CANCELLING subscription; instead a “resume” or informational state is shown), including the currently pending plan change described in FR-24a.

*Fix applied: status names in prose now match the Prisma enum casing exactly (CANCELLING, ACTIVE, CANCELED, PAST\_DUE) throughout this document.*

## 5.10 Renewal failure handling

Because renewals are initiated by this system's own scheduled job calling Charge Authorization (Section 5.1), a renewal failure is known synchronously from that API call's response, and is additionally confirmed or contradicted by the corresponding charge.success (or failure) webhook.

* FR-31: If a renewal Charge Authorization call does not succeed, the subscription's status is set to PAST\_DUE, access is retained, and a PaymentEvent of type FAILURE is recorded. If no successful renewal payment is verified within 3 days, a scheduled check moves status to CANCELED and the user reverts to Free.

* FR-31a: If a retry succeeds within the 3-day grace window, status returns to ACTIVE and currentPeriodEnd is extended by one full interval measured from the original currentPeriodEnd (the date the failed renewal was supposed to start from), not from the date the successful retry happened. A user is never penalized in total access time for a transient renewal failure that gets resolved within the grace window.

*Fix applied: PAST\_DUE existed in the schema and a 3-day grace period was described in the Open Questions section previously, but no Functional Requirement actually specified this behavior; FR-31 makes it concrete and testable. FR-31a closes a second gap: the prior revision never said whether a successful retry extends the period from the original due date or the retry date, which would otherwise give two different answers to “how much access does this user get.”*

## 5.11 Proration (worked example)

Scenario: a user is on Monthly (₦12,000.00/month \= 1,200,000 kobo) and upgrades to Yearly (₦120,000.00/year \= 12,000,000 kobo) on day 10 of a 30-day billing period (using a 30-day month for simplicity; the actual implementation uses the real number of days between currentPeriodStart and currentPeriodEnd).

* Days remaining in the current monthly period: 30 − 10 \= 20 days.

* Daily rate of the current monthly plan: 1,200,000 kobo / 30 days \= 40,000 kobo/day.

* Unused credit for the remaining 20 days: 20 days × 40,000 kobo/day \= 800,000 kobo (₦8,000.00 credit).

* Amount to charge for the new Yearly plan: 12,000,000 kobo − 800,000 kobo \= 11,200,000 kobo (₦112,000.00).

* The system charges ₦112,000.00 via Charge Authorization, and the resulting Subscription row shows interval \= YEARLY, currentPeriodStart \= today, currentPeriodEnd \= today \+ 365 days.

* The PaymentEvent FULFILMENT row for this transaction records amount \= 11200000, currency \= ngn, and a metadata field noting creditApplied \= 800000, previousInterval \= MONTHLY, newInterval \= YEARLY, previousPeriodStart, and previousPeriodEnd, so the credit and the prior period are both traceable later without recomputation.

This calculation must be correct to the day (per the “Excellent” grading band): the days-remaining figure is computed from the actual currentPeriodEnd minus now, not a hardcoded 20, and must be re-derivable from the stored period dates alone.

Because this system charges the exact amount it calculates via a direct Charge Authorization call, and Paystack's transaction API has no independent proration engine of its own to conflict with, the double-proration risk that exists in Stripe-based designs (where a platform-side proration engine can run automatically alongside a manually calculated one) does not apply here. There is exactly one number, calculated once, charged once.

## 5.12 Cancellation and period-end access: the legal reasoning

A subscription payment is consideration for a defined period of service, not for indefinite ongoing access starting at the moment of cancellation intent. When a user pays ₦12,000 for a month of access and cancels on day 5, they have already exchanged money for all 30 days of that period; the service provider retains an obligation to deliver the remaining 25 days regardless of the user's subsequent decision to not renew. Cutting off access immediately upon a cancellation click, while retaining the full period's payment, converts a partially used prepayment into an unearned windfall for the provider. This pattern is widely understood to be a strong chargeback and complaint signal, and it is the reason most subscription billing platforms default cancellation to “cancel at period end” rather than “cancel now.” The correct behavior, and the one required here, is: cancellation stops future renewal, not current access.

*Fix applied: the previous wording (“regulators and card networks treat”) stated this as settled legal fact with no citation. Softened to avoid overstating authority, while keeping the underlying reasoning.*

## 5.13 Card data and PCI scope

No card number, expiry, or CVC is ever transmitted to, processed by, or stored in this application's servers or database. All card entry happens on Paystack's hosted checkout page (or Paystack's inline pop-up, which still collects card data inside Paystack's own iframe, not this application's DOM), which is Paystack's PCI-DSS-compliant surface. By never touching raw card data, this system stays out of PCI DSS SAQ A-EP/D scope and sits in the lightest-weight SAQ A category, because the cardholder-data environment is entirely outsourced to Paystack. The only payment-related identifiers this system stores are Paystack's own opaque references (customer code, authorization code, transaction reference, transaction id) — none of which are card data. The stored authorization\_code is a tokenized reference usable only through Paystack's own Charge Authorization API; it cannot be used to reconstruct the underlying card.

# 6\. AI Processing Pipeline

Not applicable to this product. The Payment and Subscription Slice contains no AI/ML inference, no LLM calls, no embeddings, and no model-driven decision-making anywhere in its scope. Plan changes, proration math, and entitlement decisions are deterministic business logic executed against database state and verified Paystack API responses. This section is included only to satisfy the PRD template's required structure and is intentionally empty of AI content.

# 7\. Technical Requirements

## 7.1 Stack

* Frontend/Backend: Next.js (App Router), TypeScript throughout, no any types on payment-path code.

* ORM: Prisma.

* Database: PostgreSQL.

* Payment provider: Paystack, test mode only (test secret key, test public key).

* Currency: NGN, all amounts stored as integers in kobo.

## 7.2 Architecture notes

* All Paystack API calls (Initialize Transaction, Verify Transaction, Charge Authorization) happen in server-only code (Next.js Route Handlers or Server Actions), never in client components, and never using a client-side call for anything that affects entitlement.

* The webhook route reads the raw request body before any body-parsing middleware can alter it, since Paystack signature verification (HMAC-SHA512 against the secret key) requires the exact raw bytes of the payload.

* A single source of truth for “what is the user's entitlement right now” is a server-side function that reads the Subscription table (not client state, not a JWT claim set at login time), so a plan change is reflected immediately without requiring re-login.

* Rate limiting on checkout initiation is implemented with a database-backed counter (a RateLimitBucket row per userId and time window), not an in-memory counter, so it functions correctly regardless of whether the app runs on a single long-lived process or on stateless serverless instances (see FR-5). The counter increment and the limit check happen as a single atomic database operation (e.g. an UPDATE ... SET count \= count \+ 1 WHERE key \= ... AND windowStart \= ... RETURNING count, or an equivalent upsert-and-check inside one statement), not as a separate read-then-write, so two concurrent requests from the same user cannot both read the same pre-increment value and both pass the check.

*Fix applied: moving the counter from memory to a database row solves the cross-instance visibility problem, but a naive read-then-write against that row reintroduces the same race condition in a new location. The increment is now specified as a single atomic statement.*

* Money is stored exclusively as integers (kobo) in every table. No Float, Decimal-as-currency, or string-parsed currency values exist anywhere in the schema.

* Currency code ("ngn") is stored alongside every amount field, even though only one currency is supported today, so the schema does not need to change shape if a second currency is added later.

## 7.3 Error handling

* Every payment-path route (checkout initiation, return/verification, webhook, upgrade, downgrade, cancel) has an explicit try/catch or equivalent boundary that renders a styled error state or returns a structured JSON error, never an unhandled 500 with a stack trace and never a framework-default 404\.

* The return view specifically handles: reference not found, transaction not yet successful, verification API timeout, and already-processed reference (idempotent re-visit), each with its own user-facing message.

# 8\. Business Model

The product sells exactly one thing: a planType flag on the user record, at two prices. Free is the default. Monthly is ₦12,000.00/month. Yearly is ₦120,000.00/year (equivalent to ₦10,000.00/month, a 2-month discount versus paying monthly for a year: 12 × ₦12,000 \= ₦144,000, and ₦144,000 − ₦120,000 \= ₦24,000, exactly two months' worth of the monthly price).

*ASSUMPTION: these price points are illustrative defaults for this build, not researched market pricing; flagged as such because no real pricing input was provided. Specifically, these figures were chosen as round numbers proportionate to the original USD illustrative pricing (12 and 120), not derived from Nigerian market research or adjusted for local purchasing power or exchange rate. Replace before any real pricing decision.*

There is no free trial, no coupon system, and no tiered feature access in this phase (see Non-Goals). Revenue recognition, tax handling, and invoicing beyond what Paystack generates automatically are out of scope.

# 9\. Prisma Data Model

// schema.prisma

generator client {  
  provider \= "prisma-client-js"  
}

datasource db {  
  provider \= "postgresql"  
  url      \= env("DATABASE\_URL")  
}

enum PlanType {  
  FREE  
  MONTHLY  
  YEARLY  
}

enum BillingInterval {  
  MONTHLY  
  YEARLY  
}

enum SubscriptionStatus {  
  ACTIVE  
  PAST\_DUE  
  CANCELLING   // cancelAtPeriodEnd \= true, still has access  
  CANCELED     // period end has passed, no access  
}

enum PaymentEventType {  
  INITIATION  
  VERIFICATION  
  FULFILMENT  
  FAILURE  
  DUPLICATE\_IGNORED  
}

enum CancellationReason {  
  TOO\_EXPENSIVE  
  MISSING\_FEATURES  
  SWITCHING\_PROVIDER  
  TEMPORARY\_PAUSE  
  OTHER  
}

model User {  
  id           String   @id @default(cuid())  
  email        String   @unique  
  passwordHash String?  // ASSUMPTION: standalone auth; swap for  
                         // Assessment 1 auth's user table/field in  
                         // real integration  
  createdAt    DateTime @default(now())

  paystackCustomerCode String? @unique

  subscription  Subscription?  
  paymentEvents PaymentEvent\[\]  
}

model Subscription {  
  id     String @id @default(cuid())  
  user   User   @relation(fields: \[userId\], references: \[id\])  
  userId String @unique

  planType PlanType         @default(FREE)  
  interval BillingInterval?  
  status   SubscriptionStatus @default(ACTIVE)

  currentPeriodStart DateTime?  
  currentPeriodEnd   DateTime?

  cancelAtPeriodEnd  Boolean             @default(false)  
  cancellationReason CancellationReason?  
  cancellationNote   String?  // free text, only meaningful when  
                               // reason \= OTHER  
  cancelledAt        DateTime?

  pendingPlanType PlanType?  
  pendingInterval BillingInterval?

  // Reusable Paystack token for renewal/upgrade charges.  
  // Never a card number \-- only usable via Paystack's own  
  // Charge Authorization API.  
  paystackAuthorizationCode String?

  createdAt DateTime @default(now())  
  updatedAt DateTime @updatedAt

  // Supports the reconciliation sweep (Section 5.10 / FR-23 / FR-29):  
  // find subscriptions whose period just ended, or whose  
  // cancellation just took effect, without a full table scan.  
  @@index(\[currentPeriodEnd, cancelAtPeriodEnd\])  
}

// Append-only payment log. This table is the system of record;  
// the Subscription table above is a derived projection of it.  
model PaymentEvent {  
  id     String @id @default(cuid())  
  user   User   @relation(fields: \[userId\], references: \[id\])  
  userId String

  eventType PaymentEventType

  // Generated by this system per attempt. NOT unique on its own \--  
  // the same transaction legitimately produces multiple rows  
  // (INITIATION, VERIFICATION, FULFILMENT), all sharing this value.  
  providerReference String

  // Paystack's own numeric transaction id (data.id in the  
  // webhook payload). Also NOT unique on its own, for the same  
  // reason as providerReference above.  
  paystackTransactionId String?

  amount   Int    // minor units (kobo). 0 for pure status events.  
  currency String @default("ngn")

  planType PlanType?  
  interval BillingInterval?

  // e.g. { creditApplied: 800000, previousInterval: "MONTHLY",  
  //         newInterval: "YEARLY", previousPeriodStart: "...",  
  //         previousPeriodEnd: "..." }  
  metadata Json?

  createdAt DateTime @default(now())

  // These two composite constraints ARE the idempotency guards:  
  // the same transaction cannot produce two rows for the same  
  // lifecycle stage. Both are needed since paystackTransactionId  
  // is null on the INITIATION row (Paystack hasn't assigned one  
  // yet at that point).  
  @@unique(\[providerReference, eventType\])  
  @@unique(\[paystackTransactionId, eventType\])  
  @@index(\[userId\])  
}

// Database-backed rate limiting for the checkout initiation  
// endpoint (FR-5), so the limit holds regardless of whether  
// this app runs as one process or many stateless instances.  
// Keyed by string, not a foreign key, since this is a  
// short-lived counter rather than a durable relation to User.  
// Key format must stay consistent across all call sites  
// (e.g. always "checkout:{userId}", never a variant of it).  
// The increment against this row must be a single atomic  
// statement (see Section 7.2) \-- not a separate read then write.  
model RateLimitBucket {  
  id          String   @id @default(cuid())  
  key         String   @unique // e.g. "checkout:{userId}"  
  count       Int      @default(0)  
  windowStart DateTime  
}

*Fix applied (schema): providerReference and paystackTransactionId are no longer standalone-unique \-- see the FR-14 note above. createdAt on Subscription is now @default(now()) instead of @updatedAt, so the creation timestamp no longer silently changes on every update. RateLimitBucket now carries a comment on its key-format contract and its atomicity requirement.*

# 10\. Risks

* **Risk:** Trusting the return-view redirect as proof of payment. Mitigation: FR-8 mandates independent server-to-server verification against Paystack; the return view has zero authority to grant entitlement.

* **Risk:** Webhook redelivery causing double fulfilment or double charge recording. Mitigation: independent unique constraints on providerReference and paystackTransactionId, plus a composite (providerReference, eventType) constraint, plus explicit duplicate-check logic before any mutation (FR-14).

* **Risk:** A pending downgrade, a scheduled renewal, or a period-end cancellation never getting applied if this system's own scheduled job is missed. Mitigation: because there is no Paystack-managed subscription object to depend on (Section 5.1), this system's renewal job is the sole trigger, so it must run on a monitored schedule with alerting on missed runs; a reconciliation query (supported by the index in Section 9\) can independently surface any subscription whose currentPeriodEnd has passed without a corresponding status change.

* **Risk:** A database-backed rate limiter adds a write to every checkout attempt. Mitigation: the RateLimitBucket table is small, keyed for fast lookups, and this cost is accepted as the price of correctness across deployment topologies; a Redis-backed counter is the natural upgrade path if checkout volume grows.

* **Risk:** Cancellation reason capture becomes a place where free-text input carries sensitive content. Mitigation: accepted risk, not eliminated. Free text only appears when the fixed-list reason is OTHER, which limits exposure but does not validate content sensitivity. No further mitigation is planned for this project's scope.

* **Risk:** A naive read-then-write rate-limit increment reintroduces the same race condition the database-backed counter was meant to close, just at the database layer instead of in memory. Mitigation: the increment and limit check are specified as a single atomic statement (Section 7.2), not two separate operations.

* **Risk:** A subscription cannot auto-renew if Paystack never returns a reusable authorization\_code, or a stored one is later rejected by the issuing bank for off-session use. Mitigation: this state is treated as an ordinary renewal failure (PAST\_DUE, per FR-31), with a manual “reauthorize payment” action surfaced in the billing view (Section 5.1) rather than left as an undefined dead end.

*Fix applied: the previous wording (“treated as plain product feedback, not sensitive data”) asserted a classification as if it were a control. It is now stated as an accepted risk instead of a resolved one. Two further risks surfaced in this round's review — the rate-limit race and the missing-authorization dead end — are now listed here alongside their mitigations.*

# 11\. Success Metrics

Because this system has no real users or revenue, success is measured technically, not commercially:

* 100% of payment-affecting actions (initiation, verification, fulfilment, failure) produce a corresponding PaymentEvent row; zero silent state changes to Subscription without a matching log row.

* 0 instances of entitlement granted without a passing server-side verification call.

* Duplicate webhook delivery test: firing the same webhook payload twice results in exactly one FULFILMENT row and one DUPLICATE\_IGNORED row, and no double-counted entitlement or period extension.

* Proration calculation matches the worked formula in Section 5.11 to the exact kobo and to the exact day, verified against at least one real test-mode transaction.

* 0 blank pages or framework-default 404s reachable anywhere in the payment path, including every documented failure mode (reference not found, verification timeout, invalid webhook signature).

* 0 instances of raw card number, expiry, or CVC data in any database table (verified by schema inspection) or in application logs (verified by confirming that request/response logging on the checkout and webhook routes never logs full Paystack payloads containing such fields, since Paystack's hosted checkout never sends them to this server in the first place).

* 0 any types in payment-path files, enforced by the @typescript-eslint/no-explicit-any ESLint rule scoped to the checkout, webhook, and billing route files, checked before evidence capture.

* For any single transaction, all of its PaymentEvent rows (INITIATION, VERIFICATION, FULFILMENT) share the same providerReference, verified by a query grouping PaymentEvent rows by providerReference and confirming multiple rows exist per successful transaction — the opposite of what a standalone unique constraint on that column would have allowed.

*Fix applied: the card-data metric previously covered only schema inspection, which cannot catch a leak into application logs. Broadened accordingly. The no-any requirement in Section 7.1 previously had no corresponding metric; added here with a concrete enforcement mechanism. A new metric is added to positively confirm the corrected providerReference schema behaves as intended, not just that it no longer throws an error.*

# 12\. Assumptions

* Auth is a minimal standalone email/password (or magic-link) system, standing in for Assessment 1's auth; the integration point for swapping in the real Assessment 1 auth is documented in code comments.

* Payment provider is Paystack, test mode.

* Currency is NGN only, stored in kobo.

* Prices are ₦12,000/month and ₦120,000/year.

* Rate limiting is implemented with a database-backed counter (RateLimitBucket), acceptable for this project's scope; a Redis-backed store is the natural next step at higher volume.

* No refunds (beyond the narrow duplicate-charge safeguard), no email notifications, no admin dashboard are in scope for this phase.

* Only one pending plan change can exist at a time; a newer request overwrites an older pending one, and the billing view always reflects the latest pending state.

* Cancellation reason is a fixed list plus optional free text, not a required field.

* This system does not use Paystack's native Subscription/Plan object; all recurring charging is self-managed via Initialize Transaction and Charge Authorization (Section 5.1).

* If Paystack does not return a reusable authorization on first charge, or a stored one is later rejected for off-session use, renewal requires the user to manually reauthorize via a fresh checkout link shown in the billing view; no email or SMS is sent to prompt this.

*This section mirrors decisions made and justified earlier in the document; it does not introduce new ones.*

# 13\. Phased Roadmap

### Phase 1: Core subscribe/verify/log loop

Signed-in shell, plans view, checkout initiation, return view with server-side verification, webhook endpoint with signature verification, Subscription and PaymentEvent models (including the corrected PaymentEvent uniqueness constraints from Section 9 — composite, not single-column; this is a Phase 1 blocker, since the single-column version would fail on the very first successful subscribe attempt, not a later hardening item), subscribe-to-monthly flow end to end.

### Phase 2: Upgrade, downgrade, proration

Upgrade flow with proration calculation and display, downgrade flow with pending-change mechanism, this system's own scheduled renewal job to apply pending changes and charge renewals via Charge Authorization.

### Phase 3: Cancellation and idempotency hardening

Cancellation flow with confirmation step and reason capture, period-end access retention, duplicate webhook test coverage, unique-constraint-backed idempotency enforcement, renewal failure handling (FR-31).

### Phase 4: Evidence and audit polish

Database screenshots/evidence generation for subscribe, upgrade, duplicate webhook, and cancellation scenarios; reconciliation sweep job for missed pending-change or period-end application; documentation of PCI scope reasoning and payment lifecycle separation.

### Phase 5 (stretch, “Excellent” band): append-only log and derived entitlement

Refactor so Subscription.status/planType are computed on read from the PaymentEvent log rather than stored and mutated directly; add explicit duplicate-payment-while-active handling (reject or extend, with a test proving the chosen behavior, and this only applies if pursuing the Excellent grading band — for a Pass-level build this can be left as an explicit known limitation); move rate limiting to a Redis-backed store for higher-volume correctness.

# 14\. Open Questions

**Failed renewal payment handling:** resolved as a requirement, not left open. See FR-31: a 3-day grace period with status \= PAST\_DUE, retaining access, followed by automatic downgrade to Free if no successful retry occurs within that window.

**Duplicate/double payment while already active:** if a user is somehow charged twice for an already-active plan (e.g. a race condition or a replayed checkout), should the system reject the second charge outright, or accept it and extend the period by the equivalent duration? This only applies if pursuing the Excellent grading band (Phase 5); for a Pass-level build this can be left as an explicit known limitation. **Recommended default:** reject and auto-refund the second charge via Paystack's Refund API, recording both the FULFILMENT and a FAILURE-adjacent DUPLICATE\_IGNORED event, since silently extending risks masking a bug that caused the double charge in the first place.