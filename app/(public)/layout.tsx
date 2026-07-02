import React from "react";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { NavigationProgress } from "@/components/marketing/visuals/NavigationProgress";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#FBFAFC] text-[#0F172A] font-manrope selection:bg-[#FF6A00]/20 selection:text-[#0F172A]">
      {/* CSS scroll progress bar — decorative, aria-hidden */}
      <div className="landing-scroll-progress" aria-hidden="true" />

      <Navbar />
      <NavigationProgress />

      <main id="main-content" className="flex-1 flex flex-col" tabIndex={-1}>
        {children}
      </main>

      <Footer />
    </div>
  );
}
