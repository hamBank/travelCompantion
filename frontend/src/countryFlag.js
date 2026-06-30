const FLAGS = {
  'singapore': '🇸🇬', 'france': '🇫🇷', 'italy': '🇮🇹', 'switzerland': '🇨🇭',
  'qatar': '🇶🇦', 'finland': '🇫🇮', 'germany': '🇩🇪', 'spain': '🇪🇸',
  'portugal': '🇵🇹', 'greece': '🇬🇷', 'netherlands': '🇳🇱', 'belgium': '🇧🇪',
  'austria': '🇦🇹', 'croatia': '🇭🇷', 'czech republic': '🇨🇿', 'hungary': '🇭🇺',
  'poland': '🇵🇱', 'sweden': '🇸🇪', 'norway': '🇳🇴', 'denmark': '🇩🇰',
  'ireland': '🇮🇪', 'united kingdom': '🇬🇧', 'uk': '🇬🇧',
  'united states': '🇺🇸', 'usa': '🇺🇸', 'canada': '🇨🇦',
  'australia': '🇦🇺', 'new zealand': '🇳🇿', 'japan': '🇯🇵', 'china': '🇨🇳',
  'south korea': '🇰🇷', 'thailand': '🇹🇭', 'vietnam': '🇻🇳', 'indonesia': '🇮🇩',
  'malaysia': '🇲🇾', 'india': '🇮🇳', 'turkey': '🇹🇷', 'israel': '🇮🇱',
  'united arab emirates': '🇦🇪', 'uae': '🇦🇪', 'dubai': '🇦🇪',
  'south africa': '🇿🇦', 'egypt': '🇪🇬', 'morocco': '🇲🇦',
  'mexico': '🇲🇽', 'brazil': '🇧🇷', 'argentina': '🇦🇷',
  'luxembourg': '🇱🇺', 'malta': '🇲🇹', 'slovakia': '🇸🇰', 'slovenia': '🇸🇮',
  'romania': '🇷🇴', 'bulgaria': '🇧🇬', 'serbia': '🇷🇸', 'albania': '🇦🇱',
  'north macedonia': '🇲🇰', 'montenegro': '🇲🇪', 'bosnia': '🇧🇦',
  'iceland': '🇮🇸', 'latvia': '🇱🇻', 'lithuania': '🇱🇹', 'estonia': '🇪🇪',
  'cyprus': '🇨🇾', 'cambodia': '🇰🇭', 'laos': '🇱🇦', 'myanmar': '🇲🇲',
  'philippines': '🇵🇭', 'taiwan': '🇹🇼', 'hong kong': '🇭🇰',
  'sri lanka': '🇱🇰', 'nepal': '🇳🇵', 'pakistan': '🇵🇰', 'bangladesh': '🇧🇩',
}

export function countryFlag(country) {
  if (!country) return ''
  return FLAGS[country.toLowerCase().trim()] ?? ''
}

/**
 * ISO-3166-1 alpha-2 code (lowercase) for a country, derived from its flag
 * emoji — the two regional-indicator symbols *are* the country code. Used to
 * render flag images, which (unlike emoji) display on Chrome/Edge on Windows.
 */
export function countryCode(country) {
  const emoji = countryFlag(country)
  const cps = [...emoji].map(c => c.codePointAt(0))
  if (cps.length !== 2) return ''
  return String.fromCharCode(cps[0] - 0x1f1e6 + 65, cps[1] - 0x1f1e6 + 65).toLowerCase()
}
