// components/ui/card.tsx
import React, { ReactNode } from 'react';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`p-4 pt-5 ${className}`}>{children}</div>;
}

export function CardTitle({ className = '', children }: { className?: string; children: ReactNode }) {
  return <h3 className={`text-lg font-semibold ${className}`}>{children}</h3>;
}

export function CardContent({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`p-4 pt-0 ${className}`}>{children}</div>;
}
