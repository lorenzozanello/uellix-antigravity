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
    { name: 'Evidencias', href: './evidence' },
    { name: 'Trust Center', href: '/trust-center' },
  ];
  return (
    <nav className="flex space-x-4 mb-4">
      {steps.map((s) => (
        <Link
          key={s.name}
          href={s.href}
          className={
            pathname?.endsWith(s.href.replace('.', ''))
              ? 'font-bold underline text-teal-600'
              : 'text-gray-600 hover:text-teal-500'
          }
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}
