import { motion } from 'framer-motion'
import './Nav.css'

export default function Nav() {
  return (
    <motion.nav
      className="nav"
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: 'easeOut' }}
    >
      <div className="nav-inner">
        <a className="nav-brand" href="#top">
          <span className="nav-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="2.6" fill="currentColor" />
            </svg>
          </span>
          <span className="nav-name">
            ephemeral<span className="nav-name-dim">-sandbox</span>
          </span>
        </a>

        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#stack">Stack</a>
          <span className="nav-badge">
            <span className="nav-badge-dot" />
            coming soon
          </span>
        </div>
      </div>
    </motion.nav>
  )
}
