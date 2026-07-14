import { motion, type Variants } from 'framer-motion'
import './HowItWorks.css'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 32 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
  },
}

const steps = [
  {
    num: '01',
    color: 'var(--accent)',
    title: 'Create a project',
    chip: 'POST /project',
    body: 'The init-service copies a base template — node-js or python — from the bucket into code/<replId> on S3 / Cloudflare R2. This step only prepares storage; not a single container is started yet.',
  },
  {
    num: '02',
    color: 'var(--violet)',
    title: 'Schedule the pod',
    chip: 'POST /start',
    body: 'The orchestrator takes a parameterized Kubernetes manifest, substitutes the replId across every document, and creates a Deployment, a Service, and an Ingress through the Kubernetes API. An init container seeds /workspace from the bucket before the runner boots.',
  },
  {
    num: '03',
    color: 'var(--cyan)',
    title: 'Edit & run',
    chip: 'ws://<replId>.domain',
    body: 'The browser opens a Socket.IO connection straight to the pod\'s own subdomain. The runner identifies its project from the Host header, Monaco edits files in /workspace, and node-pty streams a real shell — every keystroke, live.',
  },
  {
    num: '04',
    color: 'var(--green)',
    title: 'Preview at a real URL',
    chip: 'http://<replId>.domain',
    body: 'Anything the user starts on port 3000 inside their terminal becomes reachable at the project\'s own subdomain, routed by nginx-ingress straight to the pod. Not a hardcoded localhost — a real, shareable URL.',
  },
]

export default function HowItWorks() {
  return (
    <section className="how" id="how">
      <div className="how-inner">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
          className="how-header"
        >
          <span className="eyebrow">how it works</span>
          <h2 className="section-title">From click to pod in four steps.</h2>
          <p className="section-sub">
            Open a project and the platform walks a straight line: seed
            storage, schedule compute, connect a socket, route a subdomain.
          </p>
        </motion.div>

        <div className="how-steps">
          <div className="how-rail" />
          {steps.map((s, i) => (
            <motion.div
              className="how-step"
              key={s.num}
              initial={{ opacity: 0, x: i % 2 === 0 ? -36 : 36 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.45 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              style={{ '--s-color': s.color } as React.CSSProperties}
            >
              <div className="how-num">{s.num}</div>
              <div className="how-content">
                <div className="how-title-row">
                  <h3>{s.title}</h3>
                  <code className="how-chip">{s.chip}</code>
                </div>
                <p>{s.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
