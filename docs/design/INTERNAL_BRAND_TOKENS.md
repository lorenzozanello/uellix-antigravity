# Uellix Internal App Brand Tokens

## Sprint 11A Foundation

This document records the design system tokens connected to the Uellix brand palette for the authenticated product (UI inside `/app/**`).

### Objective

Sprint 11A establishes the token foundation for brand alignment without redesigning pages. Future sprints (11B–11H) will migrate component visuals to use these tokens, moving the product from teal-dominated MVP appearance to premium civic-tech aesthetic.

### Brand Palette

| Name | Hex | OKLCH | Purpose |
|------|-----|-------|---------|
| Azul Profundo | `#0F172A` | `oklch(0.145 0.024 264)` | Primary: headings, sidebar, deep sections |
| Naranja Impacto | `#FF6A00` | `oklch(0.65 0.23 38)` | Accent: active states, CTAs, highlights |
| Gris Medio | `#64748B` | `oklch(0.556 0.02 264)` | Muted foreground: labels, secondary text |
| Gris Claro | `#E2E8F0` | `oklch(0.922 0.001 264)` | Border: separators, lines |
| Niebla | `#FBFAFC` | `oklch(0.993 0.002 264)` | Background: app surface |

### Connected Tokens (Light Mode)

```css
:root {
  /* Azul Profundo */
  --primary: oklch(0.145 0.024 264);
  --primary-foreground: oklch(0.985 0 0);
  
  /* Naranja Impacto */
  --accent: oklch(0.65 0.23 38);
  --accent-foreground: oklch(1 0 0);
  --ring: oklch(0.65 0.23 38);  /* Focus ring color */
  
  /* Niebla */
  --background: oklch(0.993 0.002 264);
  
  /* Gris Claro */
  --border: oklch(0.922 0.001 264);
  --input: oklch(0.922 0.001 264);
  
  /* Gris Medio */
  --muted-foreground: oklch(0.556 0.02 264);
  
  /* Sidebar: prepared for Azul Profundo + Naranja */
  --sidebar-accent: oklch(0.65 0.23 38 / 0.12);
  --sidebar-ring: oklch(0.65 0.23 38);
}
```

### Connected Tokens (Dark Mode)

```css
.dark {
  --primary: oklch(0.145 0.024 264);              /* Azul Profundo */
  --accent: oklch(0.65 0.23 38);                  /* Naranja Impacto */
  --ring: oklch(0.65 0.23 38);
  --sidebar: oklch(0.145 0.024 264);              /* Dark sidebar (Azul) */
  --sidebar-accent: oklch(0.65 0.23 38 / 0.12);  /* Naranja sutil */
}
```

### Badge Variants (NEW)

A new `accent` variant added to `components/ui/badge.tsx`:

```typescript
accent: 'bg-[#FF6A00]/10 text-[#FF6A00] dark:bg-[#FF6A00]/20 dark:text-[#FF6A00]',
```

Use this variant for high-visibility states: active projects, pending reviews, important flags. The `teal` variant remains temporarily for compatibility but is **deprecated** — new components should use `accent`.

### Explicit Uellix Tokens

The following tokens remain available for direct reference (e.g., by landing page):

```css
--uellix-deep:        #0F172A;
--uellix-orange:      #FF6A00;
--uellix-gray-mid:    #64748B;
--uellix-gray-light:  #E2E8F0;
--uellix-mist:        #FBFAFC;
```

### Pending Migration

The following components and pages must migrate to use these new accent colors in **future sprints**:

| Sprint | Scope |
|--------|-------|
| 11B | Sidebar, MobileNav, TopBar, Breadcrumbs |
| 11C | Stepper, PipelineStepHeader, Dashboard, Projects |
| 11D | Trust Center, evidence ledger styling |
| 11E | Calculation, RunDetail, Compare pages |
| 11F | Reports, impact deck styling |
| 11G | Pipeline steps content (narrative, stakeholders, etc.) |
| 11H | Typography (Sora, Manrope, IBM Plex Mono), responsive polish |

### Sprint 11H: Accessible Orange & Typography Utility

Sprint 11H introduced **Naranja Accesible** (`#B85200`) for small text links on light backgrounds, since `#FF6A00` at body/link text sizes falls short of WCAG AA contrast on `--background` (Niebla). The rule applied:

- **`#FF6A00` (Naranja Impacto)** stays on icon containers, badges, borders, and large brand elements (`bg-[#FF6A00]/10 text-[#FF6A00]` icon chips, `bg-[#FF6A00]` solid backgrounds with white text) — these are not small text-on-light-background cases.
- **`#B85200` (Naranja Accesible)** replaces `#FF6A00` wherever the color appears as small link/text color directly on `--background` or `--card` (e.g. "Open Pipeline →", "View all →", run/report detail links). Hover state uses `/80` opacity of the same token.

```css
--uellix-orange-accessible: #B85200; /* small text/links on light backgrounds */
```

Migrated in this sprint: `app/app/dashboard/page.tsx`, `app/app/projects/page.tsx`, `components/projects/ProjectCard.tsx`, `pipeline/calculation/page.tsx`, `pipeline/calculation/compare/page.tsx`, `report/page.tsx`, `report/[reportId]/page.tsx`.

Sprint 11H also retired remaining inline `style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}` usages in the files above in favor of the existing `font-ibm-plex-mono` utility class (already defined in `globals.css` `@layer utilities`, no new token added). Inline-style instances in `evidence`, `indicators`, `proxies`, and `calculation/runs/[runId]` pages are visually equivalent and were left as-is — deferred to a follow-up pass since they carry zero accessibility or functional impact, in order to keep this sprint's diff scoped to ≤10 files.

### Legacy Teal

The following **no longer** represents "Uellix primary":

```css
--color-teal-primary: #0d9488;  /* Legacy teal accent — pending migration */
```

**Do NOT use this in new components.** Existing pages that reference `teal` (63 occurrences in 20 files) will be migrated incrementally in future sprints.

### Stella Guardrails (Unchanged)

Stella disclaimer text and claim guardrails remain untouched in this sprint. Token changes are **visual only** — no impact on Stella logic, disclaimers, or SROI calculation.

### SROI Deterministic Engine (Unchanged)

`lib/pipeline/sroi-calculation.ts` is completely off-limits. No changes to calculation logic, inputs, outputs, or data models.

---

**Sprint 11A Status:** ✅ Foundation complete. Ready for 11B (App Shell).
