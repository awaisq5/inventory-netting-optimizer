import type { Dataset, Position } from './types'

/**
 * Nets stock against demand for every material/plant pair.
 *
 * excess   = what can leave a plant after protecting safety stock and local demand
 * shortage = what a plant needs to cover its demand and restore safety stock
 *
 * A plant is never both: if it is short it keeps everything it has.
 */
export function computePositions(data: Dataset): Position[] {
  const key = (m: string, p: string) => `${m}|${p}`
  const map = new Map<string, Position>()

  const get = (material: string, plant: string): Position => {
    const k = key(material, plant)
    let pos = map.get(k)
    if (!pos) {
      pos = {
        material,
        plant,
        unrestricted: 0,
        safetyStock: 0,
        demand: 0,
        needByDays: Infinity,
        excess: 0,
        shortage: 0,
      }
      map.set(k, pos)
    }
    return pos
  }

  for (const s of data.stock) {
    const pos = get(s.material, s.plant)
    pos.unrestricted += s.unrestricted
    // Safety stock is a plant setting, not additive across rows.
    pos.safetyStock = Math.max(pos.safetyStock, s.safetyStock)
  }

  for (const d of data.demand) {
    const pos = get(d.material, d.plant)
    pos.demand += d.quantity
    pos.needByDays = Math.min(pos.needByDays, d.needByDays)
  }

  for (const pos of map.values()) {
    const net = pos.unrestricted - pos.safetyStock - pos.demand
    pos.excess = Math.max(0, net)
    pos.shortage = Math.max(0, -net)
    // A shortage caused only by a safety-stock gap keeps needByDays = Infinity:
    // it has no hard date, and the optimizer treats it as due within normal lead time.
  }

  return [...map.values()].sort(
    (a, b) => a.material.localeCompare(b.material) || a.plant.localeCompare(b.plant),
  )
}
