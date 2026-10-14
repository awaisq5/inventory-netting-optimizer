import type { Plan, Plant } from '../domain/types'

const W = 960
const H = 440
// Crop of the world that holds the sample network; data outside still renders, clamped to the edge.
const LON_MIN = -115
const LON_MAX = 135
const LAT_MIN = -42
const LAT_MAX = 68

function project(p: { lat: number; lon: number }) {
  const x = ((p.lon - LON_MIN) / (LON_MAX - LON_MIN)) * W
  const y = ((LAT_MAX - p.lat) / (LAT_MAX - LAT_MIN)) * H
  return { x: Math.min(W - 12, Math.max(12, x)), y: Math.min(H - 12, Math.max(12, y)) }
}

type Dir = 'right' | 'left' | 'above' | 'below'

const DIRS: Record<Dir, { x: number; y: number }> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  above: { x: 0, y: -1 },
  below: { x: 0, y: 1 },
}

/**
 * Put each label on the side with the least in the way: nearby plants weigh
 * heavily, lanes leaving the plant weigh a little.
 */
function labelSides(
  points: Map<string, { x: number; y: number }>,
  partners: Map<string, Set<string>>,
): Map<string, Dir> {
  const sides = new Map<string, Dir>()
  for (const [id, p] of points) {
    const pulls: { x: number; y: number; w: number }[] = []
    for (const [other, q] of points) {
      if (other === id) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1
      const near = d < 110 ? 3 : 0
      const lane = partners.get(id)?.has(other) ? 1 : 0
      if (near + lane) pulls.push({ x: (q.x - p.x) / d, y: (q.y - p.y) / d, w: near + lane })
    }
    let best: Dir = 'right'
    let bestScore = Infinity
    for (const dir of Object.keys(DIRS) as Dir[]) {
      const v = DIRS[dir]
      // Penalise directions pointing at obstacles; slight preference for right.
      const score =
        pulls.reduce((acc, u) => acc + u.w * Math.max(0, u.x * v.x + u.y * v.y), 0) + (dir === 'right' ? 0 : 0.05)
      if (score < bestScore) {
        bestScore = score
        best = dir
      }
    }
    sides.set(id, best)
  }
  return sides
}

function labelPos(p: { x: number; y: number }, dir: Dir) {
  switch (dir) {
    case 'left':
      return { x: p.x - 12, y: p.y + 5, anchor: 'end' as const }
    case 'above':
      return { x: p.x, y: p.y - 13, anchor: 'middle' as const }
    case 'below':
      return { x: p.x, y: p.y + 22, anchor: 'middle' as const }
    default:
      return { x: p.x + 12, y: p.y + 5, anchor: 'start' as const }
  }
}

interface Props {
  plants: Plant[]
  plan: Plan
  selected: string | null
  onSelect: (plant: string | null) => void
}

export function NetworkMap({ plants, plan, selected, onSelect }: Props) {
  const points = new Map(plants.map((p) => [p.id, project(p)]))
  const partners = new Map<string, Set<string>>()
  for (const t of plan.transfers) {
    if (!partners.has(t.from)) partners.set(t.from, new Set())
    if (!partners.has(t.to)) partners.set(t.to, new Set())
    partners.get(t.from)!.add(t.to)
    partners.get(t.to)!.add(t.from)
  }
  const sides = labelSides(points, partners)
  const latePlants = new Set(plan.purchases.filter((p) => p.late).map((p) => p.plant))

  // One line per lane, however many materials travel on it.
  const lanes = new Map<string, { from: string; to: string; value: number; units: number }>()
  for (const t of plan.transfers) {
    const k = `${t.from}|${t.to}`
    const lane = lanes.get(k) ?? { from: t.from, to: t.to, value: 0, units: 0 }
    lane.value += t.avoidedPurchase
    lane.units += t.quantity
    lanes.set(k, lane)
  }
  const maxValue = Math.max(1, ...[...lanes.values()].map((l) => l.value))

  return (
    <figure className="map">
      <div className="map-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Network of plants with proposed stock transfers">
        <g className="graticule" aria-hidden="true">
          {[-30, 0, 30, 60].map((lat) => {
            const y = project({ lat, lon: 0 }).y
            return <line key={`lat${lat}`} x1={0} x2={W} y1={y} y2={y} />
          })}
          {[-90, -60, -30, 0, 30, 60, 90, 120].map((lon) => {
            const x = project({ lat: 0, lon }).x
            return <line key={`lon${lon}`} x1={x} x2={x} y1={0} y2={H} />
          })}
        </g>

        <g>
          {[...lanes.values()].map((lane) => {
            const a = points.get(lane.from)
            const b = points.get(lane.to)
            if (!a || !b) return null
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const len = Math.hypot(b.x - a.x, b.y - a.y)
            // Bow every arc upward-left of its direction so opposite lanes do not overlap.
            const nx = -(b.y - a.y) / (len || 1)
            const ny = (b.x - a.x) / (len || 1)
            const bow = Math.min(70, len * 0.16)
            const d = `M${a.x},${a.y} Q${mx + nx * bow},${my + ny * bow} ${b.x},${b.y}`
            const width = 1.5 + 5 * (lane.value / maxValue)
            const dim = selected && lane.from !== selected && lane.to !== selected
            return (
              <g key={`${lane.from}-${lane.to}`} className={`lane${dim ? ' dim' : ''}`}>
                <title>{`${lane.from} to ${lane.to}: ${lane.units} units`}</title>
                <path d={d} className="lane-casing" strokeWidth={width + 2.5} />
                <path d={d} className="lane-tape" strokeWidth={width} />
              </g>
            )
          })}
        </g>

        <g>
          {plants.map((p) => {
            const pt = points.get(p.id)!
            const label = labelPos(pt, sides.get(p.id) ?? 'right')
            const isSelected = selected === p.id
            return (
              <g
                key={p.id}
                className={`node${isSelected ? ' selected' : ''}${latePlants.has(p.id) ? ' late' : ''}`}
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-label={`${p.name} (${p.id})${latePlants.has(p.id) ? ', has late purchases' : ''}`}
                onClick={() => onSelect(isSelected ? null : p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(isSelected ? null : p.id)
                  }
                }}
              >
                <circle cx={pt.x} cy={pt.y} r={14} className="hit" />
                <circle cx={pt.x} cy={pt.y} r={7} className="dot" />
                <text x={label.x} y={label.y} textAnchor={label.anchor} className="code">
                  {p.id}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      </div>
      <figcaption>
        <span className="key key-tape" /> Proposed transfer, thicker means more purchase value avoided
        <span className="key key-late" /> Plant with a purchase that misses its need date
        <span className="hint">Select a plant to filter the lists below.</span>
      </figcaption>
    </figure>
  )
}
