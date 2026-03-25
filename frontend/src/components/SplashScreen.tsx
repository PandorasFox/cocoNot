import { useEffect, useState } from 'react'
import { initOcr, getOcrReadyState, onOcrReadyChange, type OcrReadyState } from '../api/ocr'

const SAFETY_TIMEOUT_MS = 15_000

export default function SplashScreen() {
  const [dismissed, setDismissed] = useState(false)
  const [status, setStatus] = useState<OcrReadyState>(getOcrReadyState)

  useEffect(() => {
    initOcr()
    const unsub = onOcrReadyChange(setStatus)
    const timer = setTimeout(() => setDismissed(true), SAFETY_TIMEOUT_MS)
    return () => { unsub(); clearTimeout(timer) }
  }, [])

  // Dismiss once ready or error
  useEffect(() => {
    if (status === 'ready' || status === 'error') {
      setDismissed(true)
    }
  }, [status])

  if (dismissed) return null

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gray-50">
      <div className="text-6xl">🚫🥥🚫</div>
      <h1 className="mt-4 text-3xl font-bold text-gray-800">CocoNot</h1>
      <p className="mt-3 text-sm text-gray-500">
        {status === 'loading' ? 'Loading OCR engine...' : 'Ready'}
      </p>
    </div>
  )
}
