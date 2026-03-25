import { useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductByBarcode } from '../api/client'
import { detectBarcode } from '../api/barcode'

type ScanState =
  | { status: 'idle' }
  | { status: 'processing' }
  | { status: 'error'; message: string }

export default function BarcodeScanner() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<ScanState>({ status: 'idle' })

  const handleCapture = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      setState({ status: 'processing' })

      try {
        const sku = await detectBarcode(file)
        if (!sku) {
          setState({ status: 'error', message: 'No barcode found. Try again with the barcode centered in frame.' })
          return
        }

        // Try to look up the product by barcode
        try {
          const product = await getProductByBarcode(sku)
          setState({ status: 'idle' })
          navigate(`/product/${product.id}`)
        } catch {
          // Not in our DB — navigate to search with the SKU prefilled
          setState({ status: 'idle' })
          navigate(`/?q=${encodeURIComponent(sku)}`)
        }
      } catch {
        setState({ status: 'error', message: 'Could not read barcode. Try a clearer photo.' })
      } finally {
        // Reset the input so the same file can be re-selected
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [navigate],
  )

  const dismiss = useCallback(() => setState({ status: 'idle' }), [])

  return (
    <>
      {/* Error toast */}
      {state.status === 'error' && (
        <div className="fixed bottom-20 left-1/2 z-50 w-[90vw] max-w-lg -translate-x-1/2">
          <div className="flex items-start gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg">
            <span className="flex-1">{state.message}</span>
            <button onClick={dismiss} className="font-bold hover:opacity-70">
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Processing overlay */}
      {state.status === 'processing' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-lg bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-lg">
            Reading barcode...
          </div>
        </div>
      )}

      {/* Hidden file input — capture="environment" triggers rear camera on mobile */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCapture}
        className="hidden"
      />

      {/* Sticky footer button */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-lg -translate-x-1/2 p-3">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={state.status === 'processing'}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3.5 text-base font-semibold text-white shadow-lg transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            {/* Simple barcode icon */}
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <line x1="6" y1="8" x2="6" y2="16" />
            <line x1="8.5" y1="8" x2="8.5" y2="16" />
            <line x1="11" y1="8" x2="11" y2="16" />
            <line x1="14" y1="8" x2="14" y2="16" />
            <line x1="16.5" y1="8" x2="16.5" y2="16" />
            <line x1="18" y1="8" x2="18" y2="16" />
          </svg>
          Barcode Scanner
        </button>
      </div>
    </>
  )
}
