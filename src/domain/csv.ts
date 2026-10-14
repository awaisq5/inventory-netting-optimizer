import Papa from 'papaparse'
import type { Dataset, DemandLine, Material, Plant, StockLine } from './types'

export type TableName = keyof Dataset

interface Column<T> {
  header: string
  key: keyof T
  type: 'string' | 'number'
}

const schemas = {
  plants: [
    { header: 'plant', key: 'id', type: 'string' },
    { header: 'name', key: 'name', type: 'string' },
    { header: 'country', key: 'country', type: 'string' },
    { header: 'lat', key: 'lat', type: 'number' },
    { header: 'lon', key: 'lon', type: 'number' },
  ] satisfies Column<Plant>[],
  materials: [
    { header: 'material', key: 'id', type: 'string' },
    { header: 'description', key: 'description', type: 'string' },
    { header: 'unit_price_eur', key: 'unitPrice', type: 'number' },
    { header: 'unit_weight_kg', key: 'unitWeightKg', type: 'number' },
    { header: 'lead_time_days', key: 'leadTimeDays', type: 'number' },
  ] satisfies Column<Material>[],
  stock: [
    { header: 'material', key: 'material', type: 'string' },
    { header: 'plant', key: 'plant', type: 'string' },
    { header: 'unrestricted', key: 'unrestricted', type: 'number' },
    { header: 'safety_stock', key: 'safetyStock', type: 'number' },
  ] satisfies Column<StockLine>[],
  demand: [
    { header: 'material', key: 'material', type: 'string' },
    { header: 'plant', key: 'plant', type: 'string' },
    { header: 'quantity', key: 'quantity', type: 'number' },
    { header: 'need_by_days', key: 'needByDays', type: 'number' },
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

  const rows = parsed.data.map((raw, index) => {
    const row: Record<string, unknown> = {}
    for (const col of columns) {
      const value = (raw[col.header] ?? '').trim()
      if (col.type === 'number') {
        const n = Number(value.replace(',', '.'))
        if (value === '' || Number.isNaN(n)) {
          throw new CsvError(
            `${TABLE_INFO[name].file}, row ${index + 2}: "${col.header}" should be a number but is "${value}".`,
          )
        }
        row[col.key] = n
      } else {
        if (value === '') {
          throw new CsvError(`${TABLE_INFO[name].file}, row ${index + 2}: "${col.header}" is empty.`)
        }
        row[col.key] = value
      }
    }
    return row
  })
  return rows as unknown as Dataset[K]
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
