# Titife — Payment & Subscription Slice

Self-contained subscription billing for one signed-in user: **Free / Monthly / Yearly**, sold through **Paystack (test mode)**, priced in **NGN**. Non-recurring — every charge is a user-initiated payment via Paystack hosted checkout; the app owns the billing period and never auto-renews.

The interesting part is the plumbing, not the storefront: checkout handoff, server-side verification, signed webhooks, idempotency, mid-cycle proration, and cancellation that honours time already paid for.

## Key features

- **Server-verified entitlement only** — never granted on a redirect; the return page and the webhook each ask Paystack server-to-server.
- **Immutable payment log** (`PaymentLog`) as the system of record — every stage its own row, unique on `(providerReference, eventType)` and `(paystackTransactionId, eventType)`.
- **Webhook signature verification** — HMAC-SHA512 over the raw body before any parsing; mismatch returns 400 and processes nothing.
- **Idempotency** — a redelivered webhook is logged once as `DUPLICATE_IGNORED` and changes nothing.
- **Prorated upgrade** — integer kobo math from real days remaining; the quote shown is the amount charged.
- **Downgrade at period end** and **cancel that keeps access** until `currentPeriodEnd`.
- **DB-backed rate limiting** (10 checkouts/min/user) via an atomic `UPDATE ... RETURNING` counter.
- **No card data ever stored** — only Paystack's opaque references. All money is integer kobo.

## Tech stack

Next.js 14 (App Router) · TypeScript strict · Prisma 5 · PostgreSQL 16 · Paystack test mode · ESLint

## Local setup

Needs Node.js LTS, a local PostgreSQL database, and a Paystack test-mode key.

```bash
cp .env.example .env          # DATABASE_URL (your local Postgres), PAYSTACK_SECRET_KEY (sk_test_...), NEXT_PUBLIC_APP_URL
npm install
npx prisma migrate dev
npm run dev                   # http://localhost:3000 → "Sign in as Test User"
```

Scheduled jobs: `npx ts-node scripts/run-expiry-sweep.ts` (lapse ended terms, apply pending downgrades) · `npx ts-node scripts/run-reconciliation.ts` (find verified-but-unfulfilled payments).

## Verification

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## Further reading

**[DOCUMENTATION.md](./DOCUMENTATION.md)** — the flow, the data model, the concepts behind each decision, and assessment evidence. The binding spec is [`docs/payment-subscription-slice-prd-v3.md`](./docs/payment-subscription-slice-prd-v3.md); build rules live in [`AGENTS.md`](./AGENTS.md).
