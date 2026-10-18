import Papa from 'papaparse'
import type { Dataset, DemandLine, Material, Plant, StockLine } from './types'

export type TableName = keyof Dataset

interface Column<T> {
  header: string
  key: keyof T
  type: 'string' | 'number'
  /** Whole numbers only (quantities, days): thousands separators are allowed. */
  integer?: boolean
  min?: number
  max?: number
}

const schemas = {
  plants: [
    { header: 'plant', key: 'id', type: 'string' },
    { header: 'name', key: 'name', type: 'string' },
    { header: 'country', key: 'country', type: 'string' },
    { header: 'lat', key: 'lat', type: 'number', min: -90, max: 90 },
    { header: 'lon', key: 'lon', type: 'number', min: -180, max: 180 },
  ] satisfies Column<Plant>[],
  materials: [
    { header: 'material', key: 'id', type: 'string' },
    { header: 'description', key: 'description', type: 'string' },
    { header: 'unit_price_eur', key: 'unitPrice', type: 'number', min: 0 },
    { header: 'unit_weight_kg', key: 'unitWeightKg', type: 'number', min: 0 },
    { header: 'lead_time_days', key: 'leadTimeDays', type: 'number', integer: true, min: 0 },
  ] satisfies Column<Material>[],
  stock: [
    { header: 'material', key: 'material', type: 'string' },
    { header: 'plant', key: 'plant', type: 'string' },
    { header: 'unrestricted', key: 'unrestricted', type: 'number', integer: true, min: 0 },
    { header: 'safety_stock', key: 'safetyStock', type: 'number', integer: true, min: 0 },
  ] satisfies Column<StockLine>[],
  demand: [
    { header: 'material', key: 'material', type: 'string' },
    { header: 'plant', key: 'plant', type: 'string' },
    { header: 'quantity', key: 'quantity', type: 'number', integer: true, min: 0 },
    { header: 'need_by_days', key: 'needByDays', type: 'number', integer: true, min: 0 },
  ] satisfies Column<DemandLine>[],
}

export const TABLE_INFO: Record<TableName, { file: string; label: string; source: string }> = {
  plants: { file: 'plants.csv', label: 'Plants', source: 'Plant list with coordinates' },
  materials: { file: 'materials.csv', label: 'Materials', source: 'Material master (MM03)' },
  stock: { file: 'stock.csv', label: 'Stock', source: 'Stock overview export (MB52)' },
  demand: { file: 'demand.csv', label: 'Demand', source: 'Open requirements (MD04)' },
}

export class CsvError extends Error {}

export function parseTable<K extends TableName>(name: K, text: string): Dataset[K] {
  const columns = schemas[name] as Column<Record<string, unknown>>[]
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  })
  const headers = parsed.meta.fields ?? []
  const missing = columns.filter((c) => !headers.includes(c.header)).map((c) => c.header)
  if (missing.length) {
    throw new CsvError(
      `${TABLE_INFO[name].file} is missing the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`,
    )
  }

  const file = TABLE_INFO[name].file
  const numeric = columns.filter((c) => c.type === 'number')
  const decimal = detectDecimal(parsed.data.flatMap((raw) => numeric.map((c) => (raw[c.header] ?? '').trim())))
  if (decimal === 'mixed') {
    throw new CsvError(`${file} mixes decimal commas and decimal points. Export it again with one number format.`)
  }

  const rows = parsed.data.map((raw, index) => {
    const row: Record<string, unknown> = {}
    const at = `${file}, row ${index + 2}`
    for (const col of columns) {
      const value = (raw[col.header] ?? '').trim()
      if (col.type === 'number') {
        const n = parseNumber(value, decimal, col.integer ?? false)
        if (n === 'ambiguous') {
          throw new CsvError(
            `${at}: "${col.header}" is "${value}", which could mean a thousand times more or less. Write it without a thousands separator.`,
          )
        }
        if (n === undefined) {
          throw new CsvError(`${at}: "${col.header}" should be a number but is "${value}".`)
        }
        if (col.integer && !Number.isInteger(n)) {
          throw new CsvError(`${at}: "${col.header}" should be a whole number but is "${value}".`)
        }
        if (col.min !== undefined && n < col.min) {
          throw new CsvError(`${at}: "${col.header}" cannot be below ${col.min} but is "${value}".`)
        }
        if (col.max !== undefined && n > col.max) {
          throw new CsvError(`${at}: "${col.header}" cannot be above ${col.max} but is "${value}".`)
        }
        row[col.key] = n
      } else {
        if (value === '') {
          throw new CsvError(`${at}: "${col.header}" is empty.`)
        }
        row[col.key] = value
      }
    }
    return row
  })
  return rows as unknown as Dataset[K]
}

export type Decimal = ',' | '.' | null

/**
 * Finds the decimal separator a file uses from values that can only be read
 * one way: "12,50" or "1.250,5" use a decimal comma, "12.50" or "1,250.5" a
 * decimal point. Values like "1,250" prove nothing. Returns null if no value
 * decides it, 'mixed' if values disagree.
 */
export function detectDecimal(values: string[]): Decimal | 'mixed' {
  let comma = false
  let point = false
  for (const raw of values) {
    const v = raw.replace(/[\s  ']/g, '')
    if (/,\d{1,2}$|,\d{4,}$|\.\d{3},\d+$|^-?0,\d+$/.test(v)) comma = true
    if (/\.\d{1,2}$|\.\d{4,}$|,\d{3}\.\d+$|^-?0\.\d+$/.test(v)) point = true
  }
  if (comma && point) return 'mixed'
  return comma ? ',' : point ? '.' : null
}

/**
 * Reads a number written with either convention. Returns undefined for text
 * that is not a number and 'ambiguous' when "1,250" could be 1.25 or 1250 and
 * nothing in the file or the column decides it.
 */
export function parseNumber(raw: string, decimal: Decimal, integer: boolean): number | undefined | 'ambiguous' {
  let v = raw.replace(/[\s\u00a0\u202f']/g, '')
  if (!/^-?[\d.,]*\d$/.test(v) || !/\d/.test(v)) return undefined
  const grouped = (sep: string) => new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(v)
  let dec = decimal
  if (!dec) {
    const hasComma = v.includes(',')
    const hasPoint = v.includes('.')
    if (hasComma && hasPoint) dec = v.lastIndexOf(',') > v.lastIndexOf('.') ? ',' : '.'
    else if (hasComma || hasPoint) {
      const sep = hasComma ? ',' : '.'
      if (grouped(sep)) {
        // "1,250": thousands in a whole-number column, a guess anywhere else.
        // "1,250,000" can only be thousands.
        if (!integer && v.split(sep).length === 2) return 'ambiguous'
        dec = sep === ',' ? '.' : ','
      } else dec = sep
    } else dec = '.'
  }
  const thousands = dec === ',' ? '.' : ','
  if (v.includes(thousands)) {
    const [whole] = v.split(dec)
    if (!new RegExp(`^-?\\d{1,3}(\\${thousands}\\d{3})*$`).test(whole)) return undefined
    v = v.split(thousands).join('')
  }
  if (v.split(dec).length > 2) return undefined
  const n = Number(v.replace(dec, '.'))
  return Number.isFinite(n) ? n : undefined
}

export function serializeTable<K extends TableName>(name: K, rows: Dataset[K]): string {
  const columns = schemas[name] as Column<Record<string, unknown>>[]
  return Papa.unparse({
    fields: columns.map((c) => c.header),
    data: (rows as unknown as Record<string, unknown>[]).map((r) => columns.map((c) => r[c.key])),
  })
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
