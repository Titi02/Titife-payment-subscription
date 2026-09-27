import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import {
  getUpgradeQuote,
  UpgradeQuoteError,
} from "@/server/payments/upgrade-quote";

/**
 * Upgrade preview — FR-18.
 *
 * Returns the live prorated breakdown (days remaining, unused Monthly credit,
 * amount to charge) so the confirmation modal shows a fresh, server-computed
 * figure instead of a value baked in at page render time. The POST charge
 * route recomputes through the same getUpgradeQuote code path.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const quote = await getUpgradeQuote(user.id);
    return NextResponse.json({
      daysRemaining: quote.daysRemaining,
      creditKobo: quote.creditKobo,
      amountKobo: quote.amountKobo,
    });
  } catch (error) {
    if (error instanceof UpgradeQuoteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error("Upgrade preview failed:", error);
    return NextResponse.json(
      { error: "Failed to calculate upgrade price." },
      { status: 500 }
    );
  }
}
