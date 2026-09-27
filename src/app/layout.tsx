import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Titife — Subscription Management",
  description: "Manage your subscription plan, billing, and payments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
