import type { Metadata, Viewport } from "next";
import { DM_Mono, DM_Sans, Instrument_Serif } from "next/font/google";
import ServiceWorker from "@/components/ServiceWorker";
import "./globals.css";

const display = Instrument_Serif({ subsets: ["latin", "latin-ext"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const body = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-dm-sans" });
const mono = DM_Mono({ subsets: ["latin", "latin-ext"], weight: ["400"], variable: "--font-dm-mono" });

export const metadata: Metadata = {
  title: "Mesa — live interpreter for your table",
  description:
    "Everyone speaks their own language — English, Polish or Spanish — and hears everyone else live in theirs, through their own phone and headset.",
  applicationName: "Mesa",
  appleWebApp: { capable: true, title: "Mesa", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f0d0b" },
    { media: "(prefers-color-scheme: light)", color: "#f6f2ec" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
