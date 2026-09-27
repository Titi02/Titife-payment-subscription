# Evidence Queries for Grading

This document contains the Prisma queries (and their raw SQL equivalents) used to generate the required database screenshots and evidence for the Phase 4 assessment.

You can run these queries using Prisma Studio (`npx prisma studio`) or a standard PostgreSQL client (e.g. pgAdmin, psql, DBeaver).

## 1. Successful Subscribe Flow
To prove that a new subscription correctly generates the three-stage immutable log (INITIATION, VERIFICATION, FULFILMENT) under a single provider reference.

**Prisma:**
```ts
const subscribeLogs = await prisma.paymentLog.findMany({
  where: { userId: "<USER_ID>" },
  orderBy: { createdAt: 'asc' }
});
console.table(subscribeLogs);
```

**SQL:**
```sql
SELECT "eventType", "providerReference", "amount", "planType" 
FROM "PaymentLog" 
WHERE "userId" = '<USER_ID>' 
ORDER BY "createdAt" ASC;
```

## 2. Upgrade with Proration
To prove that an upgrade correctly records a new set of logs, and importantly, includes the `metadata` with the `creditApplied` and period boundaries.

**Prisma:**
```ts
const upgradeLog = await prisma.paymentLog.findFirst({
  where: { 
    userId: "<USER_ID>", 
    eventType: "FULFILMENT",
    metadata: { not: null }
  },
  orderBy: { createdAt: 'desc' }
});
console.log(upgradeLog.metadata);
```

**SQL:**
```sql
SELECT "eventType", "amount", "metadata" 
FROM "PaymentLog" 
WHERE "userId" = '<USER_ID>' 
  AND "eventType" = 'FULFILMENT' 
  AND "metadata" IS NOT NULL
ORDER BY "createdAt" DESC;
```

## 3. Webhook Idempotency (Duplicate Ignored)
To prove that a redelivered webhook is cleanly caught by the Prisma `P2002` composite constraint and logged, rather than double-charging or granting double-entitlement.

**Prisma:**
```ts
const duplicateLogs = await prisma.paymentLog.findMany({
  where: { eventType: "DUPLICATE_IGNORED" }
});
console.table(duplicateLogs);
```

**SQL:**
```sql
SELECT "eventType", "providerReference", "metadata" 
FROM "PaymentLog" 
WHERE "eventType" = 'DUPLICATE_IGNORED';
```

## 4. Safe Cancellation
To prove that clicking 'Cancel' does not immediately revoke access, but sets the `CANCELLING` status and `cancelAtPeriodEnd` flag while preserving the `currentPeriodEnd`.

**Prisma:**
```ts
const sub = await prisma.subscription.findUnique({
  where: { userId: "<USER_ID>" }
});
console.log({
  status: sub.status,
  cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  currentPeriodEnd: sub.currentPeriodEnd,
  cancellationReason: sub.cancellationReason
});
```

**SQL:**
```sql
SELECT "status", "cancelAtPeriodEnd", "currentPeriodEnd", "cancellationReason"
FROM "Subscription"
WHERE "userId" = '<USER_ID>';
```
