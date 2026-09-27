import { PrismaClient } from "@prisma/client";

// Prevent multiple PrismaClient instances in development due to hot reloading.
// In production, a single instance is created normally.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    transactionOptions: {
      // Interactive transactions default to a 5s timeout, which is too short
      // when the DB is cold or a concurrent webhook holds a row lock. The
      // fulfilment transactions below are two writes (Subscription + PaymentLog)
      // that must stay atomic, so we raise the ceiling rather than trim the work.
      maxWait: 10_000,
      timeout: 20_000,
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
