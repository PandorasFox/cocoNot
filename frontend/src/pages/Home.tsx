import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { listProducts, getProductByBarcode, type Product } from '../api/client'
import ProductCard from '../components/ProductCard'
import Disclaimer from '../components/Disclaimer'

type Filter = 'all' | 'shrug' | 'contains_coconut'

function looksLikeSKU(q: string): boolean {
  return /^\d{8,14}$/.test(q.trim())
}

export default function Home() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const search = useCallback(async () => {
    const q = query.trim()
    setLoading(true)
    try {
      // If it looks like a SKU, try direct lookup first
      if (looksLikeSKU(q)) {
        try {
          const product = await getProductByBarcode(q)
          navigate(`/product/${product.id}`)
          return
        } catch {
          // Not found by SKU — fall through to text search
        }
      }

      const coconut =
        filter === 'contains_coconut' ? true
        : filter === 'shrug' ? false
        : undefined
      const res = await listProducts({ q: q || undefined, coconut })
      setProducts(res.products ?? [])
      setTotal(res.total)
    } catch {
      setProducts([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [query, filter, navigate])

  useEffect(() => {
    const timer = setTimeout(search, 300)
    return () => clearTimeout(timer)
  }, [search])

  return (
    <div className="flex flex-col gap-4 p-4">
      <Disclaimer />

      <input
        type="search"
        placeholder="Search by brand, product name, or SKU..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
      />

      <div className="flex gap-2">
        {([
          ['all', 'All'],
          ['shrug', '¯\\_(ツ)_/¯'],
          ['contains_coconut', 'Contains Coconut'],
        ] as [Filter, string][]).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              filter === value
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-gray-400">Searching...</p>
      ) : products.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-gray-500">
            {total === 0 && query === ''
              ? 'No products yet. Data will appear once ingestion runs.'
              : 'No products found.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-400">{total} products</p>
          <div className="flex flex-col gap-3">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
