import { motion, type Variants } from 'framer-motion'
import './SystemDesign.css'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 32 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
  },
}

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
}

const principles = [
  {
    icon: '💤',
    color: 'var(--cyan)',
    title: 'Idle pods reap themselves',
    body: 'A background loop tracks every project\'s last activity and auto-stops anything left idle past a configurable timeout — with a final S3/R2 sync first, so a forgotten tab never bleeds cluster capacity.',
  },
  {
    icon: '🩺',
    color: 'var(--green)',
    title: 'Crash-loops get noticed',
    body: 'A health monitor polls every running project, flags CrashLoopBackOff and repeated restarts, surfaces it through /status and an unhealthy banner in the editor, and can fire a webhook alert.',
  },
  {
    icon: '📊',
    color: 'var(--accent)',
    title: 'Capacity is checked, not assumed',
    body: '/start checks the cluster has room before it schedules anything. Out of capacity returns a clear 503 instead of overloading nodes or leaving a pod half-scheduled.',
  },
  {
    icon: '🛟',
    color: 'var(--violet)',
    title: 'Shutdown is bounded, always',
    body: 'Both /stop and SIGTERM trigger a final re-sync of /workspace to storage — but every path is time-boxed. A stuck or unreachable pod logs a warning and teardown proceeds anyway; nothing ever hangs waiting on it.',
  },
  {
    icon: '🚦',
    color: 'var(--blue)',
    title: 'Per-user rate limiting',
    body: 'Token-bucket limits on project creation and pod starts cap how fast any single caller can spend cluster resources — a basic guard against one user (or one bug) crowding out everyone else.',
  },
  {
    icon: '🧭',
    color: 'var(--pink)',
    title: 'Trade-offs, documented not hidden',
    body: 'Where a real limitation exists — shared-storage requirements for the ownership store, hairpin-NAT routing if the schedulers run in-cluster — it\'s written down in the README, not papered over.',
  },
]

export default function SystemDesign() {
  return (
    <section className="sysdesign" id="system-design">
      <div className="sysdesign-inner">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
        >
          <span className="eyebrow">system design</span>
          <h2 className="section-title">
            Designed to degrade
            <br />
            gracefully, not silently fail.
          </h2>
          <p className="section-sub">
            Ephemeral compute means things go wrong constantly — pods crash,
            callers disappear mid-session, clusters run out of room. The goal
            was never to prevent that; it was to make sure it's always
            handled, logged, and bounded.
          </p>
        </motion.div>

        <motion.div
          className="sysdesign-grid"
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
        >
          {principles.map((p) => (
            <motion.div
              className="sysdesign-card"
              key={p.title}
              variants={fadeUp}
              whileHover={{ y: -6 }}
              style={{ '--p-color': p.color } as React.CSSProperties}
            >
              <span className="sysdesign-card-icon">{p.icon}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
