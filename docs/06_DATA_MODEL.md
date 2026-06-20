# 06 — Modelo de datos inicial

## Principios

El modelo de datos debe soportar:

- multi-tenancy por organización;
- SROI Pipeline;
- evidencias con hash;
- banco de proxies;
- audit trail;
- reportes versionados;
- Stella Advisor/Validator/Composer;
- permisos por rol;
- datos sensibles y anonimización opcional.

## Entidades principales

### users

Usuario autenticado vía Supabase Auth.

Campos sugeridos:
- id
- email
- full_name
- avatar_url
- created_at
- updated_at

### organizations

Organizaciones cliente.

Campos:
- id
- name
- slug
- legal_name
- country
- sector
- status
- created_at
- updated_at

### organization_members

Relación usuario-organización.

Campos:
- id
- organization_id
- user_id
- role
- status
- invited_by
- joined_at
- created_at
- updated_at

Regla MVP:
- un usuario solo pertenece a una organización.

### portfolios

Agrupación de proyectos.

Campos:
- id
- organization_id
- name
- description
- status
- created_by
- created_at
- updated_at

### projects

Proyecto de impacto.

Campos:
- id
- organization_id
- portfolio_id
- name
- description
- thematic_area
- territory
- country
- start_date
- end_date
- target_population_description
- status
- created_by
- created_at
- updated_at

### impact_narratives

Narrativa de impacto del proyecto.

Campos:
- id
- project_id
- version
- narrative_text
- theory_of_change_summary
- assumptions
- status
- created_by
- created_at
- updated_at

### stakeholder_groups

Grupos de interés.

Campos:
- id
- project_id
- name
- description
- type
- created_at
- updated_at

### outcomes

Resultados esperados.

Campos:
- id
- project_id
- stakeholder_group_id
- title
- description
- outcome_type
- materiality_notes
- status
- created_by
- created_at
- updated_at

### indicators

Indicadores asociados a outcomes.

Campos:
- id
- project_id
- outcome_id
- name
- description
- indicator_type
- unit
- baseline_value
- target_value
- actual_value
- data_source
- measurement_period
- confidence_level
- created_by
- created_at
- updated_at

### evidence_items

Evidencias.

Campos:
- id
- organization_id
- project_id
- outcome_id
- indicator_id
- uploaded_by
- title
- description
- evidence_type
- storage_path
- external_url
- file_name
- file_size
- mime_type
- sha256_hash
- source_name
- source_type
- trust_level
- review_status
- anonymization_status
- is_sensitive
- version
- created_at
- updated_at
- archived_at
- deleted_at

### proxy_sources

Fuentes de proxies.

Campos:
- id
- name
- organization_type
- country
- website_url
- credibility_notes
- created_at
- updated_at

### financial_proxies

Banco de proxies.

Campos:
- id
- organization_id nullable
- source_id
- name
- description
- thematic_area
- country
- territory
- currency
- value
- value_year
- source_url
- source_reference
- methodology_notes
- territorial_adjustment_notes
- confidence_level
- methodological_risk
- status
- suggested_by_stella
- approved_by
- approved_at
- created_by
- created_at
- updated_at

### outcome_proxy_assignments

Uso de proxies en outcomes.

Campos:
- id
- project_id
- outcome_id
- proxy_id
- quantity
- unit
- rationale
- approved_by
- approved_at
- created_at
- updated_at

### sroi_filters

Filtros SROI.

Campos:
- id
- project_id
- outcome_id
- deadweight_percentage
- attribution_percentage
- displacement_percentage
- dropoff_percentage
- duration_years
- discount_rate
- justification
- created_by
- updated_by
- created_at
- updated_at

### investments

Inversión del proyecto.

Campos:
- id
- project_id
- category
- description
- amount
- currency
- year
- source
- created_by
- created_at
- updated_at

### sroi_calculations

Cálculos SROI.

Campos:
- id
- project_id
- version
- gross_social_value
- net_social_value
- total_investment
- sroi_ratio
- calculation_snapshot_json
- assumptions_json
- formula_version
- calculated_by
- calculated_at
- created_at

### stella_interactions

Interacciones relevantes con Stella.

Campos:
- id
- organization_id
- project_id
- user_id
- mode
- prompt
- response
- context_snapshot_json
- model
- risk_flags_json
- created_at

Modos:
- advisor
- validator
- composer

### stella_reviews

Revisiones estructuradas de Stella.

Campos:
- id
- project_id
- calculation_id
- review_type
- readiness_score
- evidence_gaps_json
- proxy_risks_json
- attribution_risks_json
- claim_risks_json
- recommendations_json
- created_at

### reports

Reportes.

Campos:
- id
- project_id
- version
- title
- status
- web_snapshot_json
- pdf_storage_path
- sroi_readiness_score
- generated_by
- generated_at
- approved_by
- approved_at
- created_at
- updated_at

### report_sections

Secciones de reporte.

Campos:
- id
- report_id
- section_key
- title
- content
- generated_by_stella
- edited_by
- created_at
- updated_at

### report_shares

Acceso externo a reportes.

Campos:
- id
- report_id
- shared_with_email
- role
- token_hash
- expires_at
- created_by
- created_at
- revoked_at

### audit_logs

Audit trail.

Campos:
- id
- organization_id
- project_id nullable
- actor_user_id
- entity_type
- entity_id
- action
- before_json
- after_json
- reason
- ip_address
- user_agent
- created_at

## Entidades futuras

- billing_accounts
- subscriptions
- external_audits
- digital_signatures
- blockchain_anchors
- external_integrations
- multi_org_memberships

## Reglas transversales

1. Toda entidad de negocio debe estar asociada a organización.
2. Todo cambio metodológico debe generar audit log.
3. Toda evidencia debe tener hash.
4. Todo reporte debe tener versión.
5. Todo proxy usado en cálculo debe tener fuente y aprobación humana.
6. Los datos sensibles deben poder marcarse como tales.
7. La anonimización debe ser opcional por proyecto/evidencia.
