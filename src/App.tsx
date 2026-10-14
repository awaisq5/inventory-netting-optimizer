import { useMemo, useState } from 'react'
import { SAMPLE } from './data/sample'
import { NetworkMap } from './components/NetworkMap'
import { CsvError, TABLE_INFO, downloadText, parseTable, serializeTable, type TableName } from './domain/csv'
import { DEFAULT_SETTINGS, eur, optimize } from './domain/optimize'
import type { Dataset, Settings } from './domain/types'
import Papa from 'papaparse'

const num = new Intl.NumberFormat('en-IE')
type Tab = 'transfers' | 'purchases' | 'unused' | 'idle'

export default function App() {
  const [data, setData] = useState<Dataset>(SAMPLE)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [tab, setTab] = useState<Tab>('transfers')
  const [selected, setSelected] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const { plan, error } = useMemo(() => {
    try {
      return { plan: optimize(data, settings), error: null }
    } catch (e) {
      return { plan: null, error: (e as Error).message }
    }
  }, [data, settings])

  const materials = useMemo(() => new Map(data.materials.map((m) => [m.id, m])), [data.materials])
  const describe = (id: string) => materials.get(id)?.description ?? ''

  async function upload(name: TableName, file: File) {
    try {
      const rows = parseTable(name, await file.text())
      setData((d) => ({ ...d, [name]: rows }))
      setUploadError(null)
      setSelected(null)
    } catch (e) {
      setUploadError(e instanceof CsvError ? e.message : `Could not read ${file.name}.`)
    }
  }

  const touches = (...plants: string[]) => !selected || plants.includes(selected)

  if (!plan) {
    return (
      <main className="page">
        <p className="error">{error}</p>
        <button onClick={() => setData(SAMPLE)}>Reset to sample data</button>
      </main>
    )
  }

  const t = plan.totals
  const lanes = new Set(plan.transfers.map((x) => `${x.from}|${x.to}`)).size
  const transfers = plan.transfers.filter((x) => touches(x.from, x.to))
  const purchases = plan.purchases.filter((x) => touches(x.plant))
  const unused = plan.rejectedLanes.filter((x) => touches(x.from, x.to))
  const idle = plan.remainingExcess.filter((x) => touches(x.plant))

  function exportTransfers() {
    const csv = Papa.unparse(
      plan!.transfers.map((x) => ({
        material: x.material,
        description: describe(x.material),
        supplying_plant: x.from,
        receiving_plant: x.to,
        quantity: x.quantity,
        transit_days: x.transitDays,
        freight_eur: Math.round(x.freightCost),
        avoided_purchase_eur: Math.round(x.avoidedPurchase),
      })),
    )
    downloadText('stock-transfer-proposals.csv', csv)
  }

  return (
    <div className="page">
      <header className="masthead">
        <h1>Inventory netting optimizer</h1>
        <p className="lede">
          Finds stock sitting idle in one plant that another plant is about to buy, and decides which transfers are
          worth the freight.
        </p>
      </header>

      <section className="verdict" aria-live="polite">
        {t.unitsTransferred > 0 ? (
          <p className="verdict-main">
            Move <strong>{num.format(t.unitsTransferred)} units</strong> across{' '}
            <strong>
              {lanes} {lanes === 1 ? 'lane' : 'lanes'}
            </strong>{' '}
            instead of buying them. That avoids <strong>{eur(t.avoidedPurchase)}</strong> of new purchasing for{' '}
            <strong>{eur(t.freightCost + t.fixedCost)}</strong> in freight and handling.
          </p>
        ) : (
          <p className="verdict-main">No transfer pays for itself with these settings. Every shortage is bought new.</p>
        )}
        <dl className="verdict-facts">
          <div>
            <dt>Net saving against buying everything new</dt>
            <dd>{eur(t.savings)}</dd>
          </div>
          <div>
            <dt>Purchase lines that miss their need date</dt>
            <dd className={t.lateLines ? 'warn' : undefined}>{t.lateLines}</dd>
          </div>
          <div>
            <dt>Stock still idle after the plan</dt>
            <dd>{eur(t.remainingExcessValue)}</dd>
          </div>
        </dl>
      </section>

      <NetworkMap plants={data.plants} plan={plan} selected={selected} onSelect={setSelected} />

      <div className="workspace">
        <section className="results" aria-label="Plan details">
          <div className="tabs" role="tablist">
            {(
              [
                ['transfers', 'Transfers', transfers.length],
                ['purchases', 'Purchases', purchases.length],
                ['unused', 'Lanes not used', unused.length],
                ['idle', 'Idle stock', idle.length],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tab active' : 'tab'}
                onClick={() => setTab(id)}
              >
                {label} <span className="count">{count}</span>
              </button>
            ))}
          </div>

          {selected && (
            <p className="filter-note">
              Showing lines for {data.plants.find((p) => p.id === selected)?.name ?? selected} only.{' '}
              <button className="link" onClick={() => setSelected(null)}>
                Show all plants
              </button>
            </p>
          )}

          <div role="tabpanel" className="table-wrap">
            {tab === 'transfers' && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Lane</th>
                      <th className="n">Qty</th>
                      <th className="n">Transit</th>
                      <th className="n">Freight</th>
                      <th className="n">Purchase avoided</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfers.map((x) => (
                      <tr key={`${x.material}${x.from}${x.to}`}>
                        <td>
                          <span className="mat">{x.material}</span>
                          <span className="desc">{describe(x.material)}</span>
                        </td>
                        <td className="codes">
                          {x.from} → {x.to}
                        </td>
                        <td className="n">{x.quantity}</td>
                        <td className="n">{x.transitDays} d</td>
                        <td className="n">{eur(x.freightCost)}</td>
                        <td className="n">{eur(x.avoidedPurchase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.transfers.length > 0 && (
                  <button className="secondary" onClick={exportTransfers}>
                    Download transfer list as CSV
                  </button>
                )}
              </>
            )}

            {tab === 'purchases' && (
              <table>
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Plant</th>
                    <th className="n">Qty</th>
                    <th className="n">Needed in</th>
                    <th className="n">Lead time</th>
                    <th className="n">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((x) => (
                    <tr key={`${x.material}${x.plant}`} className={x.late ? 'late' : undefined}>
                      <td>
                        <span className="mat">{x.material}</span>
                        <span className="desc">{describe(x.material)}</span>
                      </td>
                      <td className="codes">{x.plant}</td>
                      <td className="n">{x.quantity}</td>
                      <td className="n">{x.needByDays} d</td>
                      <td className="n">
                        {x.leadTimeDays} d{x.late && <span className="flag">late</span>}
                      </td>
                      <td className="n">{eur(x.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'unused' && (
              <ul className="reasons">
                {unused.map((x, i) => (
                  <li key={i}>
                    <span className="codes">
                      {x.material} {x.from} → {x.to}
                    </span>
                    <span className={`reason ${x.reason}`}>
                      {x.reason === 'too-slow' ? 'Too slow' : 'Not worth the handling cost'}
                    </span>
                    <span className="detail">{x.detail}</span>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'idle' && (
              <table>
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Plant</th>
                    <th className="n">Qty above need</th>
                    <th className="n">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {idle.map((x) => (
                    <tr key={`${x.material}${x.plant}`}>
                      <td>
                        <span className="mat">{x.material}</span>
                        <span className="desc">{describe(x.material)}</span>
                      </td>
                      <td className="codes">{x.plant}</td>
                      <td className="n">{x.quantity}</td>
                      <td className="n">{eur(x.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {((tab === 'transfers' && !transfers.length) ||
              (tab === 'purchases' && !purchases.length) ||
              (tab === 'unused' && !unused.length) ||
              (tab === 'idle' && !idle.length)) && <p className="empty">Nothing here for this selection.</p>}
          </div>
        </section>

        <aside className="controls">
          <section>
            <h2>Assumptions</h2>
            <p className="hint">The plan recalculates as you change these.</p>
            <Field
              label="Freight, € per kg per 1,000 km"
              value={settings.freightPerKgPer1000Km}
              step={0.05}
              onChange={(v) => setSettings({ ...settings, freightPerKgPer1000Km: v })}
            />
            <Field
              label="Fixed cost per transfer, €"
              value={settings.fixedCostPerTransfer}
              step={50}
              onChange={(v) => setSettings({ ...settings, fixedCostPerTransfer: v })}
            />
            <Field
              label="Transit speed, km per day"
              value={settings.transitKmPerDay}
              step={100}
              min={50}
              onChange={(v) => setSettings({ ...settings, transitKmPerDay: v })}
            />
            <Field
              label="Handling and customs, days"
              value={settings.handlingDays}
              step={1}
              onChange={(v) => setSettings({ ...settings, handlingDays: v })}
            />
            <Field
              label="Expedite surcharge on late purchases, %"
              value={settings.expediteSurchargePct}
              step={5}
              onChange={(v) => setSettings({ ...settings, expediteSurchargePct: v })}
            />
          </section>

          <section>
            <h2>Your data</h2>
            <p className="hint">
              Running on a synthetic sample. Upload your own exports; download a table to see the expected columns.
            </p>
            {uploadError && (
              <p className="error" role="alert">
                {uploadError}
              </p>
            )}
            {plan.warnings.map((w) => (
              <p key={w} className="error">
                {w}
              </p>
            ))}
            <ul className="tables">
              {(Object.keys(TABLE_INFO) as TableName[]).map((name) => (
                <li key={name}>
                  <div>
                    <span className="table-name">{TABLE_INFO[name].label}</span>
                    <span className="table-source">
                      {TABLE_INFO[name].source}, {data[name].length} rows
                    </span>
                  </div>
                  <div className="table-actions">
                    <label className="upload">
                      Upload
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) upload(name, f)
                          e.target.value = ''
                        }}
                      />
                    </label>
                    <button
                      className="link"
                      onClick={() => downloadText(TABLE_INFO[name].file, serializeTable(name, data[name]))}
                    >
                      Download
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <button
              className="secondary"
              onClick={() => {
                setData(SAMPLE)
                setSettings(DEFAULT_SETTINGS)
                setUploadError(null)
              }}
            >
              Reset to sample data
            </button>
          </section>
        </aside>
      </div>

      <footer className="footer">
        Solved in your browser as a fixed-charge transportation problem per material. Nothing is uploaded to a
        server. <a href="https://github.com/awaisq5/inventory-netting-optimizer">Source on GitHub</a>
      </footer>
    </div>
  )
}

function Field(props: { label: string; value: number; step: number; min?: number; onChange: (v: number) => void }) {
  const id = props.label.replace(/\W+/g, '-').toLowerCase()
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={props.value}
        step={props.step}
        min={props.min ?? 0}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v) && v >= (props.min ?? 0)) props.onChange(v)
        }}
      />
    </div>
  )
}
