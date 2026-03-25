interface StatusBadgeProps {
  containsCoconut: boolean | null
}

export default function StatusBadge({ containsCoconut }: StatusBadgeProps) {
  if (containsCoconut === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-sm font-semibold text-red-800">
        CONTAINS COCONUT
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-600">
      {'¯\\_(ツ)_/¯'}
    </span>
  )
}
