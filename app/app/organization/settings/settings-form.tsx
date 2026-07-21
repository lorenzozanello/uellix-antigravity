'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateOrganizationSettings } from '@/app/actions/organization';
import { Palette, Link as LinkIcon, Building2 } from 'lucide-react';
import { getErrorMessage } from '@/lib/errors/get-error-message';

export function SettingsForm({
  initialData,
  canEdit
}: {
  initialData: { whiteLabelEnabled: boolean; brandColor: string; logoUrl: string };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;

    setIsSaving(true);
    setError(null);
    setSuccess(false);

    try {
      await updateOrganizationSettings({
        whiteLabelEnabled: formData.whiteLabelEnabled,
        brandColor: formData.whiteLabelEnabled ? formData.brandColor : undefined,
        logoUrl: formData.whiteLabelEnabled ? formData.logoUrl : undefined,
      });
      setSuccess(true);
      router.refresh();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Error al guardar la configuración'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-2xl">
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Marca Blanca (White-label)</h2>
              <p className="text-sm text-slate-500">
                Personaliza los reportes PDF generados con el logotipo y color corporativo de tu organización.
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="whiteLabelEnabled" className="text-sm font-medium text-slate-900">
                Habilitar Marca Blanca
              </label>
              <p className="text-sm text-slate-500">
                Reemplazar el branding de Uellix por el de tu organización en reportes y enlaces públicos.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              id="whiteLabelEnabled"
              aria-checked={formData.whiteLabelEnabled}
              disabled={!canEdit || isSaving}
              onClick={() => setFormData(s => ({ ...s, whiteLabelEnabled: !s.whiteLabelEnabled }))}
              className={`${
                formData.whiteLabelEnabled ? 'bg-indigo-600' : 'bg-slate-200'
              } relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 disabled:opacity-50`}
            >
              <span
                aria-hidden="true"
                className={`${
                  formData.whiteLabelEnabled ? 'translate-x-5' : 'translate-x-0'
                } pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
              />
            </button>
          </div>

          {formData.whiteLabelEnabled && (
            <div className="pt-4 border-t border-slate-100 grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="brandColor" className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <Palette className="w-4 h-4 text-slate-500" />
                  Color Principal
                </label>
                <div className="flex gap-3">
                  <input
                    type="color"
                    id="brandColorPicker"
                    disabled={!canEdit || isSaving}
                    value={formData.brandColor}
                    onChange={(e) => setFormData(s => ({ ...s, brandColor: e.target.value }))}
                    className="h-10 w-14 rounded cursor-pointer border border-slate-300 p-1 bg-white disabled:opacity-50"
                  />
                  <input
                    type="text"
                    id="brandColor"
                    disabled={!canEdit || isSaving}
                    value={formData.brandColor}
                    onChange={(e) => setFormData(s => ({ ...s, brandColor: e.target.value }))}
                    pattern="^#[0-9a-fA-F]{6}$"
                    placeholder="#FFFFFF"
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                  />
                </div>
                <p className="text-xs text-slate-500">Color en formato Hex (ej. #1e293b)</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="logoUrl" className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <LinkIcon className="w-4 h-4 text-slate-500" />
                  URL del Logotipo en Supabase Storage
                </label>
                <input
                  type="url"
                  id="logoUrl"
                  disabled={!canEdit || isSaving}
                  value={formData.logoUrl}
                  onChange={(e) => setFormData(s => ({ ...s, logoUrl: e.target.value }))}
                  placeholder="https://tu-proyecto.supabase.co/storage/v1/object/public/branding/logo.png"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <p className="text-xs text-slate-500">Debe ser un enlace HTTPS público del Supabase Storage configurado para Uellix.</p>
              </div>
            </div>
          )}
        </div>

        {canEdit && (
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
            <div className="text-sm">
              {error && <span className="text-red-600">{error}</span>}
              {success && <span className="text-green-600 font-medium">¡Configuración guardada!</span>}
            </div>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex justify-center rounded-md bg-[#FF6A00] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#E65C00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] disabled:opacity-50"
            >
              {isSaving ? 'Guardando...' : 'Guardar Cambios'}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
