import { I18n as UiI18n, type LanguagePreference } from '../../shared/i18n';
import { english } from './ui/translations';
export { chinese, templateLocalizer, type LanguagePreference, type Translator, type UiLanguage } from '../../shared/i18n';

/** Language stays local to this plugin; it never enters sync policy or encrypted profiles. */
export class I18n extends UiI18n {
 constructor(preference: LanguagePreference = 'auto', hostLanguage: () => string = () => 'en') { super(english, preference, hostLanguage); }
}
