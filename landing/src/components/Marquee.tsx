import './Marquee.css'

const techs = [
  'Kubernetes', 'React', 'TypeScript', 'Docker', 'Socket.IO', 'Monaco Editor',
  'xterm.js', 'node-pty', 'Express', 'Vite', 'nginx-ingress', 'AWS S3',
  'Cloudflare R2', 'Node.js', 'YAML',
]

export default function Marquee() {
  const row = [...techs, ...techs]
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {row.map((t, i) => (
          <span className="marquee-item" key={i}>
            {t}
            <span className="marquee-sep">◆</span>
          </span>
        ))}
      </div>
    </div>
  )
}
