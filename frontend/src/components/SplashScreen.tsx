import { useEffect, useState } from 'react'
import { initOcr, getOcrReadyState, onOcrReadyChange, type OcrReadyState } from '../api/ocr'
import { checkHealth } from '../api/client'

const SAFETY_TIMEOUT_MS = 15_000
const HEALTH_POLL_MS = 2_000

export default function SplashScreen() {
  const [dismissed, setDismissed] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<OcrReadyState>(getOcrReadyState)
  const [serverReady, setServerReady] = useState(false)

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
          const { ready } = await checkHealth()
          if (ready) { setServerReady(true); return }
        } catch { /* server not up yet */ }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // Dismiss when both ready (or either errors/timeouts via safety timer)
  useEffect(() => {
    const ocrDone = ocrStatus === 'ready' || ocrStatus === 'error'
    if (ocrDone && serverReady) setDismissed(true)
  }, [ocrStatus, serverReady])

  if (dismissed) return null

  let message: string
  if (!serverReady) {
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
    </div>
  )
}
