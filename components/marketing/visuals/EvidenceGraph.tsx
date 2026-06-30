import React from "react"
import { FileCheck2, Database, GitBranch, Sparkles, ShieldCheck } from "lucide-react"

const edges: Array<{ x1: number; y1: number; x2: number; y2: number; delay: string }> = [
  { x1: 100, y1: 280, x2: 200, y2: 180, delay: "0.1s" },
  { x1: 200, y1: 180, x2: 320, y2: 130, delay: "0.35s" },
  { x1: 200, y1: 180, x2: 240, y2: 300, delay: "0.6s" },
  { x1: 320, y1: 130, x2: 380, y2: 220, delay: "0.85s" },
  { x1: 240, y1: 300, x2: 380, y2: 220, delay: "1.1s" },
  { x1: 100, y1: 280, x2: 160, y2: 340, delay: "1.3s" },
  { x1: 380, y1: 220, x2: 430, y2: 310, delay: "1.5s" },
  { x1: 240, y1: 300, x2: 160, y2: 340, delay: "1.7s" },
]

const nodes: Array<{ cx: number; cy: number; r: number; variant: "primary" | "secondary" | "muted" }> = [
  { cx: 100, cy: 280, r: 7,  variant: "secondary" },
  { cx: 200, cy: 180, r: 11, variant: "primary" },
  { cx: 320, cy: 130, r: 9,  variant: "primary" },
  { cx: 240, cy: 300, r: 8,  variant: "secondary" },
  { cx: 380, cy: 220, r: 12, variant: "primary" },
  { cx: 160, cy: 340, r: 6,  variant: "muted" },
  { cx: 430, cy: 310, r: 7,  variant: "secondary" },
  { cx: 140, cy: 140, r: 5,  variant: "muted" },
  { cx: 440, cy: 120, r: 5,  variant: "muted" },
]

const floatingCards = [
  {
    icon: FileCheck2,
    label: "Evidencia",
    cls: "top-4 left-0 animate-card-float motion-reduce:animate-none [animation-delay:0s]",
  },
  {
    icon: Database,
    label: "Proxy",
    cls: "top-[28%] right-0 animate-float-soft motion-reduce:animate-none [animation-delay:1.2s]",
  },
  {
    icon: GitBranch,
    label: "Filtro SROI",
    cls: "bottom-[30%] left-2 animate-float-soft motion-reduce:animate-none [animation-delay:2.4s]",
  },
  {
    icon: Sparkles,
    label: "Stella Review",
    cls: "bottom-8 right-6 animate-card-float motion-reduce:animate-none [animation-delay:0.8s]",
  },
  {
    icon: ShieldCheck,
    label: "Reporte audit-ready",
    cls: "bottom-2 left-[30%] animate-float-soft motion-reduce:animate-none [animation-delay:1.8s]",
  },
]

const nodeColors = {
  primary:   { fill: "#134e4a", stroke: "#2dd4bf", strokeWidth: 1.5 },
  secondary: { fill: "#1e293b", stroke: "#64748b", strokeWidth: 1 },
  muted:     { fill: "#0f172a", stroke: "#334155", strokeWidth: 1 },
}

export function EvidenceGraph() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-[360px] w-full max-w-[500px] select-none lg:h-[420px]"
    >
      {/* SVG network */}
      <svg
        viewBox="0 0 520 400"
        className="absolute inset-0 h-full w-full"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
          </radialGradient>
          <filter id="nodeSoftGlow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Ambient glow at center */}
        <ellipse
          cx="300"
          cy="220"
          rx="180"
          ry="140"
          fill="url(#coreGlow)"
          className="animate-pulse-glow motion-reduce:animate-none"
        />

        {/* Edges */}
        <g stroke="rgba(45,212,191,0.22)" strokeWidth="1">
          {edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              pathLength="1"
              className="animate-draw-line motion-reduce:animate-none"
              style={{ animationDelay: e.delay }}
            />
          ))}
        </g>

        {/* Nodes */}
        <g filter="url(#nodeSoftGlow)">
          {nodes.map((n, i) => {
            const c = nodeColors[n.variant]
            return (
              <circle
                key={i}
                cx={n.cx}
                cy={n.cy}
                r={n.r}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={c.strokeWidth}
                className={n.variant === "primary" ? "animate-pulse-glow motion-reduce:animate-none" : ""}
                style={n.variant === "primary" ? { animationDelay: `${i * 0.3}s` } : undefined}
              />
            )
          })}
        </g>
      </svg>

      {/* Floating label cards */}
      {floatingCards.map(({ icon: Icon, label, cls }) => (
        <div
          key={label}
          className={`absolute flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-200 shadow-lg shadow-black/30 backdrop-blur-sm ${cls}`}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-teal-400" />
          {label}
        </div>
      ))}
    </div>
  )
}
