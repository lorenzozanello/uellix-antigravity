# 11 — Flujo GitHub + Vercel

## Principio

GitHub es la fuente de verdad. Vercel es el entorno de previews y producción.

## Repositorio

Crear un repositorio nuevo y limpio.

Nombre sugerido:
```txt
uellix
```

## Rama principal

```txt
main
```

## Ramas de trabajo

Formato:

```txt
feature/sprint-0-foundation
feature/sroi-pipeline
feature/trust-layer
feature/stella-engine
feature/proxy-intelligence
fix/auth-rls
chore/docs-update
```

## Reglas

1. No trabajar directo en `main`.
2. No hacer commits gigantes.
3. No mezclar cambios no relacionados.
4. No borrar archivos sin justificar.
5. No modificar arquitectura sin documentar.
6. No hacer merge sin build exitoso.
7. No desplegar producción sin revisión humana.
8. Todo sprint debe tener resumen final.

## Flujo recomendado

```txt
Crear rama
→ implementar cambios
→ ejecutar validaciones
→ commit
→ push
→ pull request
→ Vercel preview
→ revisión humana
→ merge a main
→ deploy producción
```

## Commits

Formato sugerido:

```txt
feat: add project creation flow
fix: enforce organization-level access
chore: configure drizzle
docs: update trust layer spec
```

## Pull Requests

Cada PR debe incluir:

- objetivo;
- cambios principales;
- capturas si aplica;
- comandos ejecutados;
- riesgos;
- URL de preview;
- checklist de seguridad.

## Checklist PR

```md
- [ ] No trabajé directo sobre main.
- [ ] Ejecuté lint.
- [ ] Ejecuté typecheck.
- [ ] Ejecuté test.
- [ ] Ejecuté build.
- [ ] Revisé permisos.
- [ ] Revisé RLS si aplica.
- [ ] No agregué secretos.
- [ ] Actualicé docs si cambié arquitectura.
- [ ] Validé preview de Vercel.
```

## Vercel

Configurar:
- conexión GitHub;
- previews por PR;
- variables de entorno;
- producción desde main.

## Variables de entorno

Mantener `.env.example` actualizado.

No subir `.env.local`.

## Protección de main

Cuando el repo esté listo, activar:
- PR obligatorio;
- checks obligatorios;
- no force push;
- revisión antes de merge.

## Sprint report

Cada sprint debe terminar con:

```md
## Sprint Summary

### Objetivo
### Cambios realizados
### Archivos modificados
### Validaciones ejecutadas
### Riesgos
### Preview
### Pendientes
### Próximo paso recomendado
```
