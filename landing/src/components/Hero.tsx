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
            <a
              className="btn btn-ghost"
              href="https://github.com/ShauryaaSharma/Ephemeral-Sandbox-Pod-Scheduler"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                className="btn-octocat"
                viewBox="0 0 16 16"
                width="18"
                height="18"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              View repo on GitHub
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
