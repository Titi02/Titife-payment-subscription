import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__brand">Titife</div>
        
        <nav className="app-sidebar__nav">
          <Link href="/plans" className="app-sidebar__link">
            Plans
          </Link>
          <Link href="/billing" className="app-sidebar__link">
            Billing
          </Link>
        </nav>
        
        <div className="app-sidebar__spacer" />
        
        <div className="app-sidebar__user">
          <div className="app-sidebar__avatar">
            {user.email.charAt(0).toUpperCase()}
          </div>
          <div className="app-sidebar__email" title={user.email}>
            {user.email}
          </div>
        </div>
      </aside>
      
      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
