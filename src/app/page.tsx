import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";

/**
 * Root page — redirects to the plans view if signed in,
 * or to the login page if not.
 */
export default async function Home() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/plans");
  } else {
    redirect("/login");
  }
}
