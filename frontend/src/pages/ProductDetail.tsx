import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getProduct, type ProductDetail as ProductDetailType } from '../api/client'
import { extractText } from '../api/parse'
import StatusBadge from '../components/StatusBadge'
import Disclaimer from '../components/Disclaimer'

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>()
  const [product, setProduct] = useState<ProductDetailType | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    getProduct(id)
      .then(setProduct)
      .catch(() => setError('Product not found'))
  }, [id])

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

  const name = extractText(product.name)
  const brand = extractText(product.brand)
  const offUrl = `https://world.openfoodfacts.org/product/${product.sku}`

  return (
    <div className="flex flex-col gap-4 p-4">
      <Link to="/" className="text-sm text-amber-700">&larr; Back to search</Link>

      <Disclaimer />

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-start gap-4">
          {product.image_url ? (
            <img
              src={product.image_url}
              alt={name}
              className="h-24 w-24 flex-shrink-0 rounded object-cover"
            />
          ) : null}
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {brand}
            </p>
            <h1 className="mt-1 text-xl font-bold text-gray-900">{name}</h1>
            <p className="mt-1 text-sm text-gray-400">
              {product.category} &middot; SKU: {product.sku}
            </p>
          </div>
        </div>
        <div className="mt-3">
          <StatusBadge containsCoconut={product.contains_coconut} />
        </div>
      </div>

      {/* Ingredient sources */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-900">Ingredients</h2>
        {product.sources.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">No ingredient data yet.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {product.sources.map((s) => (
              <div key={s.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-gray-500">
                    {s.source_type === 'openfoodfacts' ? (
                      <a
                        href={s.source_url || offUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-amber-700"
                      >
                        Open Food Facts
                      </a>
                    ) : (
                      s.source_type
                    )}
                  </span>
                  <span className={`text-xs font-semibold ${s.coconut_found ? 'text-red-600' : 'text-gray-400'}`}>
                    {s.coconut_found ? 'Coconut found' : 'No coconut detected'}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  {extractText(s.ingredients_raw) || '(no ingredients text)'}
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Fetched {new Date(s.fetched_at).toLocaleDateString()}
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

      {/* OFF link */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
        <a
          href={offUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-amber-700 underline hover:text-amber-900"
        >
          View on Open Food Facts
        </a>
        <p className="mt-1 text-xs text-gray-400">
          Contribute to Open Food Facts to correct any ingredient issues you find!
        </p>
      </div>
    </div>
  )
}
