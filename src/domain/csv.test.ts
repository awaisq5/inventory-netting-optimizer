import { describe, expect, it } from 'vitest'
import { SAMPLE } from '../data/sample'
import { CsvError, detectDecimal, parseNumber, parseTable, serializeTable, type TableName } from './csv'

const STOCK = 'material,plant,unrestricted,safety_stock'
const MATERIALS = 'material,description,unit_price_eur,unit_weight_kg,lead_time_days'

describe('parseNumber', () => {
  it.each([
    ['1250', null, true, 1250],
    ['1,250', null, true, 1250],
    ['1.250', null, true, 1250],
    ['1 250', null, true, 1250],
    ['1,250,000', null, false, 1250000],
    ['12,5', null, false, 12.5],
    ['12.5', null, false, 12.5],
    ['1.250,50', null, false, 1250.5],
    ['1,250.50', null, false, 1250.5],
    ['1.250,50', ',', false, 1250.5],
    ['1,250', ',', false, 1.25],
    ['1,250', '.', false, 1250],
    ['-0,5', null, false, -0.5],
  ] as const)('reads %s (decimal %s, whole %s) as %s', (raw, decimal, integer, expected) => {
    expect(parseNumber(raw, decimal, integer)).toBe(expected)
  })

  it('refuses to guess "1,250" in a decimal column without a clue from the file', () => {
    expect(parseNumber('1,250', null, false)).toBe('ambiguous')
  })

  it.each(['', 'abc', '12.', '1,2,3', '1.25.0,5', '12,34,5'])('rejects "%s"', (raw) => {
    expect(parseNumber(raw, null, false)).toBeUndefined()
  })
})

describe('detectDecimal', () => {
  it('finds the convention from values that can only be read one way', () => {
    expect(detectDecimal(['1,250', '12,50'])).toBe(',')
    expect(detectDecimal(['1,250', '12.50'])).toBe('.')
    expect(detectDecimal(['1,250', '300'])).toBeNull()
    expect(detectDecimal(['12,50', '3.75'])).toBe('mixed')
  })
})

describe('parseTable', () => {
  it('reads thousands separators in quantities instead of turning 1,250 into 1.25', () => {
    const rows = parseTable('stock', `${STOCK}\nM1,P1,"1,250",20`)
    expect(rows[0]).toEqual({ material: 'M1', plant: 'P1', unrestricted: 1250, safetyStock: 20 })
  })

  it('reads a German-format export', () => {
    const rows = parseTable('materials', `${MATERIALS}\nM1,Seal kit,"1.250,50","2,5",42`)
    expect(rows[0]).toMatchObject({ unitPrice: 1250.5, unitWeightKg: 2.5, leadTimeDays: 42 })
  })

  it('uses the file convention for values that are ambiguous on their own', () => {
    const rows = parseTable('materials', `${MATERIALS}\nM1,Seal,"1,250","2,5",42\nM2,Ring,"0,75","0,1",10`)
    expect(rows[0].unitPrice).toBe(1.25)
  })

  it('refuses an ambiguous price rather than guessing', () => {
    expect(() => parseTable('materials', `${MATERIALS}\nM1,Seal,"1,250",3,42`)).toThrow(/thousand times/)
  })

  it('refuses files that mix number formats', () => {
    expect(() => parseTable('materials', `${MATERIALS}\nM1,Seal,"12,50",3.75,42`)).toThrow(/mixes decimal commas/)
  })

  it('refuses negative or fractional quantities', () => {
    expect(() => parseTable('stock', `${STOCK}\nM1,P1,10,-3`)).toThrow('cannot be below 0')
    expect(() => parseTable('stock', `${STOCK}\nM1,P1,"10,5",3`)).toThrow('should be a whole number')
  })

  it('checks coordinate ranges', () => {
    expect(() => parseTable('plants', 'plant,name,country,lat,lon\nP1,Celle,DE,152.6,10.1')).toThrow('cannot be above 90')
  })

  it('names the file, row and column in every error', () => {
    try {
      parseTable('stock', `${STOCK}\nM1,P1,many,3`)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CsvError)
      expect((e as Error).message).toBe('stock.csv, row 2: "unrestricted" should be a number but is "many".')
    }
  })
})

describe('round trip', () => {
  it.each(['plants', 'materials', 'stock', 'demand'] as TableName[])('reads back the downloaded %s table unchanged', (name) => {
    expect(parseTable(name, serializeTable(name, SAMPLE[name]))).toEqual(SAMPLE[name])
  })
})
