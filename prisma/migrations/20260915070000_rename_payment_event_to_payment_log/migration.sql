-- Rename the event type enum (data-preserving: the type's OID is unchanged,
-- only its name changes, so the "eventType" column keeps working).
ALTER TYPE "PaymentEventType" RENAME TO "PaymentLogType";

-- Rename the legacy FAILURE value to the new CHARGE_FAILURE label. This keeps
-- any existing FAILURE rows intact and relabels them in place.
ALTER TYPE "PaymentLogType" RENAME VALUE 'FAILURE' TO 'CHARGE_FAILURE';

-- Add the new event types (appended to the enum).
ALTER TYPE "PaymentLogType" ADD VALUE 'CALLBACK_VERIFIED';
ALTER TYPE "PaymentLogType" ADD VALUE 'CHARGE_SUCCESS';
ALTER TYPE "PaymentLogType" ADD VALUE 'REFUND_PROCESSED';

-- Rename the table.
ALTER TABLE "PaymentEvent" RENAME TO "PaymentLog";

-- Rename the primary key constraint.
ALTER TABLE "PaymentLog" RENAME CONSTRAINT "PaymentEvent_pkey" TO "PaymentLog_pkey";

-- Rename indexes.
ALTER INDEX "PaymentEvent_userId_idx" RENAME TO "PaymentLog_userId_idx";
ALTER INDEX "PaymentEvent_providerReference_eventType_key" RENAME TO "PaymentLog_providerReference_eventType_key";
ALTER INDEX "PaymentEvent_paystackTransactionId_eventType_key" RENAME TO "PaymentLog_paystackTransactionId_eventType_key";
ALTER INDEX "PaymentEvent_transactionId_idx" RENAME TO "PaymentLog_transactionId_idx";

-- Rename foreign key constraints.
ALTER TABLE "PaymentLog" RENAME CONSTRAINT "PaymentEvent_userId_fkey" TO "PaymentLog_userId_fkey";
ALTER TABLE "PaymentLog" RENAME CONSTRAINT "PaymentEvent_transactionId_fkey" TO "PaymentLog_transactionId_fkey";
