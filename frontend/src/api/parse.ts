/**
 * OFF data sometimes comes through as raw Python-ish struct repr:
 *   {'lang': main, 'text': Premium Ice Cream}, {'lang': en, 'text': ...}
 *
 * This extracts the plain text from 'lang: main' or 'lang: en',
 * falling back to the first 'text' value found, or returns the
 * original string if it doesn't match the pattern.
 */
export function extractText(raw: string): string {
  if (!raw) return ''

  // Quick check: does it look like a struct blob?
  if (!raw.includes("'lang'") && !raw.includes("'text'")) {
    return raw
  }

  // Extract all {lang, text} pairs
  const entries: { lang: string; text: string }[] = []
  // Match patterns like {'lang': main, 'text': Some Text Here}
  // or {'lang': en, 'text': <span...>stuff</span>, more text}
  const regex = /\{\s*'lang'\s*:\s*(\w+)\s*,\s*'text'\s*:\s*(.*?)\s*\}(?=\s*,\s*\{|$)/gs
  let match
  while ((match = regex.exec(raw)) !== null) {
    entries.push({ lang: match[1], text: match[2] })
  }

  if (entries.length === 0) return raw

  // Prefer main, then en, then first
  const main = entries.find((e) => e.lang === 'main')
  if (main) return stripHtml(main.text)

  const en = entries.find((e) => e.lang === 'en')
  if (en) return stripHtml(en.text)

  return stripHtml(entries[0].text)
}

/** Strip HTML tags (OFF sometimes wraps allergens in <span> tags) */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim()
}
