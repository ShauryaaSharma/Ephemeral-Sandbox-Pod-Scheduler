import { motion } from 'framer-motion'
import Terminal from './Terminal'
import './Hero.css'

export default function Hero() {
  return (
    <header className="hero" id="top">
      <div className="hero-glow hero-glow-1" />
      <div className="hero-glow hero-glow-2" />
      <div className="hero-grid" />

      <div className="hero-inner">
        <motion.div
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, ease: 'easeOut' }}
        >
          <span className="hero-pill">
            <span className="hero-pill-icon">⎈</span>
            one pod per project · real isolation
          </span>

          <h1 className="hero-title">
            Every project gets
            <br />
            <span className="hero-title-accent">its own pod.</span>
          </h1>

          <p className="hero-sub">
            A browser IDE that schedules a dedicated Kubernetes pod the moment
            you open a project — its own filesystem, its own shell, its own
            subdomain. Torn down independently, never shared.
          </p>

          <div className="hero-cta">
            <button className="btn btn-primary" disabled>
              <span className="btn-shimmer" />
              Launching soon
            </button>
            <a className="btn btn-ghost" href="#what">
              See how it works
              <motion.span
                className="btn-arrow"
                animate={{ y: [0, 4, 0] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              >
                ↓
              </motion.span>
            </a>
          </div>
        </motion.div>

        <motion.div
          className="ide"
          initial={{ opacity: 0, y: 44 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.25, ease: 'easeOut' }}
        >
          <div className="ide-bar">
            <span className="ide-dot red" />
            <span className="ide-dot yellow" />
            <span className="ide-dot green" />
            <span className="ide-url">my-app.yourdomain.com</span>
          </div>
          <div className="ide-body">
            <div className="ide-editor">
              <div className="ide-tab">service.yaml</div>
              <pre className="ide-code">
                <span className="c-key">apiVersion</span>: <span className="c-str">apps/v1</span>{'\n'}
                <span className="c-key">kind</span>: <span className="c-str">Deployment</span>{'\n'}
                <span className="c-key">metadata</span>:{'\n'}
                {'  '}<span className="c-key">name</span>: <span className="c-var">my-app</span>{'\n'}
                <span className="c-key">spec</span>:{'\n'}
                {'  '}<span className="c-key">containers</span>:{'\n'}
                {'    '}- <span className="c-key">image</span>: <span className="c-str">runner:latest</span>{'\n'}
                {'      '}<span className="c-key">volumeMounts</span>:{'\n'}
                {'        '}- <span className="c-key">mountPath</span>: <span className="c-str">/workspace</span>
              </pre>
            </div>
            <div className="ide-terminal">
              <div className="ide-tab">terminal</div>
              <Terminal />
            </div>
          </div>
        </motion.div>
      </div>
    </header>
  )
}
