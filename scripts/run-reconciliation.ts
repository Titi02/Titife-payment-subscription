import { findStuckTransactions } from "../src/server/subscriptions/reconciliation";

/**
 * Phase 4 — Reconciliation Script
 * 
 * Runs the manual reconciliation queries to find stuck transactions
 * and outputs the results to the console.
 * 
 * Usage: npx ts-node scripts/run-reconciliation.ts
 */
async function run() {
  console.log("Starting reconciliation sweep...");
  
  try {
    const stuckTransactions = await findStuckTransactions();

    if (stuckTransactions.length === 0) {
      console.log("✅ No stuck transactions found. All verified transactions have been fulfilled.");
    } else {
      console.log(`⚠️ Found ${stuckTransactions.length} stuck transactions (VERIFICATION with no FULFILMENT):`);
      console.table(stuckTransactions);
      console.log("Please investigate these references in the Paystack dashboard and application logs.");
    }

    console.log("Reconciliation sweep complete.");
    process.exit(0);
  } catch (error) {
    console.error("Reconciliation sweep failed:", error);
    process.exit(1);
  }
}

run();
