import { pgTable, uuid, text, timestamp, varchar, jsonb, boolean, unique, check, uniqueIndex, integer } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().notNull(), // References auth.users
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }),
  avatarUrl: varchar('avatar_url', { length: 255 }),
  isSuperAdmin: boolean('is_super_admin').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  legalName: varchar('legal_name', { length: 255 }),
  country: varchar('country', { length: 2 }),
  sector: varchar('sector', { length: 255 }),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: varchar('role', { length: 50 }).notNull(), // 'super_admin' | 'organization_admin' | 'impact_manager' | 'analyst' | 'reviewer' | 'viewer'
  status: varchar('status', { length: 50 }).default('active').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id),
  joinedAt: timestamp('joined_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  unique('organization_members_org_user_unique').on(table.organizationId, table.userId),
  uniqueIndex('user_single_active_membership').on(table.userId).where(sql`${table.status} = 'active'`),
  check('role_check', sql`${table.role} IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst', 'reviewer', 'viewer')`),
])

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  projectId: uuid('project_id'), // Will reference projects.id later
  actorUserId: uuid('actor_user_id').references(() => users.id),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  beforeJson: jsonb('before_json'),
  afterJson: jsonb('after_json'),
  reason: text('reason'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  invitedBy: uuid('invited_by').references(() => users.id).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  acceptedAt: timestamp('accepted_at'),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const portfolios = pgTable('portfolios', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('status_check', sql`${table.status} IN ('active', 'archived')`),
])

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  portfolioId: uuid('portfolio_id').references(() => portfolios.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  thematicArea: varchar('thematic_area', { length: 255 }),
  territory: varchar('territory', { length: 255 }),
  country: varchar('country', { length: 2 }),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  targetPopulationDescription: text('target_population_description'),
  status: varchar('status', { length: 50 }).default('draft').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('status_check', sql`${table.status} IN ('draft', 'active', 'completed', 'archived')`),
])

export const impactNarratives = pgTable('impact_narratives', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  narrativeText: text('narrative_text'),
  theoryOfChangeSummary: text('theory_of_change_summary'),
  assumptions: text('assumptions'),
  status: varchar('status', { length: 50 }).default('draft').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const stakeholderGroups = pgTable('stakeholder_groups', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const outcomes = pgTable('outcomes', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  stakeholderGroupId: uuid('stakeholder_group_id').references(() => stakeholderGroups.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  outcomeType: varchar('outcome_type', { length: 100 }),
  materialityNotes: text('materiality_notes'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const indicators = pgTable('indicators', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  outcomeId: uuid('outcome_id').references(() => outcomes.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  indicatorType: varchar('indicator_type', { length: 100 }),
  unit: varchar('unit', { length: 50 }),
  baselineValue: varchar('baseline_value', { length: 255 }),
  targetValue: varchar('target_value', { length: 255 }),
  actualValue: varchar('actual_value', { length: 255 }),
  dataSource: text('data_source'),
  measurementPeriod: varchar('measurement_period', { length: 100 }),
  confidenceLevel: varchar('confidence_level', { length: 50 }),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const evidenceItems = pgTable('evidence_items', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  outcomeId: uuid('outcome_id').references(() => outcomes.id),
  indicatorId: uuid('indicator_id').references(() => indicators.id),
  type: varchar('type', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  url: text('url'),
  filePath: text('file_path'),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 255 }),
  contentHash: varchar('content_hash', { length: 255 }),
  status: varchar('status', { length: 50 }).default('draft').notNull(),
  reviewerId: uuid('reviewer_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at'),
  reviewNotes: text('review_notes'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('evidence_items_type_check', sql`${table.type} IN ('file', 'url', 'text')`),
  check('evidence_items_status_check', sql`${table.status} IN ('draft', 'under_review', 'approved', 'rejected', 'archived')`),
])
