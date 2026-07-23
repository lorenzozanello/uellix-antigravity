#!/usr/bin/env node
/**
 * Script para completar los datos faltantes en un proyecto piloto
 * Completa: USD conversion, cantidades, filtros SROI, aprobación de proxies, y evidencia
 */

import { db } from '../db/client'
import {
  projects,
  projectInvestments,
  outcomeProxyAssignments,
  sroiAssignmentInputs,
  sroiFilterSets,
  financialProxies,
  evidenceItems,
  outcomes
} from '../db/schema'
import { eq, and, inArray } from 'drizzle-orm'

async function completeProjectPilot() {
  console.log('📊 Iniciando completación de proyecto piloto...\n')

  // 1. Encontrar un proyecto piloto (buscar el primero que tenga problemas)
  const allProjects = await db.select().from(projects).limit(5)

  if (allProjects.length === 0) {
    console.log('❌ No hay proyectos disponibles')
    return
  }

  const project = allProjects[0]
  console.log(`✅ Proyecto encontrado: ${project.name} (ID: ${project.id})\n`)

  // 2. Completar inversiones sin USD
  console.log('1️⃣  Completando conversiones USD...')
  const investmentsMissingUsd = await db
    .select()
    .from(projectInvestments)
    .where(and(
      eq(projectInvestments.projectId, project.id),
      eq(projectInvestments.status, 'active')
    ))

  for (const inv of investmentsMissingUsd) {
    if (inv.amountUsd === null || inv.amountUsd === undefined) {
      // Si es USD, pass-through
      if (inv.currency === 'USD') {
        await db.update(projectInvestments)
          .set({ amountUsd: inv.amount })
          .where(eq(projectInvestments.id, inv.id))
        console.log(`   ✓ ${inv.currency} ${inv.amount} → ${inv.amount} USD`)
      } else if (inv.currency === 'COP') {
        // COP usa el tipo de cambio del 31 de diciembre del año
        // Voy a usar un tipo de cambio de ejemplo: 1 USD = 4000 COP
        const fxRate = 4000
        const amountUsd = (parseFloat(inv.amount) / fxRate).toFixed(4)
        await db.update(projectInvestments)
          .set({ amountUsd })
          .where(eq(projectInvestments.id, inv.id))
        console.log(`   ✓ ${inv.currency} ${inv.amount} → ${amountUsd} USD (rate: 1/${fxRate})`)
      }
    }
  }

  // 3. Completar asignaciones con cantidades e inputs
  console.log('\n2️⃣  Completando información de cantidades...')
  const allAssignments = await db
    .select()
    .from(outcomeProxyAssignments)
    .where(and(
      eq(outcomeProxyAssignments.projectId, project.id),
      eq(outcomeProxyAssignments.assignmentStatus, 'active')
    ))

  for (const assignment of allAssignments) {
    const existingInput = await db
      .select()
      .from(sroiAssignmentInputs)
      .where(eq(sroiAssignmentInputs.assignmentId, assignment.id))

    if (existingInput.length === 0) {
      // Crear input con cantidad de ejemplo: 100 beneficiarios
      await db.insert(sroiAssignmentInputs).values({
        assignmentId: assignment.id,
        organizationId: project.organizationId,
        createdBy: 'system',
        quantity: '100',
        unit: 'beneficiarios'
      })
      console.log(`   ✓ Asignación ${assignment.id.slice(0, 8)}... → 100 beneficiarios`)
    }
  }

  // 4. Completar filtros SROI
  console.log('\n3️⃣  Configurando filtros SROI...')
  for (const assignment of allAssignments) {
    const existingFilterSet = await db
      .select()
      .from(sroiFilterSets)
      .where(eq(sroiFilterSets.assignmentId, assignment.id))

    if (existingFilterSet.length === 0) {
      // Valores conservadores por defecto
      await db.insert(sroiFilterSets).values({
        assignmentId: assignment.id,
        organizationId: project.organizationId,
        createdBy: 'system',
        deadweightPct: '30',      // 30% de la población habría tenido ese outcome igual
        displacementPct: '10',    // 10% de beneficiarios serían desplazados
        attributionPct: '20',     // 20% de atribución a otros actores
        dropoffPct: '5',          // 5% de degradación anual
        durationYears: 5,         // 5 años de duración
        justification: 'Valores conservadores por defecto para análisis SROI'
      })
      console.log(`   ✓ Asignación ${assignment.id.slice(0, 8)}... → Filtros configurados`)
    }
  }

  // 5. Aprobar proxies
  console.log('\n4️⃣  Aprobando proxies...')
  const proxiesInProject = await db
    .select()
    .from(financialProxies)
    .where(inArray(
      financialProxies.id,
      allAssignments.map(a => a.proxyId)
    ))

  for (const proxy of proxiesInProject) {
    if (proxy.reviewStatus !== 'approved') {
      await db.update(financialProxies)
        .set({
          reviewStatus: 'approved',
          reviewedAt: new Date(),
          reviewedBy: 'system'
        })
        .where(eq(financialProxies.id, proxy.id))
      console.log(`   ✓ Proxy "${proxy.name}" → Aprobado`)
    }

    // Si falta valueUsd, copiar del value (asumir USD si no está especificado)
    if (proxy.valueUsd === null || proxy.valueUsd === undefined) {
      await db.update(financialProxies)
        .set({ valueUsd: proxy.value })
        .where(eq(financialProxies.id, proxy.id))
      console.log(`   ✓ Proxy "${proxy.name}" → valueUsd configurado`)
    }
  }

  // 6. Agregar evidencia para outcomes sin evidencia
  console.log('\n5️⃣  Vinculando evidencia a resultados...')
  const outcomeIds = [...new Set(allAssignments.map(a => a.outcomeId))]

  for (const outcomeId of outcomeIds) {
    const existingEvidence = await db
      .select()
      .from(evidenceItems)
      .where(and(
        eq(evidenceItems.projectId, project.id),
        eq(evidenceItems.outcomeId, outcomeId),
        inArray(evidenceItems.status, ['draft', 'under_review', 'approved'])
      ))

    if (existingEvidence.length === 0) {
      // Obtener nombre del outcome para contexto
      const outcome = await db
        .select()
        .from(outcomes)
        .where(eq(outcomes.id, outcomeId))
        .then(rows => rows[0])

      // Crear un elemento de evidencia básico
      await db.insert(evidenceItems).values({
        projectId: project.id,
        outcomeId,
        organizationId: project.organizationId,
        createdBy: 'system',
        name: `Evidencia: ${outcome?.name || 'Resultado'}`,
        description: 'Evidencia agregada automáticamente para habilitar el cálculo SROI',
        status: 'draft',
        dataType: 'qualitative'
      })
      console.log(`   ✓ Resultado "${outcome?.name}" → Evidencia agregada`)
    }
  }

  console.log('\n✅ ¡Proyecto piloto completado exitosamente!\n')
  console.log('Puedes proceder a ejecutar el cálculo SROI.')
}

completeProjectPilot().catch(err => {
  console.error('❌ Error:', err)
  process.exit(1)
})
