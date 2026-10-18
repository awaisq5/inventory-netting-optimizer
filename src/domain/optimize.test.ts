import { describe, expect, it } from 'vitest'
import { SAMPLE } from '../data/sample'
import { distanceKm } from './geo'
import { DEFAULT_SETTINGS, greedyNearestCost, optimize } from './optimize'
import { computePositions } from './positions'
import { parseTable, serializeTable, CsvError } from './csv'
import type { Dataset, Settings } from './types'

const plants = [
  { id: 'A', name: 'A', country: 'DE', lat: 52.5, lon: 13.4 }, // Berlin
  { id: 'B', name: 'B', country: 'DE', lat: 53.55, lon: 10.0 }, // Hamburg, ~255 km
  { id: 'C', name: 'C', country: 'SG', lat: 1.35, lon: 103.82 }, // Singapore, ~9,900 km
]

const settings: Settings = { ...DEFAULT_SETTINGS, fixedCostPerTransfer: 100, expediteSurchargePct: 0 }

function dataset(partial: Partial<Dataset>): Dataset {
  return { plants, materials: [], stock: [], demand: [], ...partial }
}

describe('distanceKm', () => {
  it('matches the known Berlin–Hamburg distance', () => {
    expect(distanceKm(plants[0], plants[1])).toBeGreaterThan(250)
    expect(distanceKm(plants[0], plants[1])).toBeLessThan(260)
  })
})

describe('computePositions', () => {
  it('protects safety stock and local demand before declaring excess', () => {
    const [pos] = computePositions(
      dataset({
        stock: [{ material: 'M1', plant: 'A', unrestricted: 50, safetyStock: 10 }],
        demand: [{ material: 'M1', plant: 'A', quantity: 15, needByDays: 20 }],
      }),
    )
    expect(pos.excess).toBe(25)
    expect(pos.shortage).toBe(0)
  })

  it('counts a safety-stock gap as shortage', () => {
    const [pos] = computePositions(
      dataset({ stock: [{ material: 'M1', plant: 'A', unrestricted: 2, safetyStock: 5 }] }),
    )
    expect(pos.shortage).toBe(3)
    expect(pos.needByDays).toBe(Infinity)
  })
})

describe('optimize', () => {
  const material = { id: 'M1', description: 'Valve', unitPrice: 1000, unitWeightKg: 5, leadTimeDays: 30 }

  it('transfers when freight plus fixed cost is below the purchase price', () => {
    const plan = optimize(
      dataset({
        materials: [material],
        stock: [
          { material: 'M1', plant: 'A', unrestricted: 20, safetyStock: 0 },
          { material: 'M1', plant: 'B', unrestricted: 0, safetyStock: 0 },
        ],
        demand: [{ material: 'M1', plant: 'B', quantity: 8, needByDays: 20 }],
      }),
      settings,
    )
    expect(plan.transfers).toHaveLength(1)
    expect(plan.transfers[0]).toMatchObject({ from: 'A', to: 'B', quantity: 8 })
    expect(plan.purchases).toHaveLength(0)
    expect(plan.totals.savings).toBeGreaterThan(8000 - 100 - 100)
    expect(plan.remainingExcess[0]).toMatchObject({ plant: 'A', quantity: 12 })
  })

  it('buys instead when the fixed transfer cost outweighs the saving', () => {
    const cheap = { ...material, unitPrice: 20 }
    const plan = optimize(
      dataset({
        materials: [cheap],
        stock: [{ material: 'M1', plant: 'A', unrestricted: 20, safetyStock: 0 }],
        demand: [{ material: 'M1', plant: 'B', quantity: 3, needByDays: 20 }],
      }),
      settings,
    )
    expect(plan.transfers).toHaveLength(0)
    expect(plan.purchases[0]).toMatchObject({ plant: 'B', quantity: 3 })
    expect(plan.rejectedLanes[0]).toMatchObject({ reason: 'not-worth-it', from: 'A', to: 'B' })
  })

  it('rejects lanes that cannot arrive before the need date', () => {
    const plan = optimize(
      dataset({
        materials: [material],
        stock: [{ material: 'M1', plant: 'C', unrestricted: 20, safetyStock: 0 }],
        demand: [{ material: 'M1', plant: 'B', quantity: 4, needByDays: 5 }],
      }),
      settings,
    )
    expect(plan.transfers).toHaveLength(0)
    expect(plan.rejectedLanes[0]).toMatchObject({ reason: 'too-slow', from: 'C' })
    expect(plan.purchases[0].late).toBe(true)
  })

  it('uses one lane when a second lane would cost more in fixed fees than it saves', () => {
    const plan = optimize(
      dataset({
        materials: [material],
        stock: [
          { material: 'M1', plant: 'A', unrestricted: 3, safetyStock: 0 },
          { material: 'M1', plant: 'C', unrestricted: 10, safetyStock: 0 },
        ],
        demand: [{ material: 'M1', plant: 'B', quantity: 9, needByDays: 60 }],
      }),
      settings,
    )
    expect(plan.transfers).toHaveLength(1)
    expect(plan.transfers[0]).toMatchObject({ from: 'C', quantity: 9 })
  })

  it('splits a shortage across sources when one source is not enough', () => {
    const plan = optimize(
      dataset({
        materials: [material],
        stock: [
          { material: 'M1', plant: 'A', unrestricted: 3, safetyStock: 0 },
          { material: 'M1', plant: 'C', unrestricted: 6, safetyStock: 0 },
        ],
        demand: [{ material: 'M1', plant: 'B', quantity: 9, needByDays: 60 }],
      }),
      settings,
    )
    const byFrom = Object.fromEntries(plan.transfers.map((t) => [t.from, t.quantity]))
    expect(byFrom).toEqual({ A: 3, C: 6 })
  })

  it('never costs more than buying everything new, and beats greedy on the sample', () => {
    const plan = optimize(SAMPLE, DEFAULT_SETTINGS)
    expect(plan.totals.planCost).toBeLessThanOrEqual(plan.totals.buyAllCost)
    expect(plan.totals.planCost).toBeLessThanOrEqual(greedyNearestCost(SAMPLE, DEFAULT_SETTINGS) + 1e-6)
    expect(plan.warnings).toEqual([])
    expect(plan.totals.ruleOfThumbCost).toBeCloseTo(greedyNearestCost(SAMPLE, DEFAULT_SETTINGS), 6)
    expect(plan.totals.savingsVsRuleOfThumb).toBeGreaterThanOrEqual(-1e-6)
  })

  it('handles a plant that is missing from the plant list without crashing', () => {
    const material = SAMPLE.materials[0].id
    const data = { ...SAMPLE, demand: [...SAMPLE.demand, { material, plant: 'XX99', quantity: 5, needByDays: 30 }] }
    const plan = optimize(data, DEFAULT_SETTINGS)
    expect(plan.warnings).toContain(`Material ${material}: unknown plant XX99.`)
    expect(plan.purchases.find((p) => p.plant === 'XX99')?.quantity).toBe(5)
    expect(Number.isFinite(plan.totals.ruleOfThumbCost)).toBe(true)
  })

  it('covers every shortage exactly once', () => {
    const plan = optimize(SAMPLE, DEFAULT_SETTINGS)
    for (const pos of computePositions(SAMPLE).filter((p) => p.shortage > 0)) {
      const inbound =
        plan.transfers.filter((t) => t.material === pos.material && t.to === pos.plant).reduce((a, t) => a + t.quantity, 0) +
        plan.purchases.filter((p) => p.material === pos.material && p.plant === pos.plant).reduce((a, p) => a + p.quantity, 0)
      expect(inbound).toBe(pos.shortage)
    }
  })
})

describe('csv', () => {
  it('round-trips a table', () => {
    const text = serializeTable('stock', SAMPLE.stock)
    expect(parseTable('stock', text)).toEqual(SAMPLE.stock)
  })

  it('names the missing column', () => {
    expect(() => parseTable('stock', 'material,plant\nM1,A')).toThrow(/unrestricted, safety_stock/)
  })

  it('names the row with a bad number', () => {
    const text = 'material,plant,quantity,need_by_days\nM1,A,ten,5'
    expect(() => parseTable('demand', text)).toThrow(CsvError)
    expect(() => parseTable('demand', text)).toThrow(/row 2/)
  })
})
