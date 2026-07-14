import { useEffect, useRef, useState } from 'react'

type Line = { text: string; cls?: string; pause?: number }

const script: Line[] = [
  { text: '$ open my-app', cls: 'cmd' },
  { text: '→ POST /start { "replId": "my-app" }', cls: 'dim', pause: 400 },
  { text: '✔ deployment.apps/my-app created', cls: 'ok', pause: 260 },
  { text: '✔ service/my-app created', cls: 'ok', pause: 260 },
  { text: '✔ ingress/my-app created', cls: 'ok', pause: 260 },
  { text: '⧗ init: aws s3 cp code/my-app → /workspace', cls: 'dim', pause: 500 },
  { text: '● pod Running — my-app.yourdomain.com', cls: 'live', pause: 900 },
]

export default function Terminal() {
  const [lines, setLines] = useState<string[]>([''])
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    let li = 0
    let ci = 0

    const tick = () => {
      const current = script[li]
      if (ci < current.text.length) {
        ci++
        setLines((prev) => {
          const next = [...prev]
          next[li] = current.text.slice(0, ci)
          return next
        })
        timer.current = setTimeout(tick, current.cls === 'cmd' ? 55 : 14)
      } else if (li < script.length - 1) {
        li++
        ci = 0
        setLines((prev) => [...prev, ''])
        timer.current = setTimeout(tick, script[li - 1].pause ?? 200)
      } else {
        setDone(true)
      }
    }

    timer.current = setTimeout(tick, 900)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className="term">
      {lines.map((line, i) => (
        <div className={`term-line ${script[i]?.cls ?? ''}`} key={i}>
          {line}
          {i === lines.length - 1 && !done && <span className="term-caret" />}
        </div>
      ))}
      {done && (
        <div className="term-line cmd">
          $ <span className="term-caret" />
        </div>
      )}
    </div>
  )
}
