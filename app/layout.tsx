import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "松音 SONGYIN｜Colab H3 創作室",
  description: "鳥巢的私人 AI 影音創作室。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
