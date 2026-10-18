/** A stocking location (SAP: plant / Werk). */
export interface Plant {
  id: string
  name: string
  country: string
  lat: number
  lon: number
}

/** Material master data (SAP: MM03 views Basic data / Accounting / MRP). */
export interface Material {
  id: string
  description: string
  /** Standard price per unit in EUR. */
  unitPrice: number
  unitWeightKg: number
  /** Planned delivery time for a new purchase, in days. */
  leadTimeDays: number
}

/** One row of a stock overview (SAP: MB52). */
export interface StockLine {
  material: string
  plant: string
  unrestricted: number
  safetyStock: number
}

/** One open requirement (SAP: MD04 dependent / independent requirement). */
export interface DemandLine {
  material: string
  plant: string
  quantity: number
  /** Days from today until the parts must be on site. */
  needByDays: number
}

export interface Settings {
  /** Freight cost in EUR per kg per 1,000 km. */
  freightPerKgPer1000Km: number
  /** Fixed cost of raising one stock transfer (paperwork, customs, handling). */
  fixedCostPerTransfer: number
  /** Average door-to-door speed, km per day. */
  transitKmPerDay: number
  /** Pick, pack and customs days added to every transfer. */
  handlingDays: number
  /** Price surcharge when a new purchase must be expedited to meet the need date, in %. */
  expediteSurchargePct: number
}

export interface Dataset {
  plants: Plant[]
  materials: Material[]
  stock: StockLine[]
  demand: DemandLine[]
}

/** Net position of one material at one plant. */
export interface Position {
  material: string
  plant: string
  unrestricted: number
  safetyStock: number
  demand: number
  /** Earliest need date over all requirements at this plant (days). Infinity if none. */
  needByDays: number
  /** Units that can leave the plant without touching safety stock or local demand. */
  excess: number
  /** Units the plant still needs to cover demand and restore safety stock. */
  shortage: number
}

export interface Lane {
  from: string
  to: string
  distanceKm: number
  transitDays: number
  freightPerUnit: number
}

export interface Transfer {
  material: string
  from: string
  to: string
  quantity: number
  distanceKm: number
  transitDays: number
  freightCost: number
  fixedCost: number
  /** Purchase spend this transfer replaces. */
  avoidedPurchase: number
}

export interface Purchase {
  material: string
  plant: string
  quantity: number
  unitCost: number
  cost: number
  /** True if the supplier lead time is longer than the need date allows. */
  late: boolean
  needByDays: number
  leadTimeDays: number
}

export interface RemainingExcess {
  material: string
  plant: string
  quantity: number
  value: number
}

/** Why a lane that looks useful on paper was not used. */
export interface RejectedLane {
  material: string
  from: string
  to: string
  reason: 'too-slow' | 'not-worth-it'
  detail: string
}

export interface Plan {
  transfers: Transfer[]
  purchases: Purchase[]
  remainingExcess: RemainingExcess[]
  rejectedLanes: RejectedLane[]
  totals: {
    /** Cost if every shortage were bought new. */
    buyAllCost: number
    /** Cost of the optimized plan (freight + fixed + purchases). */
    planCost: number
    savings: number
    /** Cost of covering each shortage from the nearest plant with stock, as a planner might by hand. */
    ruleOfThumbCost: number
    savingsVsRuleOfThumb: number
    unitsTransferred: number
    avoidedPurchase: number
    freightCost: number
    fixedCost: number
    lateLines: number
    remainingExcessValue: number
  }
}
