import { motion, type Variants } from 'framer-motion'
import './Stack.css'

type Tech = {
  name: string
  abbr: string
  color: string
  role: string
}

const techs: Tech[] = [
  {
    name: 'Kubernetes',
    abbr: '⎈',
    color: '#326ce5',
    role: 'The heart of the platform. Every project becomes its own Deployment, Service and Ingress — scheduled, isolated, and resource-limited by the cluster.',
  },
  {
    name: 'Docker',
    abbr: '🐳',
    color: '#2496ed',
    role: 'Packages the runner image that every pod boots from — one image, infinitely many isolated instances of it.',
  },
  {
    name: 'nginx-ingress',
    abbr: 'ngx',
    color: '#009639',
    role: 'Wildcard subdomain routing. <replId>.yourdomain.com lands on exactly the right pod — both its WebSocket and the user\'s running app.',
  },
  {
    name: 'AWS S3',
    abbr: 'S3',
    color: '#ff9900',
    role: 'Durable source of truth. Base templates and every project\'s files live in the bucket, seeded into pods at startup.',
  },
  {
    name: 'Cloudflare R2',
    abbr: 'R2',
    color: '#f6821f',
    role: 'Drop-in S3-compatible alternative — the whole storage layer works against R2 with just a custom endpoint.',
  },
  {
    name: 'React',
    abbr: '⚛',
    color: '#61dafb',
    role: 'Drives the entire IDE surface — file tree, editor pane, terminal panel and live output, all in the browser.',
  },
  {
    name: 'TypeScript',
    abbr: 'TS',
    color: '#3178c6',
    role: 'End to end. All four services — frontend, init-service, orchestrator and runner — share one typed language.',
  },
  {
    name: 'Vite',
    abbr: '⚡',
    color: '#ffc820',
    role: 'Instant dev server and production bundler for the frontend.',
  },
  {
    name: 'Monaco Editor',
    abbr: 'M',
    color: '#0098ff',
    role: 'The editor that powers VS Code, embedded in the page — syntax highlighting, IntelliSense feel, the works.',
  },
  {
    name: 'xterm.js',
    abbr: '>_',
    color: '#33ff88',
    role: 'A full terminal emulator rendered in the browser, wired to a real shell running inside the pod.',
  },
  {
    name: 'node-pty',
    abbr: 'pty',
    color: '#8cc84b',
    role: 'Spawns genuine pseudo-terminals inside each pod — real bash, real processes, not a simulation.',
  },
  {
    name: 'Socket.IO',
    abbr: 'ws',
    color: '#f472b6',
    role: 'The realtime spine. File edits, terminal keystrokes and output all stream over one WebSocket per project.',
  },
  {
    name: 'Express',
    abbr: 'ex',
    color: '#9da8b9',
    role: 'The HTTP layer of every backend service — project creation, pod scheduling, and the runner itself.',
  },
  {
    name: 'kubernetes client-node',
    abbr: 'k8s',
    color: '#a78bfa',
    role: 'Talks to the cluster programmatically — the orchestrator creates Deployments, Services and Ingresses via the raw Kubernetes API.',
  },
  {
    name: 'YAML',
    abbr: 'yml',
    color: '#cb4b5f',
    role: 'One parameterized manifest template; the replId is substituted across every document before it hits the cluster.',
  },
]

const item: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.97 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] },
  },
}

const grid: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

export default function Stack() {
  return (
    <section className="stack" id="stack">
      <div className="stack-inner">
        <motion.div
          className="stack-header"
          initial={{ opacity: 0, y: 28 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.7 }}
        >
          <span className="eyebrow">the stack</span>
          <h2 className="section-title">Built on real infrastructure.</h2>
          <p className="section-sub">
            No magic, no black boxes — fifteen deliberate pieces of technology,
            each pulling its weight from the browser down to the cluster.
          </p>
        </motion.div>

        <motion.div
          className="stack-grid"
          variants={grid}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.1 }}
        >
          {techs.map((t) => (
            <motion.div
              className="tech-card"
              key={t.name}
              variants={item}
              whileHover={{ y: -6, transition: { duration: 0.2 } }}
              style={{ '--t-color': t.color } as React.CSSProperties}
            >
              <div className="tech-tile">{t.abbr}</div>
              <div className="tech-text">
                <h3>{t.name}</h3>
                <p>{t.role}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
