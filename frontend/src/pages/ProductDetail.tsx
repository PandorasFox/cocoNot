import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getProduct, createFlag, type ProductDetail as ProductDetailType } from '../api/client'
import StatusBadge from '../components/StatusBadge'
import Disclaimer from '../components/Disclaimer'

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>()
  const [product, setProduct] = useState<ProductDetailType | null>(null)
  const [error, setError] = useState('')
  const [flagNotes, setFlagNotes] = useState('')
  const [flagSubmitted, setFlagSubmitted] = useState(false)

  useEffect(() => {
    if (!id) return
    getProduct(id)
      .then(setProduct)
      .catch(() => setError('Product not found'))
  }, [id])

  const handleFlag = async (flagType: string) => {
    if (!id) return
    try {
      await createFlag(id, flagType, flagNotes)
      setFlagSubmitted(true)
      // Refresh product
      const updated = await getProduct(id)
      setProduct(updated)
    } catch {
      setError('Failed to submit flag')
    }
  }

  if (error) {
    return (
      <div className="p-4">
        <Link to="/" className="text-sm text-amber-700">&larr; Back</Link>
        <p className="mt-4 text-red-600">{error}</p>
      </div>
    )
  }

  if (!product) {
    return <p className="p-4 text-gray-400">Loading...</p>
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Link to="/" className="text-sm text-amber-700">&larr; Back to search</Link>

      <Disclaimer />

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {product.brand}
        </p>
        <h1 className="mt-1 text-xl font-bold text-gray-900">{product.name}</h1>
        <p className="mt-1 text-sm text-gray-400">
          {product.category} &middot; SKU: {product.sku}
        </p>
        <div className="mt-3">
          <StatusBadge
            containsCoconut={product.contains_coconut}
            statusAsOf={product.status_as_of}
          />
        </div>
      </div>

      {/* Ingredient sources */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-900">Ingredient Sources</h2>
        {product.sources.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">No ingredient data yet.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {product.sources.map((s) => (
              <div key={s.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-gray-500">
                    {s.source_type}
                  </span>
                  <span className={`text-xs font-semibold ${s.coconut_found ? 'text-red-600' : 'text-gray-400'}`}>
                    {s.coconut_found ? 'Coconut found' : 'No coconut detected'}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  {s.ingredients_raw || '(no ingredients text)'}
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Fetched {new Date(s.fetched_at).toLocaleDateString()} &middot; Confidence: {s.confidence}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status history */}
      {product.history.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="font-semibold text-gray-900">Status History</h2>
          <div className="mt-3 flex flex-col gap-2">
            {product.history.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-sm">
                <span className="text-gray-400">
                  {new Date(h.changed_at).toLocaleDateString()}
                </span>
                <span className="text-gray-600">{h.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Flag this product */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-900">Report an Issue</h2>
        {flagSubmitted ? (
          <p className="mt-2 text-sm text-green-700">
            Thanks! Your report has been recorded.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <textarea
              placeholder="Optional: describe what you found..."
              value={flagNotes}
              onChange={(e) => setFlagNotes(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
              rows={2}
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleFlag('found_coconut')}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                I found coconut in this product
              </button>
              <button
                onClick={() => handleFlag('wrong_ingredients')}
                className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
              >
                Ingredients are wrong
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
