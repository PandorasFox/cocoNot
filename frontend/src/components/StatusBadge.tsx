interface StatusBadgeProps {
  containsCoconut: boolean | null
  statusAsOf?: string
}

export default function StatusBadge({ containsCoconut, statusAsOf }: StatusBadgeProps) {
  if (containsCoconut === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-sm font-semibold text-red-800">
        CONTAINS COCONUT
      </span>
    )
  }

  if (containsCoconut === false) {
    const date = statusAsOf
      ? new Date(statusAsOf).toLocaleDateString()
      : 'unknown date'
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800">
        Possibly clean as of {date}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-600">
      No data — check label
    </span>
  )
}
