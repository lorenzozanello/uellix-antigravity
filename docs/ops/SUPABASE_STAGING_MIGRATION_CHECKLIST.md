# Checklist de Migración y Políticas RLS - Supabase Staging

> [!IMPORTANT]
> Este checklist fue completado en el entorno de staging de Supabase. El estado actual está **COMPLETADO**.

## 1. Migraciones en Orden (Drizzle Kit)
Las siguientes migraciones deben correrse en orden utilizando `DATABASE_URL` del entorno staging:
1. `0000_quick_husk.sql`
2. `0001_noisy_chameleon.sql`
3. `0002_huge_namorita.sql`
4. `0003_curvy_tempest.sql`
5. `0004_thick_mentor.sql`
6. `0005_daffy_dreaming_celestial.sql`
7. `0006_outstanding_vindicator.sql`
## 2. Políticas SQL RLS y Seguridad (Acción Humana)
Una vez aplicadas las migraciones, se debe ejecutar el script de políticas RLS:
* Archivo: `db/policies/001_initial_auth_rls.sql`

## 3. Orden Recomendado de Aplicación
1. **Backup/Snapshot**: Tomar un snapshot/backup de la base de datos de staging.
2. **Aplicar Migraciones**: Correr `pnpm db:migrate` apuntando a staging.
3. **Aplicar RLS**: Copiar el contenido de `db/policies/001_initial_auth_rls.sql` y ejecutarlo en el SQL Editor de Supabase.
4. **Validar Constraints**: Confirmar que la restricción `role_check` y el índice único parcial `user_single_active_membership` estén creados.
5. **Verificación Funcional**: Probar los flujos de login, onboarding de organización y visualización del panel administrativo (`/admin`).

## 4. Riesgos Identificados
* **DATABASE_URL Incorrecta**: Apuntar accidentalmente a producción o desarrollo local.
* **Incompatibilidad de Orden**: Aplicar el archivo SQL de RLS antes de correr las migraciones causará errores ya que depende de nuevas columnas (`is_super_admin` en `users`) y restricciones en `organization_members`.
* **RLS Inactivo**: Olvidar habilitar o comprobar que RLS está activo en las tablas modificadas de staging.
