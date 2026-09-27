/**
 * Auth stand-in — AGENTS.md Section 2 Auth rule
 *
 * INTEGRATION SEAM: This entire module is a minimal standalone auth stand-in.
 * When Assessment 1's real auth system is available, replace:
 *   1. getCurrentUser() — to read from the real session/token
 *   2. The seed logic — to use the real User table from Assessment 1
 *   3. The session cookie mechanism — to use the real auth session
 *
 * Do NOT build a third-party auth provider (Auth0, Clerk, NextAuth-with-OAuth)
 * unless explicitly told to.
 */

import { prisma } from "@/server/db/prisma";
import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "session_user_id";

/**
 * Seeds a test user if none exists. Called on app start in development.
 * This is the stand-in for real auth — a single known user for testing
 * the payment flow end-to-end.
 */
export async function ensureTestUser(): Promise<{
  id: string;
  email: string;
}> {
  const testEmail = "test@titife.com";

  let user = await prisma.user.findUnique({
    where: { email: testEmail },
    select: { id: true, email: true },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: testEmail,
        // passwordHash left null — this is a stand-in, not real auth
      },
      select: { id: true, email: true },
    });
  }

  return user;
}

/**
 * Gets the current signed-in user from the session cookie.
 * Returns null if not signed in.
 *
 * INTEGRATION SEAM: Replace this with Assessment 1's session reader.
 */
export async function getCurrentUser(): Promise<{
  id: string;
  email: string;
} | null> {
  const cookieStore = await cookies();
  const userId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  return user;
}

/**
 * Sets the session cookie for a given user ID.
 * INTEGRATION SEAM: Replace with real session token generation.
 */
export async function setSessionCookie(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
}

export { SESSION_COOKIE_NAME };
