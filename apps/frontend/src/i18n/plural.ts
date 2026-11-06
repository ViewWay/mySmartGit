import type { Language } from './index'
import { localeFor } from './format'

export function pluralCategory(language: Language, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(localeFor(language)).select(count)
}
