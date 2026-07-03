import { pgTable, uuid, text, timestamp, varchar, jsonb, boolean, unique, check, uniqueIndex, index, integer } from 'drizzle-orm/pg-core'
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
  // Stella usage quota: null = unlimited (internal/Uellix use only); 0 = blocked
  // (default — no plan assigned yet); N = monthly cap on Stella calls. Assigned
  // manually by a super_admin via /admin/services — no payment gateway.
  stellaMonthlyQuota: integer('stella_monthly_quota').default(0),
  stellaPlanLabel: varchar('stella_plan_label', { length: 100 }),
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
}, (table) => [
  // Admin global log viewer: ORDER BY created_at DESC LIMIT n
  index('idx_audit_logs_created_at').on(table.createdAt),
  index('idx_audit_logs_organization_id').on(table.organizationId),
])

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
}, (table) => [
  // acceptInvitation() looks up by raw token's SHA-256 on the accept path
  index('idx_invitations_token_hash').on(table.tokenHash),
  index('idx_invitations_organization_id').on(table.organizationId),
])

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
  index('idx_portfolios_organization_id').on(table.organizationId),
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
  index('idx_projects_organization_id').on(table.organizationId),
  index('idx_projects_portfolio_id').on(table.portfolioId),
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
}, (table) => [
  index('idx_impact_narratives_project_id').on(table.projectId),
])

export const stakeholderGroups = pgTable('stakeholder_groups', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_stakeholder_groups_project_id').on(table.projectId),
])

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
}, (table) => [
  index('idx_outcomes_project_id').on(table.projectId),
  index('idx_outcomes_stakeholder_group_id').on(table.stakeholderGroupId),
])

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
}, (table) => [
  index('idx_indicators_project_id').on(table.projectId),
  index('idx_indicators_outcome_id').on(table.outcomeId),
])

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
  index('idx_evidence_items_project_id').on(table.projectId),
  index('idx_evidence_items_organization_id').on(table.organizationId),
  index('idx_evidence_items_outcome_id').on(table.outcomeId),
  index('idx_evidence_items_indicator_id').on(table.indicatorId),
])

export const proxySources = pgTable('proxy_sources', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  url: text('url'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_proxy_sources_organization_id').on(table.organizationId),
])

export const financialProxies = pgTable('financial_proxies', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  sourceId: uuid('source_id').references(() => proxySources.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  proxyType: varchar('proxy_type', { length: 100 }),
  country: varchar('country', { length: 2 }),
  territory: varchar('territory', { length: 255 }),
  currency: varchar('currency', { length: 10 }),
  value: varchar('value', { length: 255 }),
  unit: varchar('unit', { length: 50 }),
  referenceYear: integer('reference_year'),
  thematicArea: varchar('thematic_area', { length: 255 }),
  methodology: text('methodology'),
  confidenceLevel: varchar('confidence_level', { length: 50 }),
  methodologicalRisk: varchar('methodological_risk', { length: 50 }),
  reviewStatus: varchar('review_status', { length: 50 }).default('suggested').notNull(),
  reviewerId: uuid('reviewer_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('confidence_level_check', sql`${table.confidenceLevel} IN ('high', 'medium', 'low')`),
  check('methodological_risk_check', sql`${table.methodologicalRisk} IN ('low', 'medium', 'high')`),
  check('review_status_check', sql`${table.reviewStatus} IN ('suggested', 'pending_review', 'approved', 'rejected', 'archived')`),
  check('approved_proxy_check', sql`${table.reviewStatus} != 'approved' OR (${table.value} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.unit} IS NOT NULL AND ${table.referenceYear} IS NOT NULL)`),
  index('idx_financial_proxies_organization_id').on(table.organizationId),
  index('idx_financial_proxies_source_id').on(table.sourceId),
])

export const outcomeProxyAssignments = pgTable('outcome_proxy_assignments', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  outcomeId: uuid('outcome_id').references(() => outcomes.id).notNull(),
  proxyId: uuid('proxy_id').references(() => financialProxies.id).notNull(),
  justification: text('justification'),
  territorialAdjustmentNotes: text('territorial_adjustment_notes'),
  assignedBy: uuid('assigned_by').references(() => users.id).notNull(),
  assignedAt: timestamp('assigned_at').defaultNow().notNull(),
  assignmentStatus: varchar('assignment_status', { length: 20 }).default('active').notNull(),
  archivedBy: uuid('archived_by').references(() => users.id),
  archivedAt: timestamp('archived_at')
}, (table) => [
  index('idx_opa_project_id').on(table.projectId),
  index('idx_opa_organization_id').on(table.organizationId),
  index('idx_opa_outcome_id').on(table.outcomeId),
  index('idx_opa_proxy_id').on(table.proxyId),
])

export const projectInvestments = pgTable('project_investments', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  amount: varchar('amount', { length: 255 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull(),
  year: integer('year'),
  description: text('description'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('project_investments_amount_check', sql`cast(nullif(${table.amount}, '') as numeric) > 0`),
  check('project_investments_status_check', sql`${table.status} IN ('active', 'archived')`),
  index('idx_project_investments_project_id').on(table.projectId),
])

export const sroiAssignmentInputs = pgTable('sroi_assignment_inputs', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  assignmentId: uuid('assignment_id').references(() => outcomeProxyAssignments.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  quantity: varchar('quantity', { length: 255 }).notNull(),
  unit: varchar('unit', { length: 50 }).notNull(),
  year: integer('year'),
  notes: text('notes'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_assignment_inputs_quantity_check', sql`cast(nullif(${table.quantity}, '') as numeric) > 0`),
  check('sroi_assignment_inputs_status_check', sql`${table.status} IN ('active', 'archived')`),
  index('idx_sroi_assignment_inputs_assignment_id').on(table.assignmentId),
])

export const sroiFilterSets = pgTable('sroi_filter_sets', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  assignmentId: uuid('assignment_id').references(() => outcomeProxyAssignments.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  deadweightPct: varchar('deadweight_pct', { length: 255 }),
  displacementPct: varchar('displacement_pct', { length: 255 }),
  attributionPct: varchar('attribution_pct', { length: 255 }),
  dropoffPct: varchar('dropoff_pct', { length: 255 }),
  durationYears: integer('duration_years'),
  justification: text('justification'),
  status: varchar('status', { length: 50 }).default('active').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_filter_sets_deadweight_pct_check', sql`cast(nullif(${table.deadweightPct}, '') as numeric) >= 0 AND cast(nullif(${table.deadweightPct}, '') as numeric) <= 100`),
  check('sroi_filter_sets_displacement_pct_check', sql`cast(nullif(${table.displacementPct}, '') as numeric) >= 0 AND cast(nullif(${table.displacementPct}, '') as numeric) <= 100`),
  check('sroi_filter_sets_attribution_pct_check', sql`cast(nullif(${table.attributionPct}, '') as numeric) >= 0 AND cast(nullif(${table.attributionPct}, '') as numeric) <= 100`),
  check('sroi_filter_sets_dropoff_pct_check', sql`cast(nullif(${table.dropoffPct}, '') as numeric) >= 0 AND cast(nullif(${table.dropoffPct}, '') as numeric) <= 100`),
  check('sroi_filter_sets_duration_years_check', sql`${table.durationYears} >= 1 AND ${table.durationYears} <= 50`),
  check('sroi_filter_sets_status_check', sql`${table.status} IN ('active', 'archived')`),
  index('idx_sroi_filter_sets_assignment_id').on(table.assignmentId),
])

export const sroiCalculationRuns = pgTable('sroi_calculation_runs', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  version: integer('version').notNull().default(1),
  currency: varchar('currency', { length: 10 }),
  totalInvestment: varchar('total_investment', { length: 255 }),
  grossSocialValue: varchar('gross_social_value', { length: 255 }),
  netSocialValue: varchar('net_social_value', { length: 255 }),
  sroiRatio: varchar('sroi_ratio', { length: 255 }),
  snapshotJson: jsonb('snapshot_json'),
  runDate: timestamp('run_date').defaultNow().notNull(),
  status: varchar('status', { length: 50 }).default('calculated').notNull(),
  calculatedBy: uuid('calculated_by').references(() => users.id).notNull(),
  calculatedAt: timestamp('calculated_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_calculation_runs_status_check', sql`${table.status} IN ('calculated', 'failed', 'pending')`),
  index('idx_sroi_calculation_runs_project_id').on(table.projectId),
])

export const sroiCalculationLineItems = pgTable('sroi_calculation_line_items', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  runId: uuid('run_id').references(() => sroiCalculationRuns.id).notNull(),
  assignmentId: uuid('assignment_id').references(() => outcomeProxyAssignments.id).notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  outcomeId: uuid('outcome_id').references(() => outcomes.id),
  proxyId: uuid('proxy_id').references(() => financialProxies.id),
  quantity: varchar('quantity', { length: 255 }),
  proxyValue: varchar('proxy_value', { length: 255 }),
  currency: varchar('currency', { length: 10 }),
  grossValue: varchar('gross_value', { length: 255 }),
  adjustedValue: varchar('adjusted_value', { length: 255 }),
  deadweightPct: varchar('deadweight_pct', { length: 255 }),
  attributionPct: varchar('attribution_pct', { length: 255 }),
  displacementPct: varchar('displacement_pct', { length: 255 }),
  dropoffPct: varchar('dropoff_pct', { length: 255 }),
  durationYears: integer('duration_years'),
  year: integer('year'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_sroi_line_items_run_id').on(table.runId),
  index('idx_sroi_line_items_assignment_id').on(table.assignmentId),
])

export const sroiRunReviews = pgTable('sroi_run_reviews', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  calculationRunId: uuid('calculation_run_id').references(() => sroiCalculationRuns.id).notNull(),
  reviewerId: uuid('reviewer_id').references(() => users.id).notNull(),
  status: varchar('status', { length: 50 }).default('draft').notNull(),
  readinessScore: integer('readiness_score'),
  overallNotes: text('overall_notes'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_run_reviews_status_check', sql`${table.status} IN ('draft', 'reviewed', 'approved', 'flagged', 'archived')`),
  check('sroi_run_reviews_score_check', sql`${table.readinessScore} >= 0 AND ${table.readinessScore} <= 100`),
  index('idx_sroi_run_reviews_calculation_run_id').on(table.calculationRunId),
  index('idx_sroi_run_reviews_project_id').on(table.projectId),
])

export const sroiRunReviewItems = pgTable('sroi_run_review_items', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  reviewId: uuid('review_id').references(() => sroiRunReviews.id).notNull(),
  itemKey: varchar('item_key', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).default('warning').notNull(),
  severity: varchar('severity', { length: 50 }).default('medium').notNull(),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_run_review_items_status_check', sql`${table.status} IN ('pass', 'warning', 'fail', 'not_applicable')`),
  check('sroi_run_review_items_severity_check', sql`${table.severity} IN ('low', 'medium', 'high')`),
  index('idx_sroi_run_review_items_review_id').on(table.reviewId),
])

export const sroiReports = pgTable('sroi_reports', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  calculationRunId: uuid('calculation_run_id').references(() => sroiCalculationRuns.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary'),
  status: varchar('status', { length: 50 }).default('draft').notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  lockedBy: uuid('locked_by').references(() => users.id),
  lockedAt: timestamp('locked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_reports_status_check', sql`${table.status} IN ('draft', 'under_review', 'locked', 'archived')`),
  index('idx_sroi_reports_project_id').on(table.projectId),
  index('idx_sroi_reports_calculation_run_id').on(table.calculationRunId),
])

export const stellaInteractions = pgTable('stella_interactions', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  stellaRole: varchar('stella_role', { length: 50 }).notNull(),
  pipelineStep: varchar('pipeline_step', { length: 100 }).notNull(),
  contextHash: varchar('context_hash', { length: 64 }).notNull(),
  responseJson: jsonb('response_json').notNull(),
  modelUsed: varchar('model_used', { length: 100 }).default('gemini-2.0-flash').notNull(),
  tokensUsed: integer('tokens_used'),
  riskLevel: varchar('risk_level', { length: 50 }),
  riskFlags: text('risk_flags').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('stella_interactions_stella_role_check', sql`${table.stellaRole} IN ('advisor', 'validator', 'composer')`),
  check('stella_interactions_risk_level_check', sql`${table.riskLevel} IS NULL OR ${table.riskLevel} IN ('low', 'medium', 'high')`),
  // These already exist in the DB via migration 0012 — declared here so
  // schema.ts reflects reality (they were previously missing from the model).
  index('stella_interactions_org_created_idx').on(table.organizationId, table.createdAt),
  index('stella_interactions_project_role_idx').on(table.projectId, table.stellaRole),
  index('stella_interactions_created_by_created_idx').on(table.createdBy, table.createdAt),
  index('stella_interactions_context_hash_idx').on(table.contextHash),
  index('stella_interactions_risk_level_idx').on(table.riskLevel).where(sql`${table.riskLevel} IS NOT NULL`),
])

export const sroiReportSections = pgTable('sroi_report_sections', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  reportId: uuid('report_id').references(() => sroiReports.id).notNull(),
  sectionType: varchar('section_type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content'),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('sroi_report_sections_sort_order_check', sql`${table.sortOrder} >= 0`),
  index('idx_sroi_report_sections_report_id').on(table.reportId),
])

// Gates self-serve org creation in onboarding (createFirstOrganization):
// a user with no pending invitation can only create a new organization if
// their email matches an entry here. Invited users bypass this entirely
// (acceptInvitation is a separate code path). Managed by super_admins only.
export const signupAllowlist = pgTable('signup_allowlist', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  type: varchar('type', { length: 20 }).notNull(),
  pattern: varchar('pattern', { length: 255 }).notNull(),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('signup_allowlist_pattern_unique').on(table.pattern),
  check('signup_allowlist_type_check', sql`${table.type} IN ('email', 'domain')`),
])
