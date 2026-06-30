# Checklist de Migración y Políticas RLS - Supabase Staging

> [!IMPORTANT]
> Sprint 7 completado en Supabase Staging. Main commit: e0605b1. Smoke test aprobado. Producción pendiente.

## 1. Migraciones en Orden (Drizzle Kit)
Las siguientes migraciones deben correrse en orden utilizando `DATABASE_URL` del entorno staging:
1. `0000_quick_husk.sql`
2. `0001_noisy_chameleon.sql`
3. `0002_huge_namorita.sql`
4. `0003_curvy_tempest.sql`
5. `0004_thick_mentor.sql`
6. `0005_daffy_dreaming_celestial.sql`
7. `0006_outstanding_vindicator.sql`
8. `0007_black_imperial_guard.sql`
9. `0008_bored_pretty_boy.sql`
10. `0009_motionless_peter_parker.sql` (COMPLETADO en Staging)
11. `0010_crazy_warhawk.sql` (COMPLETADO en Staging)
12. `0011_sroi_results_report_foundation.sql` (APLICADO en Staging - Sprint 7)

## 2. Políticas SQL RLS y Seguridad (Acción Humana)
Una vez aplicadas las migraciones, se debe ejecutar el script de políticas RLS:
* Archivo: `db/policies/001_initial_auth_rls.sql` (RE-APLICADO en Staging - Sprint 7)

## 3. Orden Recomendado de Aplicación

### Sprint 6 (Completado)
1. **Backup/Snapshot**: Tomar un snapshot/backup de la base de datos de staging. ✅
2. **Aplicar Migraciones**: Correr `pnpm db:migrate` apuntando a staging. ✅
3. **Aplicar RLS**: Copiar el contenido de `db/policies/001_initial_auth_rls.sql` y ejecutarlo en el SQL Editor de Supabase. ✅
4. **Validar Constraints**: Confirmar que la restricción `role_check` y el índice único parcial `user_single_active_membership` estén creados. ✅
5. **Verificación Funcional**: Probar los flujos de login, onboarding de organización y visualización del panel administrativo (`/admin`). ✅

### Sprint 7 (Completado en Staging)
1. **Aplicar Migración 0011**: `0011_sroi_results_report_foundation.sql` - Crea 4 nuevas tablas (sroi_run_reviews, sroi_run_review_items, sroi_reports, sroi_report_sections). ✅
2. **Reaplicar RLS**: `db/policies/001_initial_auth_rls.sql` - RLS para nuevas tablas. ✅
3. **Validar SQL**: Confirmar que las 4 nuevas tablas existen y tienen RLS activo. ✅
4. **Smoke Test**: ✅ Aprobado - Validación funcional de reports, reviews, comparación en staging completada.

### Sprint 7 Smoke Test Checklist (Completado)
- ✅ Run detail page: muestra metadata, version, status, SROI metrics, snapshots, copy de auditoría
- ✅ Metodological review: crear revisión humana desde UI, inserta en sroi_run_reviews, registra audit log
- ✅ Compare: selecciona dos corridas, muestra deltas, aviso de currency, no persiste, no FX conversion
- ✅ Report list: crea draft desde corrida, inserta en sroi_reports y sroi_report_sections, crea secciones iniciales
- ✅ Report editor: edita secciones, actualiza BD, bloquea reporte, enforza read-only cuando locked
- ✅ RLS sanity: consultas autorizadas funcionan, sin service role, organizationId no desde cliente, sin hard delete
- ✅ Regresión Sprint 6: cálculo SROI sigue funcionando, determinístico, preview/history ok
- ✅ Límites metodológicos: no certificación automática, no IA, no FX, no PDF/export, audit-ready foundation presente


## 4. Riesgos Identificados
* **DATABASE_URL Incorrecta**: Apuntar accidentalmente a producción o desarrollo local.
* **Incompatibilidad de Orden**: Aplicar el archivo SQL de RLS antes de correr las migraciones causará errores ya que depende de nuevas columnas (`is_super_admin` en `users`) y restricciones en `organization_members`.
* **RLS Inactivo**: Olvidar habilitar o comprobar que RLS está activo en las tablas modificadas de staging.
