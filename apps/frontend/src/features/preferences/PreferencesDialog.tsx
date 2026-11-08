import { useEffect } from 'react'
import { Settings2, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { CompactSelect } from '../../components/CompactSelect'
import { useI18n, type Language } from '../../i18n'
import { setPreference, usePreferences } from '../../preferences'
import { UpdatePanel } from '../settings/UpdatePanel'

export type PreferencesPage = 'general' | 'updates'

const FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24]

function GeneralPreferences() {
  const { t, language, setLanguage } = useI18n()
  const preferences = usePreferences()
  return <div className="preferences-general">
    <div className="preferences-field">
      <div><strong>{t('preferences.language')}</strong><small>{t('preferences.languageHint')}</small></div>
      <CompactSelect value={language} options={[{ value: 'zh', label: t('menu.view.language.zh') }, { value: 'en', label: t('menu.view.language.en') }]} onChange={(value) => setLanguage(value as Language)} ariaLabel={t('preferences.language')}/>
    </div>
    <div className="preferences-field">
      <div><strong>{t('preferences.theme')}</strong><small>{t('preferences.themeHint')}</small></div>
      <CompactSelect value={preferences.theme} options={[{ value: 'light', label: t('preferences.theme.light') }, { value: 'dark', label: t('preferences.theme.dark') }, { value: 'system', label: t('preferences.theme.system') }]} onChange={(value) => setPreference('theme', value)} ariaLabel={t('preferences.theme')}/>
    </div>
    <div className="preferences-field">
      <div><strong>{t('preferences.diffLayout')}</strong><small>{t('preferences.diffLayoutHint')}</small></div>
      <CompactSelect value={preferences.diffLayout} options={[{ value: 'unified', label: t('menu.format.diff-unified') }, { value: 'split', label: t('menu.format.diff-split') }]} onChange={(value) => setPreference('diffLayout', value === 'split' ? 'split' : 'unified')} ariaLabel={t('preferences.diffLayout')}/>
    </div>
    <label className="preferences-toggle">
      <span><strong>{t('preferences.wordWrap')}</strong><small>{t('preferences.wordWrapHint')}</small></span>
      <input type="checkbox" checked={preferences.wordWrap} onChange={(event) => setPreference('wordWrap', event.target.checked)}/>
      <span className="toggle-track" aria-hidden="true"><span/></span>
    </label>
    <label className="preferences-toggle">
      <span><strong>{t('preferences.showTreeTab')}</strong><small>{t('preferences.showTreeTabHint')}</small></span>
      <input type="checkbox" checked={preferences.showTreeTab} onChange={(event) => setPreference('showTreeTab', event.target.checked)}/>
      <span className="toggle-track" aria-hidden="true"><span/></span>
    </label>
    <label className="preferences-toggle">
      <span><strong>{t('preferences.showWhitespace')}</strong><small>{t('preferences.showWhitespaceHint')}</small></span>
      <input type="checkbox" checked={preferences.showWhitespace} onChange={(event) => setPreference('showWhitespace', event.target.checked)}/>
      <span className="toggle-track" aria-hidden="true"><span/></span>
    </label>
    <div className="preferences-field">
      <div><strong>{t('preferences.diffFontSize')}</strong><small>{t('preferences.diffFontSizeHint')}</small></div>
      <CompactSelect value={preferences.diffFontSize} options={FONT_SIZES.map((size) => ({ value: size, label: `${size} px` }))} onChange={(value) => setPreference('diffFontSize', value)} ariaLabel={t('preferences.diffFontSize')}/>
    </div>
  </div>
}

export function PreferencesDialog({ open, page, onClose, onPageChange }: {
  open: boolean
  page: PreferencesPage
  onClose: () => void
  onPageChange: (page: PreferencesPage) => void
}) {
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null
  return <div className="modal-backdrop" onPointerDown={onClose}>
    <section className="preferences-dialog" role="dialog" aria-modal="true" aria-label={t('preferences.title')} onPointerDown={(event) => event.stopPropagation()}>
      <aside className="preferences-nav">
        <div className="preferences-title"><Settings2 size={16}/><strong>{t('preferences.title')}</strong></div>
        <button type="button" className={page === 'general' ? 'active' : ''} aria-current={page === 'general' ? 'page' : undefined} onClick={() => onPageChange('general')}>{t('preferences.general')}</button>
        <button type="button" className={page === 'updates' ? 'active' : ''} aria-current={page === 'updates' ? 'page' : undefined} onClick={() => onPageChange('updates')}>{t('preferences.updates')}</button>
      </aside>
      <div className="preferences-content">
        <header className="preferences-heading">
          <h2>{page === 'general' ? t('preferences.general') : t('preferences.updates')}</h2>
          <Button variant="icon" onClick={onClose} title={t('common.close')}><X size={16}/></Button>
        </header>
        <div className="preferences-body">{page === 'general' ? <GeneralPreferences/> : <UpdatePanel/>}</div>
      </div>
    </section>
  </div>
}
