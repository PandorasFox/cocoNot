import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getReclassified, type StatusChange } from '../api/client'
import { extractText } from '../api/parse'
import Disclaimer from '../components/Disclaimer'

export default function Reclassified() {
  const [changes, setChanges] = useState<StatusChange[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getReclassified(90)
      .then((res) => setChanges(res.changes ?? []))
      .catch(() => setChanges([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-4 p-4">
      <Disclaimer />

      <h1 className="text-lg font-bold text-gray-900">Recently Reclassified</h1>
      <p className="text-sm text-gray-500">
        Products whose coconut status changed in the last 90 days.
        If something you buy regularly shows up here, double-check the label.
      </p>

      {loading ? (
        <p className="py-8 text-center text-sm text-gray-400">Loading...</p>
      ) : changes.length === 0 ? (
        <p className="py-8 text-center text-gray-400">No recent changes.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {changes.map((c) => (
            <Link
              key={c.id}
              to={`/product/${c.product_id}`}
              className="block rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {extractText(c.product_brand)}
              </p>
              <p className="font-semibold text-gray-900">
                {extractText(c.product_name)}
              </p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-sm text-gray-500">
                  {new Date(c.changed_at).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-2">
                  <StatusLabel containsCoconut={c.old_contains_coconut} />
                  <span className="text-gray-300">&rarr;</span>
                  <StatusLabel containsCoconut={c.new_contains_coconut} />
                </div>
              </div>
              <p className="mt-1 text-sm text-gray-600">{c.reason}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusLabel({ containsCoconut }: { containsCoconut: boolean | null }) {
  if (containsCoconut === true)
    return <span className="text-xs font-semibold text-red-600">Coconut</span>
  return <span className="text-xs text-gray-400">{'¯\\_(ツ)_/¯'}</span>
}
