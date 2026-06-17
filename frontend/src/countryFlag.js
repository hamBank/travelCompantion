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
