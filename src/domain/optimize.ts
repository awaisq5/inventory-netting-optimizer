import solver from 'javascript-lp-solver'
import { distanceKm } from './geo'
import { computePositions } from './positions'
import type {
  Dataset,
  Lane,
  Material,
  Plan,
  Plant,
  Position,
  Purchase,
  RejectedLane,
  RemainingExcess,
  Settings,
  Transfer,
} from './types'

export const DEFAULT_SETTINGS: Settings = {
  freightPerKgPer1000Km: 0.4,
  fixedCostPerTransfer: 450,
  transitKmPerDay: 900,
  handlingDays: 3,
  expediteSurchargePct: 25,
}

export function buildLane(from: Plant, to: Plant, material: Material, s: Settings): Lane {
  const km = distanceKm(from, to)
  return {
    from: from.id,
    to: to.id,
    distanceKm: Math.round(km),
    transitDays: Math.ceil(s.handlingDays + km / s.transitKmPerDay),
    freightPerUnit: material.unitWeightKg * (km / 1000) * s.freightPerKgPer1000Km,
  }
}

interface Sink {
  pos: Position
  needBy: number
  late: boolean
  unitCost: number
}

function sinkFor(pos: Position, m: Material, s: Settings): Sink {
  // A pure safety-stock gap has no hard date; it can wait for a normal purchase.
  const needBy = Number.isFinite(pos.needByDays) ? pos.needByDays : m.leadTimeDays
  const late = m.leadTimeDays > needBy
  const unitCost = m.unitPrice * (late ? 1 + s.expediteSurchargePct / 100 : 1)
  return { pos, needBy, late, unitCost }
}

interface MaterialResult {
  transfers: Transfer[]
  purchases: Purchase[]
  remaining: RemainingExcess[]
  rejected: RejectedLane[]
}

/**
 * Solves one material as a fixed-charge transportation problem:
 *
 *   min  Σ freight_ij·x_ij + F·y_ij + Σ buyCost_j·b_j
 *   s.t. Σ_j x_ij ≤ excess_i                  (sources)
 *        Σ_i x_ij + b_j = shortage_j          (every shortage is covered)
 *        x_ij ≤ M_ij·y_ij,  y_ij ∈ {0,1}      (a lane costs F once it is used)
 *        x, b ≥ 0 and integer
 *
 * Lanes whose transit time misses the need date are left out of the model.
 */
export function solveMaterial(
  material: Material,
  positions: Position[],
  plants: Map<string, Plant>,
  s: Settings,
): MaterialResult {
  const sources = positions.filter((p) => p.excess > 0)
  const sinks = positions.filter((p) => p.shortage > 0).map((p) => sinkFor(p, material, s))
  const result: MaterialResult = { transfers: [], purchases: [], remaining: [], rejected: [] }

  const lanes: { i: number; j: number; lane: Lane }[] = []
  sources.forEach((src, i) => {
    sinks.forEach((sink, j) => {
      const from = plants.get(src.plant)
      const to = plants.get(sink.pos.plant)
      if (!from || !to) return
      const lane = buildLane(from, to, material, s)
      if (lane.freightPerUnit >= sink.unitCost) return // never cheaper than buying
      if (lane.transitDays > sink.needBy) {
        result.rejected.push({
          material: material.id,
          from: lane.from,
          to: lane.to,
          reason: 'too-slow',
          detail: `Needs ${lane.transitDays} days in transit, parts are due in ${sink.needBy}.`,
        })
        return
      }
      lanes.push({ i, j, lane })
    })
  })

  const model = {
    optimize: 'cost',
    opType: 'min' as const,
    constraints: {} as Record<string, { max?: number; equal?: number }>,
    variables: {} as Record<string, Record<string, number>>,
    ints: {} as Record<string, 1>,
    binaries: {} as Record<string, 1>,
  }
  sources.forEach((src, i) => (model.constraints[`s${i}`] = { max: src.excess }))
  sinks.forEach((sink, j) => {
    model.constraints[`d${j}`] = { equal: sink.pos.shortage }
    model.variables[`b${j}`] = { cost: sink.unitCost, [`d${j}`]: 1 }
    model.ints[`b${j}`] = 1
  })
  for (const { i, j, lane } of lanes) {
    const bigM = Math.min(sources[i].excess, sinks[j].pos.shortage)
    model.constraints[`l${i}_${j}`] = { max: 0 }
    model.variables[`x${i}_${j}`] = { cost: lane.freightPerUnit, [`s${i}`]: 1, [`d${j}`]: 1, [`l${i}_${j}`]: 1 }
    model.variables[`y${i}_${j}`] = { cost: s.fixedCostPerTransfer, [`l${i}_${j}`]: -bigM }
    model.ints[`x${i}_${j}`] = 1
    model.binaries[`y${i}_${j}`] = 1
  }

  const solution = solver.Solve(model) as Record<string, number | boolean>
  if (!solution.feasible) {
    throw new Error(`No feasible plan for material ${material.id}.`)
  }
  const val = (name: string) => Math.round(Number(solution[name] ?? 0))

  const shipped = new Array(sources.length).fill(0)
  for (const { i, j, lane } of lanes) {
    const qty = val(`x${i}_${j}`)
    if (qty <= 0) continue
    shipped[i] += qty
    result.transfers.push({
      material: material.id,
      from: lane.from,
      to: lane.to,
      quantity: qty,
      distanceKm: lane.distanceKm,
      transitDays: lane.transitDays,
      freightCost: qty * lane.freightPerUnit,
      fixedCost: s.fixedCostPerTransfer,
      avoidedPurchase: qty * sinks[j].unitCost,
    })
  }

  sinks.forEach((sink, j) => {
    const qty = val(`b${j}`)
    if (qty <= 0) return
    result.purchases.push({
      material: material.id,
      plant: sink.pos.plant,
      quantity: qty,
      unitCost: sink.unitCost,
      cost: qty * sink.unitCost,
      late: sink.late,
      needByDays: sink.needBy,
      leadTimeDays: material.leadTimeDays,
    })

    // Explain the best unused lane: usually the fixed cost was not worth it.
    let best: { detail: string; from: string; net: number } | undefined
    for (const { i, j: lj, lane } of lanes) {
      if (lj !== j || val(`x${i}_${j}`) > 0) continue
      const left = sources[i].excess - shipped[i]
      if (left <= 0) continue
      const units = Math.min(left, qty)
      const gross = units * (sink.unitCost - lane.freightPerUnit)
      const net = gross - s.fixedCostPerTransfer
      if (!best || net > best.net) {
        best = {
          from: lane.from,
          net,
          detail: `Moving ${units} unit${units === 1 ? '' : 's'} would save ${eur(gross)}, less than the ${eur(s.fixedCostPerTransfer)} cost of raising a transfer.`,
        }
      }
    }
    if (best && best.net <= 0) {
      result.rejected.push({
        material: material.id,
        from: best.from,
        to: sink.pos.plant,
        reason: 'not-worth-it',
        detail: best.detail,
      })
    }
  })

  sources.forEach((src, i) => {
    const left = src.excess - shipped[i]
    if (left > 0) {
      result.remaining.push({
        material: material.id,
        plant: src.plant,
        quantity: left,
        value: left * material.unitPrice,
      })
    }
  })

  return result
}

/** Baseline a planner might use by hand: cover each shortage from the nearest plant with stock. */
export function greedyNearestCost(data: Dataset, s: Settings): number {
  const plants = new Map(data.plants.map((p) => [p.id, p]))
  const materials = new Map(data.materials.map((m) => [m.id, m]))
  let cost = 0
  for (const [materialId, group] of groupBy(computePositions(data), (p) => p.material)) {
    const m = materials.get(materialId)
    if (!m) continue
    const excess = new Map(group.filter((p) => p.excess > 0).map((p) => [p.plant, p.excess]))
    const sinks = group
      .filter((p) => p.shortage > 0)
      .map((p) => sinkFor(p, m, s))
      .sort((a, b) => a.needBy - b.needBy)
    for (const sink of sinks) {
      let open = sink.pos.shortage
      const to = plants.get(sink.pos.plant)!
      const candidates = [...excess.keys()]
        .map((id) => buildLane(plants.get(id)!, to, m, s))
        .filter((l) => l.transitDays <= sink.needBy)
        .sort((a, b) => a.distanceKm - b.distanceKm)
      for (const lane of candidates) {
        if (open === 0) break
        const qty = Math.min(open, excess.get(lane.from)!)
        if (qty <= 0) continue
        excess.set(lane.from, excess.get(lane.from)! - qty)
        open -= qty
        cost += qty * lane.freightPerUnit + s.fixedCostPerTransfer
      }
      cost += open * sink.unitCost
    }
  }
  return cost
}

export function optimize(data: Dataset, s: Settings = DEFAULT_SETTINGS): Plan & { warnings: string[] } {
  const plants = new Map(data.plants.map((p) => [p.id, p]))
  const materials = new Map(data.materials.map((m) => [m.id, m]))
  const warnings: string[] = []
  const transfers: Transfer[] = []
  const purchases: Purchase[] = []
  const remainingExcess: RemainingExcess[] = []
  const rejectedLanes: RejectedLane[] = []

  for (const [materialId, group] of groupBy(computePositions(data), (p) => p.material)) {
    const m = materials.get(materialId)
    if (!m) {
      warnings.push(`Material ${materialId} has stock or demand but no master data. Skipped.`)
      continue
    }
    const unknown = group.filter((p) => !plants.has(p.plant)).map((p) => p.plant)
    if (unknown.length) warnings.push(`Material ${materialId}: unknown plant ${unknown.join(', ')}.`)
    const r = solveMaterial(m, group, plants, s)
    transfers.push(...r.transfers)
    purchases.push(...r.purchases)
    remainingExcess.push(...r.remaining)
    rejectedLanes.push(...r.rejected)
  }

  let buyAllCost = 0
  for (const pos of computePositions(data)) {
    const m = materials.get(pos.material)
    if (m && pos.shortage > 0) buyAllCost += pos.shortage * sinkFor(pos, m, s).unitCost
  }

  const freightCost = sum(transfers, (t) => t.freightCost)
  const fixedCost = sum(transfers, (t) => t.fixedCost)
  const planCost = freightCost + fixedCost + sum(purchases, (p) => p.cost)

  return {
    transfers: transfers.sort((a, b) => b.avoidedPurchase - a.avoidedPurchase),
    purchases,
    remainingExcess: remainingExcess.sort((a, b) => b.value - a.value),
    rejectedLanes,
    warnings,
    totals: {
      buyAllCost,
      planCost,
      savings: buyAllCost - planCost,
      unitsTransferred: sum(transfers, (t) => t.quantity),
      avoidedPurchase: sum(transfers, (t) => t.avoidedPurchase),
      freightCost,
      fixedCost,
      lateLines: purchases.filter((p) => p.late).length,
      remainingExcessValue: sum(remainingExcess, (r) => r.value),
    },
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k)
    if (list) list.push(item)
    else map.set(k, [item])
  }
  return map
}

function sum<T>(items: T[], f: (t: T) => number): number {
  return items.reduce((acc, t) => acc + f(t), 0)
}

export function eur(n: number): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}
