import { useEffect, useState } from 'react'
import { initOcr, getOcrReadyState, onOcrReadyChange, type OcrReadyState } from '../api/ocr'
import { checkHealth, type HealthResponse } from '../api/client'

const SAFETY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const HEALTH_POLL_MS = 2_000

interface ProgressState {
  phase: string
  current: number
  total: number
}

export default function SplashScreen() {
  const [dismissed, setDismissed] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<OcrReadyState>(getOcrReadyState)
  const [serverReady, setServerReady] = useState(false)
  const [progress, setProgress] = useState<ProgressState | null>(null)

  // OCR init + subscribe
  useEffect(() => {
    initOcr()
    const unsub = onOcrReadyChange(setOcrStatus)
    const timer = setTimeout(() => setDismissed(true), SAFETY_TIMEOUT_MS)
    return () => { unsub(); clearTimeout(timer) }
  }, [])

  // Poll server health
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      while (!cancelled) {
        try {
          const resp: HealthResponse = await checkHealth()
          if (resp.progress) setProgress(resp.progress)
          else setProgress(null)
          if (resp.ready) { setServerReady(true); return }
        } catch { /* server not up yet */ }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // Dismiss when both ready
  useEffect(() => {
    const ocrDone = ocrStatus === 'ready' || ocrStatus === 'error'
    if (ocrDone && serverReady) setDismissed(true)
  }, [ocrStatus, serverReady])

  if (dismissed) return null

  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : null

  let message: string
  if (!serverReady && progress) {
    switch (progress.phase) {
      case 'downloading':
        message = pct !== null
          ? `Downloading product database... ${pct}%`
          : `Downloading product database...`
        break
      case 'querying':
        message = 'Processing products...'
        break
      case 'upserting':
        message = progress.total > 0
          ? `Loading products... ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
          : 'Loading products...'
        break
      default:
        message = 'Server starting up...'
    }
  } else if (!serverReady) {
    message = 'Server starting up...'
  } else if (ocrStatus === 'loading') {
    message = 'Loading OCR engine...'
  } else {
    message = 'Ready'
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gray-50">
      <div className="text-6xl">🚫🥥🚫</div>
      <h1 className="mt-4 text-3xl font-bold text-gray-800">CocoNot</h1>
      <p className="mt-3 text-sm text-gray-500">{message}</p>
      {progress && !serverReady && (
        <div className="mt-4 w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: pct !== null ? `${pct}%` : '100%' }}
          />
        </div>
      )}
    </div>
  )
}
