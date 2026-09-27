# AGENTS.md — The Payment and Subscription Slice

This file governs HOW you build. It does not describe the product — that is the PRD's job. If something here and the PRD ever seem to disagree on a *feature*, the PRD wins. If something here and the PRD ever disagree on a *rule of conduct* (tools, process, discipline), this file wins, because this file exists specifically to stop the failure modes a PRD alone cannot prevent.

---

## 1. What is this project

You are building **The Payment and Subscription Slice**: a self-contained subscription billing system for a single signed-in user, who can hold one of three plan states — Free, Monthly, or Yearly — sold through **Paystack in test mode**, priced in **Nigerian Naira (NGN)**.

There is no marketing surface, no pricing page, and no feature gating beyond one `planType` value. The entire product surface is: view plan, subscribe, upgrade, downgrade, cancel. What is actually being engineered is the payment plumbing underneath that surface — checkout handoff, server-side verification, webhook processing, idempotency, proration, and period-respecting cancellation.

**Source of truth:** `PRD: The Payment and Subscription Slice — Revision 3 (Paystack / NGN)`. Every functional requirement (FR-1 through FR-31a), every schema field, and every worked example in that document is binding. This file tells you how to behave while you implement it. It does not repeat what to build — go to the PRD for that, every time, not to memory of a previous conversation about it.

**Version being built:** the full Revision 3 scope, delivered **phase by phase**, per the Phased Roadmap (PRD Section 13). You are not building all five phases in one pass unless explicitly told to. See Rule Group C below on phase discipline — it is not optional.

---

## 2. What is locked

Everything in this section has already been decided. Do not swap it, "improve" it, upgrade it to a newer alternative, or replace it with something you think is better. If you believe one of these choices is actually wrong, say so in your output and stop — do not silently substitute your own judgment.

- **Framework:** Next.js, App Router. **Language:** TypeScript throughout, strict mode, on every file — not just payment-path files.
- **ORM:** Prisma. **Database:** PostgreSQL. Do not introduce a second database, a query builder, or a raw-SQL layer that bypasses Prisma for application logic.
- **Payment provider:** Paystack, test mode only, for the entire build. Do not add Stripe, Flutterwave, or any other provider, even "as an option" or "for comparison." This is not a multi-provider system.
- **Payment architecture:** self-managed periods (PRD 5.1). This system does **not** use Paystack's native Subscription/Plan object, ever, and it does **not** use Charge Authorization — this is a **non-recurring** test/assessment build with no automatic renewal engine. Every charge — first subscription, upgrade, or downgrade — is a user-initiated payment via Paystack's hosted **Initialize Transaction** checkout, completed through server-side Verify Transaction. This system owns `currentPeriodStart`/`currentPeriodEnd`; the scheduled expiry sweep applies pre-paid plan changes and lapses ended terms. Do not reach for Paystack's Subscriptions/Plans or `/transaction/charge_authorization` endpoints under any circumstance — the PRD explicitly rejected native subscriptions because they fight this system's period model.
- **Currency and money representation:** NGN only. Every amount, everywhere, is stored as a whole-number integer in **kobo** (NGN's minor unit). Never a float. Never a decimal type used for money. Never a string-parsed amount. This is not a style preference — it is load-bearing across every financial calculation in the system.
- **Webhook verification:** HMAC-SHA512 of the raw request body against the Paystack secret key, compared to the `x-paystack-signature` header, computed before any body parsing for business logic (FR-12).
- **Idempotency mechanism:** exactly two composite unique constraints on `PaymentLog` — `(providerReference, eventType)` and `(paystackTransactionId, eventType)`. Neither `providerReference` nor `paystackTransactionId` is ever a standalone-unique column — a single transaction legitimately produces multiple rows (INITIATION, VERIFICATION/CALLBACK_VERIFIED, CHARGE_SUCCESS, FULFILMENT per FR-16) that all share the same reference. Do not "clean up" the schema by adding a standalone unique constraint to either column; doing so will break the build the moment a real transaction writes its second log row.
- **Rate limiting:** a database-backed `RateLimitBucket` model, incremented via a single atomic statement (e.g. `UPDATE ... SET count = count + 1 ... RETURNING count`). Never an in-memory counter. Never a read-then-write.
- **Data model shape:** the enums (`PlanType`, `BillingInterval`, `SubscriptionStatus`, `PaymentLogType`, `CancellationReason`) and the models (`User`, `Subscription`, `PaymentLog`, `RateLimitBucket`) are defined in PRD Section 9. Field names, nullability, and constraints as written there are locked. Extend the schema only to add something the PRD requires that isn't yet modeled — never rename, retype, or drop an existing field to suit your own taste.
- **Pricing:** ₦12,000/month, ₦120,000/year, as literal values used in the FR-1 plans view and the FR-18/5.11 proration examples. These are flagged in the PRD as illustrative placeholders — if you are ever asked to change them, that is a deliberate task, not something you decide to do while working on something else.
- **Auth:** a minimal standalone email/password (or magic-link) system stands in for a previously built "Assessment 1" auth system. Build the stand-in; leave a clearly marked integration seam (a comment, a single auth-adapter module) for swapping in the real one later. Do not build a third-party auth provider integration (Auth0, Clerk, NextAuth-with-OAuth, etc.) unless told to.

---

## 3. What must never happen

Every rule below is a business or user-protection rule pulled directly from the PRD's must/never/only language. **Breaking any rule on this list means the task has failed, even if the code compiles, the tests pass, and the feature appears to work in a demo.** These are not code-quality issues — they are the difference between a payment system and a payment system that quietly cheats someone.

1. **Never grant entitlement on the strength of a redirect, a query parameter, or any client-supplied claim.** Entitlement is granted only after an independent server-to-server call to Paystack's Verify Transaction API confirms `status: "success"` and the amount/currency match. The return view has zero authority to grant anything by itself. *(PRD FR-8 — "the single most important rule in the system.")*
2. **Never write fulfilment logic anywhere except server-side code triggered by a verified webhook or a verified Verify Transaction call.** Never from a client component, never from the frontend. *(FR-13, 7.2.)*
3. **Never process a webhook payload for business logic before its signature has been verified.** Compute the HMAC-SHA512 digest against the raw body first; reject with 400 on any mismatch, and do not persist a rejected webhook as a payment-lifecycle event. *(FR-12.)*
4. **Never let the same transaction act twice on the same lifecycle stage.** Before writing any INITIATION/VERIFICATION/FULFILMENT/FAILURE row, check the composite constraints described in Section 2 above. A redelivered webhook must be recorded once, as a duplicate/ignored row, and must never trigger a second entitlement change. *(FR-14.)*
5. **Never store card numbers, expiry dates, or CVCs anywhere in this application** — not in the database, not in logs, not in memory beyond the redirect to Paystack's hosted checkout. The only payment identifiers this system stores are Paystack's own opaque references (customer code, authorization code, transaction reference, transaction id). *(Goals; 5.13.)*
6. **Never store a monetary amount as a float or a decimal, and never omit the currency code alongside an amount field.** Every amount is a whole-number integer in kobo, every single time, with no exceptions for "just this one field." *(7.2.)*
7. **Never cut off a user's access immediately upon cancellation while they have already paid for time remaining in the current period.** Cancellation always sets `cancelAtPeriodEnd = true` and leaves `currentPeriodEnd` untouched; access is retained until that date passes. This is named as a specific trap the PRD exists to avoid, and violating it is a legal/business-reasoning failure, not a bug. *(FR-27, FR-28, 5.12.)*
8. **Never apply an upgrade or downgrade charge on any basis other than the proration formula in PRD 5.11**, calculated from the real number of days between `currentPeriodStart` and `currentPeriodEnd` — never a hardcoded day count. The amount displayed to the user before confirming must be the exact amount charged. *(FR-18, 5.11.)*
9. **Never apply a downgrade immediately.** It is recorded as a pending change (`pendingPlanType`, `pendingInterval`) and only takes effect at the next period boundary via the scheduled renewal job. *(FR-21–FR-23.)*
10. **Never let a downgrade-to-Free leave stale period data behind.** At the boundary, `interval`, `currentPeriodStart`, and `currentPeriodEnd` must all be set to null; the stored authorization code is retained (not cleared) unless the user separately cancels. *(FR-23a.)*
11. **Never silently discard a user's pending plan-change request without showing them the new state.** A second request overwrites the first, but the billing view must always reflect whichever change is currently pending. *(FR-24, FR-24a.)*
12. **Never let a cancellation happen without an explicit confirmation step**, and never make the optional cancellation-reason capture a required field. *(FR-25, FR-26.)*
13. **Never move a subscription straight from a failed renewal to CANCELED.** A failed renewal charge sets `PAST_DUE` and retains access; only after a 3-day grace period with no successful retry does it become `CANCELED`. If a retry succeeds inside that window, extend `currentPeriodEnd` by one full interval from the *original* due date, never from the retry date. *(FR-31, FR-31a.)*
14. **Never leave a resubscribing user's row carrying stale cancellation history.** On resubscription after a full cancel, `cancelledAt`, `cancellationReason`, `cancellationNote`, `pendingPlanType`, and `pendingInterval` are all reset to null. *(FR-15a.)*
15. **Never build user-initiated refund UI or refund processing.** The one narrow exception — an automatic refund solely to correct a detected duplicate charge — exists only if you are explicitly building toward the Excellent-band scope (PRD Section 14, Phase 5). For a Pass-level build, treat duplicate-charge handling as a documented known limitation, not a feature to build. *(Non-Goals; Section 14.)*
16. **Never leave a user on a blank page or a framework-default 404 anywhere in the payment path** — checkout, return, webhook, upgrade, downgrade, cancel. Every failure mode gets an explicit, styled state. *(Goals; FR-9, FR-10; 7.3.)*
17. **Never skip rate limiting on the checkout initiation endpoint**, and never implement it in a way that stops working under concurrent requests or multiple server instances. *(FR-5; 7.2.)*
18. **Never introduce multi-currency support, team/org billing, more than one paid plan tier, or an email/notification system.** These are explicit Non-Goals. Building any of them — even as a well-intentioned improvement — is scope creep, and scope creep is a failed task under this file's rules even when the added feature works correctly.

---

## 4. How the work is arranged

Use this layout. It exists to keep the things the PRD says must stay separate — Paystack access, entitlement logic, the payment log, and the UI — actually separate in the file system, not just in your head.

```
/prisma
  schema.prisma                 # the Section 9 data model — locked shape, see Section 2

/src
  /app
    /(app)                      # signed-in shell — everything behind auth
      /plans/page.tsx           # FR-1–FR-3
      /billing/page.tsx         # FR-30, FR-24a
      /checkout
        /return/page.tsx        # FR-7–FR-10
      layout.tsx
    /api
      /webhooks/paystack/route.ts   # FR-11, FR-12 — raw body read here, nowhere else
      /checkout/initiate/route.ts   # FR-4, FR-5
    layout.tsx

  /server                       # ALL Paystack calls and entitlement logic live here.
                                 # Nothing in /app calls Paystack directly.
    /paystack
      client.ts                 # thin fetch wrapper, test-mode keys only
      initialize-transaction.ts
      verify-transaction.ts
      verify-webhook-signature.ts   # HMAC-SHA512 check — FR-12

    /payments
      log.ts                    # the only place PaymentLog rows get written
      idempotency.ts            # the composite-constraint check described in Section 2
      proration.ts              # the 5.11 formula — one implementation, reused everywhere

    /subscriptions
      entitlement.ts            # single source of truth reader — 7.2
      expiry-sweep.ts           # scheduled job; applies pre-paid plan changes
                                # and lapses ended terms at period boundaries
      reconciliation.ts         # FR-16a stuck-transaction check, FR-29 sweep

    /rate-limit
      checkout-limiter.ts       # atomic RateLimitBucket increment — FR-5, 7.2

    /db
      prisma.ts                 # single Prisma client instance

    /auth
      ...                       # standalone auth stand-in, with a marked integration seam

  /lib
    money.ts                    # kobo <-> display formatting helpers, nothing else touches money math
    dates.ts                    # day-count helpers used by proration.ts

  /components                   # presentation only — no Paystack calls, no direct Prisma access

  /types                        # shared TS types mirroring the Prisma schema where useful

/scripts
  run-expiry-sweep.ts           # entry point for the scheduled expiry sweep, for local/manual runs

/tests
  ...                           # mirror the /server structure
```

Rule for this layout, not just a description of it: **UI components never call Paystack and never query Prisma directly.** They call functions in `/server`. If you find yourself importing the Paystack client or the Prisma client into anything under `/app` or `/components` outside a Route Handler or Server Action, that is a violation of the separation this file requires, not a shortcut.

---

## 5. How the code should look

- **TypeScript strict mode, everywhere.** `"strict": true` in `tsconfig.json`, no exceptions.
- **No `any`, anywhere, ever** — not just on payment-path code (the PRD's own bar), enforce it project-wide via `@typescript-eslint/no-explicit-any`. If you're tempted to reach for `any`, that's a signal to model the type properly, not to suppress the check.
- **Node.js LTS** (the current active LTS at time of setup) and the latest stable Next.js and Prisma versions that are compatible with it. Pin versions in `package.json`; do not float on `latest`.
- **ESLint + Prettier**, run clean before anything is considered finished. No disabled rules to make a build pass — fix the code instead.
- **Functions do one thing.** A Route Handler validates input and calls into `/server`; it does not also contain the business logic. If a function is doing "verify, then log, then update three tables," split it — each of those is independently testable and independently auditable, which matters enormously for a payment log system.
- **No silent catch blocks.** Every `try/catch` on a payment-path route either handles the specific failure with a real user-facing state (7.3) or re-throws with context. Never swallow an error to make a red build turn green.
- **Comments explain *why*, not *what*.** The PRD is full of "why" reasoning (proration math, legal reasoning for period-end access, PCI scope) — when your code implements one of those rules, a one-line comment pointing back to the FR number is worth more than a comment restating the code.
- **No dead scaffolding.** Don't leave commented-out alternate implementations, placeholder TODOs for features nobody asked for, or unused exports "in case they're needed later."

---

## 6. What counts as done

Before calling any task complete, produce a checklist covering everything below that applies to the task you were given. Do not check something off you haven't actually verified.

- [ ] **The project builds with zero errors** (`next build` succeeds; `tsc --noEmit` is clean).
- [ ] **Lint is clean** (no `any`, no disabled rules, no warnings suppressed to pass).
- [ ] Every functional requirement touched by this task is implemented **exactly as specified**, with its FR number referenced in your summary (e.g. "FR-8: return view calls Verify Transaction server-side — done").
- [ ] Every rule in **Section 3 of this file** that's relevant to the task has been checked against the actual code, not assumed.
- [ ] The Prisma schema still matches PRD Section 9 exactly — no standalone-unique on `providerReference`/`paystackTransactionId`, no renamed fields, no dropped constraints.
- [ ] No feature from a **later roadmap phase** (PRD Section 13) has been built unless the task explicitly asked for it.
- [ ] No Non-Goal (PRD Section 3) has been quietly implemented.
- [ ] All money values in any new code are integers in kobo, with currency stored alongside.
- [ ] Every new payment-path route has explicit error handling for its documented failure modes — no blank pages, no default 404s.
- [ ] If this task touched the payment log, the audit trail is verifiable: you can point to the specific `PaymentLog` rows a test transaction produced and show they match the expected stage sequence.

---

## 7. What you do when unsure

You will hit gaps this file and the PRD don't cover. When that happens:

- **Do not invent a new feature, a new field, or a new scope to fill the gap.** A gap is not an invitation to improve the product — it's a signal to ask or to make the smallest, most reversible assumption possible.
- **Do not reach into a later phase to "future-proof" the current one.** If Phase 1 doesn't need proration, don't scaffold proration code "since we'll need it soon." Build exactly what the current task asks for, at the quality bar in Section 5, and stop there.
- **Do not write speculative branches for cases the PRD doesn't describe.** If you're not sure how the system should behave in a situation the PRD is silent on, do the minimum that keeps the system safe (fail closed, log it, surface a clear error) and flag the gap explicitly in your output — in plain language, naming the PRD section you looked in and didn't find an answer. Do not guess and move on silently.
- **Prefer an honest stop over a plausible-looking guess.** A task that ends with "I'm not sure how X should behave when Y — here's what the PRD says nearby, here's what I did as a safe default, please confirm" is a successful outcome. A task that silently invents behavior for X and hopes it's right is not, even if it happens to be correct.
- **Never patch around a failing build or a broken constraint with a workaround that hides the problem** (loosening a type to `any`, removing a constraint that's inconvenient, catching and ignoring an error). If a locked choice in Section 2 seems to be causing a real problem, stop and report it — do not quietly route around it.
- **When two instructions genuinely conflict** (this file vs. the PRD, or two parts of the PRD), state the conflict explicitly and pick the more conservative reading — the one that protects money, entitlement, or user access — rather than the one that's easier to build.
