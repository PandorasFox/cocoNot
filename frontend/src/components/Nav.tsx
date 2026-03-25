import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Search' },
  { to: '/reclassified', label: 'Watch List' },
]

export default function Nav() {
  return (
    <nav className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
      <span className="text-lg font-bold text-gray-900">
        CoconutFree
      </span>
      <div className="flex gap-4">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `text-sm font-medium ${isActive ? 'text-amber-700' : 'text-gray-500 hover:text-gray-900'}`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
