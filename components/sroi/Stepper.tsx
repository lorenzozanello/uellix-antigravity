"use client";

// components/sroi/Stepper.tsx
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Stepper() {
  const pathname = usePathname();
  const steps = [
    { name: 'Narrativa', href: './narrative' },
    { name: 'Stakeholders', href: './stakeholders' },
    { name: 'Outcomes', href: './outcomes' },
    { name: 'Indicadores', href: './indicators' },
  ];
  return (
    <nav className="flex space-x-4 mb-4">
      {steps.map((s) => (
        <Link
          key={s.name}
          href={s.href}
          className={
            pathname?.endsWith(s.href)
              ? 'font-bold underline'
              : 'text-gray-600'
          }
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}
