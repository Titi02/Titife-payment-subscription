import { redirect } from "next/navigation";
import { ensureTestUser, setSessionCookie } from "@/server/auth";

/**
 * Login page — minimal auth stand-in (AGENTS.md Section 2 Auth rule)
 *
 * INTEGRATION SEAM: Replace this entire page with Assessment 1's
 * real login flow. The only contract the rest of the app depends on
 * is that after login, a session cookie exists with a valid userId.
 */
export default function LoginPage() {
  async function loginAction() {
    "use server";
    const user = await ensureTestUser();
    await setSessionCookie(user.id);
    redirect("/plans");
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-card__title">Titife</h1>
        <p className="login-card__subtitle">
          Sign in to manage your subscription
        </p>
        <form className="login-card__form" action={loginAction}>
          <button type="submit" className="btn btn--primary btn--full-width">
            Sign in as Test User
          </button>
        </form>
        <p className="login-card__note">
          Development stand-in — auto-signs in as test@titife.com
        </p>
      </div>
    </div>
  );
}
