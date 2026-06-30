// components/sroi/StellaPlaceholder.tsx
export default function StellaPlaceholder({ step }: { step: string }) {
  return (
    <div className="border border-dashed rounded p-2 my-4 bg-gray-50 text-sm text-gray-600">
      <strong>Stella Advisor (placeholder)</strong> – {step}
      <p className="mt-1">Esta sección guía al usuario sobre qué información proporcionar y por qué es importante para el análisis SROI. No hay validación automática ni interacción con IA en este momento.</p>
    </div>
  );
}
