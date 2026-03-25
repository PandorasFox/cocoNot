export interface Product {
  id: string
  sku: string
  brand: string
  name: string
  category: string
  image_url?: string
  contains_coconut: boolean | null
  status_as_of?: string
  created_at: string
  updated_at: string
}

export interface IngredientSource {
  id: string
  product_id: string
  source_type: string
  source_url?: string
  ingredients_raw: string
  coconut_found: boolean
  fetched_at: string
  created_at: string
}

export interface UserFlag {
  id: string
  product_id: string
  flag_type: string
  notes: string
  photo_url?: string
  resolved: boolean
  created_at: string
}

export interface StatusChange {
  id: string
  product_id: string
  old_contains_coconut: boolean | null
  new_contains_coconut: boolean | null
  reason: string
  changed_at: string
}

export interface ProductDetail extends Product {
  sources: IngredientSource[]
  flags: UserFlag[]
  history: StatusChange[]
}

export interface ProductListResponse {
  products: Product[]
  total: number
  limit: number
  offset: number
}

const BASE = '/api'

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`)
  }
  return res.json()
}

export function listProducts(params: {
  q?: string
  coconut?: boolean
  limit?: number
  offset?: number
}) {
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.coconut !== undefined) sp.set('coconut', String(params.coconut))
  if (params.limit) sp.set('limit', String(params.limit))
  if (params.offset) sp.set('offset', String(params.offset))
  return fetchJSON<ProductListResponse>(`/products?${sp}`)
}

export function getProduct(id: string) {
  return fetchJSON<ProductDetail>(`/products/${id}`)
}

export function getProductByBarcode(sku: string) {
  return fetchJSON<Product>(`/products/barcode/${encodeURIComponent(sku)}`)
}

export function getReclassified(days = 30) {
  return fetchJSON<{ changes: StatusChange[] }>(`/products/reclassified?days=${days}`)
}

export function fuzzySearch(q: string, limit = 20) {
  return fetchJSON<{ products: Product[] }>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export function createFlag(productId: string, flagType: string, notes: string) {
  return fetchJSON<UserFlag>(`/products/${productId}/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag_type: flagType, notes }),
  })
}
