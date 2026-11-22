import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import "@/lib/ma-fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: process.env.APP_NAME ?? "MACS",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
