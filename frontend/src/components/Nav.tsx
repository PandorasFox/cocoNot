import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { skuDump } from '../api/client'
import { putDump } from '../api/cache'

export default function Nav() {
  const [cacheState, setCacheState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [cacheCount, setCacheCount] = useState(0)

  const handleCacheSKUs = async () => {
    setCacheState('loading')
    try {
      const res = await skuDump()
      await putDump(res.products)
      setCacheCount(res.products.length)
      setCacheState('done')
      setTimeout(() => setCacheState('idle'), 3000)
    } catch {
      setCacheState('idle')
    }
  }

  return (
    <nav className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
      <NavLink to="/" className="text-lg font-bold text-gray-900">
        CocoNot
      </NavLink>
      <div className="flex items-center gap-4">
        <NavLink
          to="/"
          className={({ isActive }) =>
            `text-sm font-medium ${isActive ? 'text-amber-700' : 'text-gray-500 hover:text-gray-900'}`
          }
        >
          Search
        </NavLink>
        <button
          onClick={handleCacheSKUs}
          disabled={cacheState === 'loading'}
          className="text-sm font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
        >
          {cacheState === 'loading' && (
            <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent align-middle" />
          )}
          {cacheState === 'done'
            ? `Cached ${cacheCount.toLocaleString()} products`
            : 'Cache SKUs'}
        </button>
      </div>
    </nav>
  )
}
