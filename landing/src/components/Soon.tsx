import { motion } from 'framer-motion'
import './Soon.css'

export default function Soon() {
  return (
    <>
      <section className="soon">
        <div className="soon-glow" />
        <motion.span
          className="soon-chip"
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.6 }}
        >
          <span className="soon-chip-dot" />
          status
        </motion.span>
        <motion.h2
          className="soon-title"
          initial={{ opacity: 0, y: 26 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.8 }}
        >
          wait — <span className="soon-accent">coming soon.</span>
        </motion.h2>
        <motion.p
          className="soon-sub"
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.8, delay: 0.15 }}
        >
          The backend is all ready — init-service, orchestrator and runner are
          built and working. Deployment is next.
        </motion.p>
      </section>

      <footer className="footer">
        <span className="footer-name">ephemeral-sandbox-pod-scheduler</span>
        <span className="footer-meta">MIT License · one pod per project</span>
        <span className="footer-meta">Built by SHAURYA SHARMA</span>
      </footer>
    </>
  )
}
