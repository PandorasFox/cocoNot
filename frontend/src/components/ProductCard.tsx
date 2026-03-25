import { Link } from 'react-router-dom'
import type { Product } from '../api/client'
import StatusBadge from './StatusBadge'

interface ProductCardProps {
  product: Product
}

export default function ProductCard({ product }: ProductCardProps) {
  const borderColor =
    product.contains_coconut === true
      ? 'border-red-300'
      : product.contains_coconut === false
        ? 'border-amber-200'
        : 'border-gray-200'

  return (
    <Link
      to={`/product/${product.id}`}
      className={`block rounded-lg border-2 ${borderColor} bg-white p-4 transition-shadow hover:shadow-md`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {product.brand}
          </p>
          <p className="mt-0.5 truncate font-semibold text-gray-900">
            {product.name}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">{product.category}</p>
        </div>
        {product.image_url && (
          <img
            src={product.image_url}
            alt=""
            className="h-12 w-12 flex-shrink-0 rounded object-cover"
          />
        )}
      </div>
      <div className="mt-3">
        <StatusBadge
          containsCoconut={product.contains_coconut}
          statusAsOf={product.status_as_of}
        />
      </div>
    </Link>
  )
}
