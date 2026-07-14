import { motion, type Variants } from 'framer-motion'
import './What.css'

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
  show: { transition: { staggerChildren: 0.14 } },
}

const features = [
  {
    icon: '⎈',
    color: 'var(--blue)',
    title: 'Real isolation, not a shared host',
    body: 'Every project runs in its own Kubernetes pod — a dedicated Deployment with its own filesystem, CPU and memory limits, and a real shell. No noisy neighbours, no shared process.',
  },
  {
    icon: '⌁',
    color: 'var(--accent)',
    title: 'Its own live URL',
    body: 'nginx-ingress routes <replId>.yourdomain.com straight to the pod. Start anything on port 3000 inside the terminal and it is instantly reachable at a real, per-project subdomain.',
  },
  {
    icon: '◈',
    color: 'var(--green)',
    title: 'Disposable compute, durable storage',
    body: 'Pods are throwaway. The source of truth lives in S3 / Cloudflare R2 — an init container seeds /workspace from the bucket at startup, and every file save syncs straight back.',
  },
]

export default function What() {
  return (
    <section className="what" id="what">
      <div className="what-inner">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
        >
          <span className="eyebrow">what it is</span>
          <h2 className="section-title">
            A cloud IDE, rebuilt
            <br />
            around isolation.
          </h2>
          <p className="section-sub">
            A browser-based code editor and terminal where opening a project
            doesn't join a shared server — it schedules dedicated compute.
            Write code in Monaco, run commands in a real PTY, preview your app
            live — all inside a pod that exists just for that one project, and
            dies with it.
          </p>
        </motion.div>

        <motion.div
          className="what-grid"
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.25 }}
        >
          {features.map((f) => (
            <motion.div
              className="what-card"
              key={f.title}
              variants={fadeUp}
              whileHover={{ y: -6 }}
              style={{ '--f-color': f.color } as React.CSSProperties}
            >
              <span className="what-card-icon">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
