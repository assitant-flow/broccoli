import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Broccoli · 云端 AI 开发平台",
  description: "多项目、多需求、持续协作 —— 把成串需求托付给 AI，只在需要决策时被通知",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="orbs" />
        {children}
      </body>
    </html>
  );
}
