# 🚀 Project Lifecycle Management - Migration Instructions

## Migration Details

**Migration ID:** `0024_outstanding_enchantress.sql`  
**Date:** 2026-07-06  
**Changes:**
- Added `paused` status to projects enum
- Added soft delete columns (6 new fields)
- Added consistency constraints
- Added audit indexes

## How to Apply

### Option A: Automatic (Recommended for Vercel)

The migration will be applied automatically when you deploy to Vercel since the migration file is committed to the repository.

**Status:** ✅ Ready for auto-deploy

### Option B: Manual via Supabase Dashboard

1. Go to: https://supabase.com → Your Project → SQL Editor
2. Copy the migration SQL from: `db/migrations/0024_outstanding_enchantress.sql`
3. Paste into the SQL Editor
4. Click **RUN** to execute

### Option C: Supabase CLI (if installed)

```bash
npx supabase db push
```

## Verification

After applying, verify the migration succeeded:

```sql
-- Check if migration was applied
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'projects' 
AND column_name IN (
  'deletion_requested_at', 'deletion_requested_by', 'deletion_reason',
  'deleted_at', 'deleted_by', 'delete_reason'
);

-- Check status enum
SELECT enum_range(NULL::projects_status_enum);
```

## What Changed in the Database

### New Columns
```
deletion_requested_at  | timestamp   | When deletion was requested
deletion_requested_by  | uuid (FK)   | User who requested deletion
deletion_reason        | text        | Reason for deletion request
deleted_at            | timestamp   | When deletion was approved
deleted_by            | uuid (FK)   | SuperAdmin who approved deletion
delete_reason         | text        | Reason for approval
```

### Updated Enum
```
status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
                           ↑ NEW
```

### New Constraints
```
- deletion_request_consistency_check: Both all-null or all-present
- deletion_consistency_check: Both all-null or all-present
```

### New Indexes
```
- idx_projects_deletion_requested_at (for pending deletion queries)
- idx_projects_deleted_at (for soft-deleted queries)
```

## RLS Policies

**No new RLS policies needed.** Existing `projects_update_allowed_roles` policy covers soft delete columns.

## Rollback (if needed)

To rollback this migration, run:

```sql
ALTER TABLE "projects" DROP CONSTRAINT "deletion_consistency_check";
ALTER TABLE "projects" DROP CONSTRAINT "deletion_request_consistency_check";
ALTER TABLE "projects" DROP INDEX "idx_projects_deleted_at";
ALTER TABLE "projects" DROP INDEX "idx_projects_deletion_requested_at";
ALTER TABLE "projects" DROP COLUMN "delete_reason";
ALTER TABLE "projects" DROP COLUMN "deleted_by";
ALTER TABLE "projects" DROP COLUMN "deleted_at";
ALTER TABLE "projects" DROP COLUMN "deletion_reason";
ALTER TABLE "projects" DROP COLUMN "deletion_requested_by";
ALTER TABLE "projects" DROP COLUMN "deletion_requested_at";
ALTER TABLE "projects" DROP CONSTRAINT "status_check";
ALTER TABLE "projects" ADD CONSTRAINT "status_check" CHECK ("status" IN ('draft', 'active', 'completed', 'archived'));
```

## Next Steps

1. ✅ Commit pushed to `feature/sprint-0-foundation`
2. ⏳ Apply migration (manual or auto-deploy)
3. 🧪 Test lifecycle features in staging/prod
4. 📊 Monitor audit_logs table for deletion tracking

## Testing Checklist

- [ ] Pause active project
- [ ] Resume paused project
- [ ] Archive project
- [ ] Request deletion (test eligibility validation)
- [ ] Approve deletion as SuperAdmin
- [ ] Query deleted projects: `WHERE deleted_at IS NOT NULL`
- [ ] Verify audit trail is recorded

---

**Questions?** See `docs/project-lifecycle.md` for user documentation.
