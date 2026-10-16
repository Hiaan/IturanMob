import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AppProviders } from "@/components/providers/app-providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Finance AI", template: "%s · Finance AI" },
  description: "Gestão financeira familiar inteligente, com registro pelo WhatsApp.",
  applicationName: "Finanças",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Finanças", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  // iOS anteriores ao 16.4 ainda olham esta meta (o Next 15 só gera a versão sem "apple-").
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#060d1a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh font-sans">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
