import { motion, type Variants } from 'framer-motion'
import './Security.css'

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

const measures = [
  {
    icon: '🔐',
    color: 'var(--accent)',
    title: 'JWT-backed session auth',
    body: 'Every request into init-service and orchestrator-simple carries a signed JWT, minted anonymously on first visit and cached in the browser. No project is created, no pod is scheduled, without a valid token.',
  },
  {
    icon: '🗝',
    color: 'var(--violet)',
    title: 'Ownership, checked every time',
    body: 'The first caller to create a replId owns it — recorded in a shared SQLite table. Every later /start, /project, or socket handshake checks the caller\'s userId against that record before touching a pod.',
  },
  {
    icon: '🔏',
    color: 'var(--cyan)',
    title: 'Secrets never live in YAML',
    body: 'Storage credentials and the JWT secret sit in a Kubernetes Secret, injected via secretKeyRef at pod-creation time. Committed manifests only ever contain placeholders — nothing real is checked in.',
  },
  {
    icon: '🧱',
    color: 'var(--green)',
    title: 'NetworkPolicy pod isolation',
    body: 'Each project pod\'s NetworkPolicy accepts ingress only from nginx-ingress and denies pod-to-pod traffic outright — one project can\'t reach another\'s terminal or filesystem, even from inside the cluster network.',
  },
  {
    icon: '⛶',
    color: 'var(--blue)',
    title: 'A namespace per project',
    body: 'Every project is scheduled into its own Kubernetes namespace, not a shared one. A compromised or misbehaving pod\'s blast radius stops at its own namespace boundary, and teardown is one namespace deletion.',
  },
  {
    icon: '🔒',
    color: 'var(--pink)',
    title: 'TLS via cert-manager',
    body: 'A cluster-wide wildcard certificate from Let\'s Encrypt switches every project\'s subdomain from http/ws to https/wss. Opt-in by design, so a fresh setup isn\'t forced through cert-manager just to run.',
  },
]

export default function Security() {
  return (
    <section className="security" id="security">
      <div className="security-inner">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
        >
          <span className="eyebrow">security</span>
          <h2 className="section-title">
            Isolation isn't a checkbox
            <br />
            — it's the architecture.
          </h2>
          <p className="section-sub">
            Every layer of this platform was built assuming one project's pod
            will eventually try to do something to another's. Here's what
            actually stands in the way.
          </p>
        </motion.div>

        <motion.div
          className="security-grid"
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
        >
          {measures.map((m) => (
            <motion.div
              className="security-card"
              key={m.title}
              variants={fadeUp}
              whileHover={{ y: -6 }}
              style={{ '--m-color': m.color } as React.CSSProperties}
            >
              <span className="security-card-icon">{m.icon}</span>
              <h3>{m.title}</h3>
              <p>{m.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
