import { pgTable, uuid, text, timestamp, varchar, jsonb } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().notNull(), // References auth.users
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }),
  avatarUrl: varchar('avatar_url', { length: 255 }),
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
  role: varchar('role', { length: 50 }).notNull(), // 'SuperAdmin', 'OrgAdmin', 'ImpactManager', 'Analyst', 'Reviewer', 'Viewer'
  status: varchar('status', { length: 50 }).default('active').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id),
  joinedAt: timestamp('joined_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

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
