-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('INITIATED', 'VERIFIED', 'SUCCESS', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionFlagType" AS ENUM ('DUPLICATE_CHARGE', 'STUCK');

-- AlterTable
ALTER TABLE "PaymentEvent" ADD COLUMN     "transactionId" TEXT;

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "paystackTransactionId" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ngn',
    "planType" "PlanType",
    "interval" "BillingInterval",
    "status" "TransactionStatus" NOT NULL DEFAULT 'INITIATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionFlag" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "flagType" "TransactionFlagType" NOT NULL,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_providerReference_key" ON "Transaction"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_paystackTransactionId_key" ON "Transaction"("paystackTransactionId");

-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionFlag_transactionId_flagType_key" ON "TransactionFlag"("transactionId", "flagType");

-- CreateIndex
CREATE INDEX "PaymentEvent_transactionId_idx" ON "PaymentEvent"("transactionId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionFlag" ADD CONSTRAINT "TransactionFlag_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
