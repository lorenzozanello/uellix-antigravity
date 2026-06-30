# Uellix Design System — Sprint 8A Foundation

**Status:** Foundation (Sprint 8A)  
**Last Updated:** 2026-06-25  
**Maintainer:** Design System Team

---

## 1. Design Philosophy

Uellix is an **enterprise SaaS platform** for impact measurement. The design system prioritizes:

- **Institutional trust** — professional, consistent, audit-ready aesthetic
- **Clarity** — information hierarchy, accessibility, no visual confusion
- **Accessibility** — WCAG AA minimum, focus states, semantic HTML
- **Responsiveness** — mobile-first, but desktop-optimized for data-dense views
- **Reusability** — component library reduces duplication and ensures consistency

---

## 2. Color Palette

### Base Neutrals (Light Mode)
```
--color-neutral-50:   #FAFAFA (nearly white)
--color-neutral-100:  #F5F5F5 (very light)
--color-neutral-200:  #EBEBEB (light)
--color-neutral-300:  #E0E0E0 (light gray)
--color-neutral-400:  #C0C0C0 (medium light)
--color-neutral-500:  #808080 (medium)
--color-neutral-600:  #606060 (medium dark)
--color-neutral-700:  #404040 (dark)
--color-neutral-800:  #353535 (darker)
--color-neutral-900:  #242424 (nearly black)
```

### Institutional Teal (Primary)
```
--color-teal-primary:    #0d9488 (primary action)
--color-teal-light:      #14b8a6 (hover state, secondary)
--color-teal-dark:       #0f766e (active state, emphasis)
```

**Usage:**
- Primary actions (buttons, nav highlights)
- Accent color for badges
- Focus rings

### Status Colors
```
Success:  oklch(0.671 0.17 142.5)  / Light: oklch(0.944 0.08 142.5)
Warning:  oklch(0.826 0.19 70)     / Light: oklch(0.977 0.08 70)
Danger:   oklch(0.704 0.191 22.216) / Light: oklch(0.944 0.08 22.216)
Info:     oklch(0.704 0.191 250)   / Light: oklch(0.944 0.08 250)
```

**Usage:**
- Status badges (calculated, pending, error)
- Inline alerts (success, warning, error)
- Data visualization
- NOT for primary actions (use teal only)

---

## 3. Typography Scale

### Headings
```
H1: text-4xl font-bold tracking-tight (page title)
H2: text-2xl font-semibold tracking-tight (section title)
H3: text-lg font-semibold (subsection / card title)
H4: text-base font-semibold (labels, form groups)
```

### Body Text
```
Body: text-sm (main content)
Caption: text-xs (helper text, meta)
Monospace: font-mono (IDs, hashes, code)
```

### Font Families
```
--font-sans: Geist, system-ui, sans-serif (default)
--font-mono: Geist Mono, Monaco, monospace (code, IDs)
--font-heading: (optional, defaults to --font-sans)
```

---

## 4. Spacing (8px Grid)

```
xs:  0.5rem  (4px)
sm:  1rem    (8px)
md:  1.5rem  (12px)
lg:  2rem    (16px)
xl:  3rem    (24px)
2xl: 4rem    (32px)
```

**Padding:**
- Cards: `p-4` (16px) or `p-6` (24px)
- Form fields: `px-3 py-2` (12px / 8px)
- Sections: `p-8` (32px) or `px-6 py-8`

**Gaps:**
- Nav, flex rows: `gap-4` (16px)
- Lists, tight layouts: `gap-2` or `gap-3`

---

## 5. Border Radius

```
--radius-sm:   calc(var(--radius) * 0.6)  ≈ 4px
--radius-md:   calc(var(--radius) * 0.8)  ≈ 5px
--radius-lg:   var(--radius)               ≈ 10px
--radius-xl:   calc(var(--radius) * 1.4)  ≈ 14px
--radius-2xl:  calc(var(--radius) * 1.8)  ≈ 18px
--radius-3xl:  calc(var(--radius) * 2.2)  ≈ 22px
--radius-4xl:  calc(var(--radius) * 2.6)  ≈ 26px
```

**Conventions:**
- Buttons: `rounded-md` (5px, compact)
- Cards: `rounded-lg` (10px, medium)
- Large containers: `rounded-xl` (14px, generous)

---

## 6. Components

### Button Variants

```tsx
<Button variant="default">Save</Button>       // Teal, primary action
<Button variant="secondary">Cancel</Button>   // Neutral, secondary action
<Button variant="outline">View More</Button>  // Border, tertiary action
<Button variant="ghost">Learn more</Button>   // Minimal, links/help
<Button variant="destructive">Delete</Button> // Red, destructive actions
<Button variant="link">Inline link</Button>   // Pure text link
```

**Rules:**
- Primary action per page: 1x `variant="default"`
- No multiple teal buttons (use secondary for others)
- Danger actions MUST be red (`variant="destructive"`)
- NO emerald, no ad-hoc colors on buttons

**Focus States:**
```
All buttons: focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
```

**Sizing:**
```
xs:  h-6 text-xs  (small, compact)
sm:  h-7 text-sm  (default small)
default: h-8 text-sm (recommended default)
lg:  h-9 text-base (large, emphasis)
icon: size-8       (icon buttons)
icon-sm: size-7    (small icon)
```

### Badge Variants

```tsx
<Badge variant="neutral">Draft</Badge>     // Gray
<Badge variant="info">Pending</Badge>      // Blue
<Badge variant="success">Approved</Badge>  // Green
<Badge variant="warning">Review</Badge>    // Yellow
<Badge variant="danger">Error</Badge>      // Red
<Badge variant="teal">Active</Badge>       // Teal (secondary)
```

**Rules:**
- Status meanings MUST use consistent badge colors (not ad-hoc HTML)
- Badges MUST include icon + text (not color-only, colorblind accessibility)
- Examples:
  ```
  ✓ Approved (green badge + checkmark icon)
  ✗ Error (red badge + X icon)
  ⏱ Pending (blue badge + clock icon)
  ```

### Card Layout

```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
  </CardHeader>
  <CardContent>Content here</CardContent>
</Card>
```

**Styling:**
- Background: `bg-card` (white in light, dark gray in dark mode)
- Border: `border border-border`
- Shadow: `shadow-sm` (subtle, not heavy)
- Padding: Header 16-20px, Content 16px

---

## 7. Form Components

### Text Input / Select / Textarea

```tsx
<input
  className="rounded-md border border-input bg-background px-3 py-2 text-sm
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
             focus-visible:ring-offset-2"
/>

<Select>
  <SelectTrigger>...</SelectTrigger>
  <SelectContent>...</SelectContent>
</Select>
```

**Rules:**
- ALL form inputs use styled select component (NOT bare HTML `<select>`)
- Labels MUST be visible above input (not placeholder-only)
- Required indicators: `<span className="text-danger">*</span>` after label
- Error state: `aria-invalid="true" aria-describedby="error-id"`
- Help text below: `<p id="help-id" className="text-xs text-muted-foreground">Help</p>`

### Example Form Block
```tsx
<div className="space-y-4">
  <div>
    <label htmlFor="email" className="block text-sm font-medium">
      Email <span className="text-danger">*</span>
    </label>
    <input
      id="email"
      type="email"
      required
      aria-required="true"
      aria-describedby="email-error"
      className="mt-1 block w-full rounded-md border border-input..."
    />
    <p id="email-error" className="mt-1 text-xs text-danger hidden">
      Please enter a valid email
    </p>
  </div>
</div>
```

---

## 8. Table Component

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Column 1</TableHead>
      <TableHead>Column 2</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>Data 1</TableCell>
      <TableCell>Data 2</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

**Responsive Behavior:**
- Mobile (<640px): Table scrolls horizontally (guard in component)
- Tablet (640-1024px): Smaller font, compact padding
- Desktop (>1024px): Full spacing, sticky header

**Best Practices:**
- Header: bold, muted background, 10px padding
- Rows: alternate hover state, 1px border bottom
- Cells: 16px padding, left-aligned (numbers right-aligned)
- Truncated text: ellipsis + tooltip (future: use `title` attr)
- Status columns: Use Badge component (not inline text)

---

## 9. Empty / Loading / Error States

### EmptyState
```tsx
<EmptyState
  icon={<BoxIcon />}
  title="No projects found"
  description="Create a new project to get started."
  action={{
    label: "Create Project",
    onClick: () => navigate('/new')
  }}
/>
```

**Styling:** Border, dashed pattern optional, centered icon/text, CTA button

### LoadingState
```tsx
<LoadingState message="Calculating SROI..." variant="spinner" />
// or
<LoadingState variant="skeleton" />  // Skeleton lines
```

**Styling:** Spinner (animated border) or skeleton (shimmer placeholder)

### ErrorState
```tsx
<ErrorState
  title="Calculation failed"
  message="An error occurred while processing your request."
  details="Error code: CALC_500"
  action={{
    label: "Try Again",
    onClick: () => retry()
  }}
/>
```

**Styling:** Red border, red icon, alert role, optional technical details

---

## 10. Accessibility Requirements

### Focus States (CRITICAL)
```tsx
// All interactive elements MUST have visible focus:
focus-visible:outline-2 focus-visible:outline-offset-2 outline-ring
// Or for buttons:
focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
```

### Touch Targets (CRITICAL)
```
Minimum 44×44px for mobile
Buttons: at least h-7 (28px height) or h-8 (32px) with padding
Form controls: h-8 (32px) minimum
```

### Color & Contrast
```
Text on background: WCAG AA minimum (4.5:1 for normal text, 3:1 for large)
Use --color-neutral-* tokens to ensure contrast
Test with WebAIM contrast checker
```

### Labels & ARIA
```
Form inputs: <label htmlFor="id">Label</label> (visible, not hidden)
Required: aria-required="true" + visual indicator (*)
Invalid: aria-invalid="true" + aria-describedby for error message
Buttons: aria-label for icon-only buttons
Alerts: role="alert" for live region updates
```

### Semantic HTML
```
<button type="button|submit|reset"> (not <div onclick>)
<form> for form groups
<nav> for navigation sections
<section>, <article> for content grouping
<main> for main content
<header>, <footer> for page regions
```

---

## 11. Do's and Don'ts

### ✅ DO:
- Use design tokens from globals.css (--color-*, --radius, --font-*)
- Use component library (Button, Card, Badge, Table, etc.)
- Follow 8px spacing grid consistently
- Test focus states with keyboard navigation
- Use semantic HTML and ARIA labels
- Group related form fields visually
- Use consistent badge colors for statuses
- Verify color contrast (WCAG AA minimum)
- Include loading and empty states

### ❌ DON'T:
- Create inline colors (no `bg-slate-950`, `text-teal-400`, etc.)
- Use emerald, indigo, or ad-hoc color names
- Create custom button styles (use Button component with variants)
- Skip focus states or accessibility labels
- Use color alone to convey meaning (add icons, text, badges)
- Create multiple primary buttons on same page
- Use placeholder as label (always use visible label)
- Hardcode shadows, use Tailwind shadow utilities only
- Create inconsistent status badge colors
- Mix light/dark banners without clear hierarchy
- Use bare `<select>` HTML elements
- Skip error messages or validation feedback

---

## 12. Migration Guide (Sprint 8+)

**Phase 1 (Sprint 8A):** Foundation only, no page refactors
**Phase 2 (Sprint 8B):** Update layout, shell, breadcrumbs
**Phase 3 (Sprint 8C+):** Apply tokens to all pages sequentially

### How to Apply Tokens to a Page:

1. Replace hardcoded colors with CSS variables:
   ```tsx
   // Before:
   <div className="bg-slate-950 text-teal-400">

   // After:
   <div className="bg-background text-primary">
   ```

2. Replace status badges with Badge component:
   ```tsx
   // Before:
   <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-800">Draft</span>

   // After:
   <Badge variant="warning">Draft</Badge>
   ```

3. Use Button component variants:
   ```tsx
   // Before:
   <button className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded">

   // After:
   <Button variant="default">Action</Button>
   ```

4. Use Table component for data:
   ```tsx
   // Before:
   <table className="min-w-full divide-y divide-slate-800">

   // After:
   <Table>...</Table>
   ```

---

## 13. Component Library Inventory

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Button | `components/ui/button.tsx` | ✅ Complete | 6 variants, 5 sizes |
| Card | `components/ui/card.tsx` | ✅ Complete | Header, Title, Content |
| Badge | `components/ui/badge.tsx` | ✅ Complete | 6 variants for status |
| Select | `components/ui/select.tsx` | ✅ Complete | Radix-based, styled |
| Table | `components/ui/table.tsx` | ✅ Complete | Responsive wrapper |
| EmptyState | `components/states/EmptyState.tsx` | ✅ Complete | Icon, title, action |
| LoadingState | `components/states/LoadingState.tsx` | ✅ Complete | Spinner or skeleton |
| ErrorState | `components/states/ErrorState.tsx` | ✅ Complete | Alert styling |
| Input | `components/ui/input.tsx` | ⏳ To Review | Use CSS var approach |
| Label | `components/ui/label.tsx` | ⏳ To Review | Ensure visible always |
| Breadcrumb | Not yet | 📋 Sprint 8B | Global navigation |
| Accordion | Not yet | 📋 Sprint 8B | Calculation page |
| Tabs | Not yet | 📋 Sprint 8B | Report editor |
| Stepper | Existing | 📋 Sprint 8C | Visual progress |

---

## 14. Reference: OKLCH Color Space

Uellix uses OKLCH for precise, perceptually uniform colors:

```
oklch(lightness chroma hue)

Examples:
oklch(0.671 0.17 142.5)  // Success (green)
oklch(0.704 0.191 22.216) // Danger (red)
oklch(0.826 0.19 70)      // Warning (yellow)
```

Benefits: Consistent brightness across hues, better dark mode support, accessible color mixing.

---

## 15. Questions & Support

- **Color guidance:** Check `app/globals.css` for all semantic variables
- **Component questions:** Refer to component file JSDoc comments
- **Accessibility:** See section 10, or consult WCAG 2.1 Level AA
- **Design tokens:** Update `app/globals.css` only (not inline Tailwind)

---

**Last updated:** 2026-06-25  
**Next review:** Sprint 8B (Layout & Navigation)
