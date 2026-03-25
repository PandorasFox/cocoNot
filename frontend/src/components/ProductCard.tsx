import { Link } from 'react-router-dom'
import type { Product } from '../api/client'
import { extractText } from '../api/parse'
import StatusBadge from './StatusBadge'

interface ProductCardProps {
  product: Product
}

export default function ProductCard({ product }: ProductCardProps) {
  const borderColor =
    product.contains_coconut === true
      ? 'border-red-300'
      : 'border-gray-200'

  const name = extractText(product.name)
  const brand = extractText(product.brand)

  return (
    <Link
      to={`/product/${product.id}`}
      className={`block rounded-lg border-2 ${borderColor} bg-white p-4 transition-shadow hover:shadow-md`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {brand}
          </p>
          <p className="mt-0.5 truncate font-semibold text-gray-900">
            {name}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">{product.category}</p>
        </div>
        {product.image_url ? (
          <img
            src={extractText(product.image_url)}
            alt={name}
            className="h-16 w-16 flex-shrink-0 rounded object-cover"
          />
        ) : null}
      </div>
      <div className="mt-3">
        <StatusBadge containsCoconut={product.contains_coconut} />
      </div>
    </Link>
  )
}
