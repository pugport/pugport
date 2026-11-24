/** The language of the `pugport` help texts: chosen from the terminal's locale, translated through the UI catalog. */
import { createTranslator, defaultLocale, type Locale, type Translate } from '../shared/i18n/index.ts';
import english from '../shared/i18n/en.json' with { type: 'json' };
import traditional from '../shared/i18n/zh-Hant.json' with { type: 'json' };

type Env = Record<string, string | undefined>;

/**
 * LC_ALL, then LC_MESSAGES, then LANG (empty, C and POSIX do not count); without any of them, the system
 * locale. A Chinese tag gives Chinese, anything else English.
 */
export function cliLocale(env: Env, systemLocale = () => Intl.DateTimeFormat().resolvedOptions().locale): Locale {
  const named = [env.LC_ALL, env.LC_MESSAGES, env.LANG]
    // zh_CN.UTF-8@pinyin → zh_CN
    .map((value) => (value ?? '').trim().replace(/[.@].*$/, ''))
    .find((value) => value && !/^(c|posix)$/i.test(value));
  const tag = (named ?? systemLocale()).replaceAll('_', '-');
  return tag.toLowerCase().startsWith('zh') ? defaultLocale([tag]) : 'en';
}

const tables: Partial<Record<Locale, Record<string, string>>> = { en: english, 'zh-TW': traditional };
const translators = new Map<Locale, Translate>();

/** The catalog's text for a Simplified Chinese source string, keeping its leading spaces. */
export function translateFor(locale: Locale): (text: string) => string {
  const table = tables[locale];
  if (!table) return (text) => text;
  let translate = translators.get(locale);
  if (!translate) translators.set(locale, (translate = createTranslator(table)));
  return (text) => {
    const translated = translate(text);
    return translated === undefined ? text : `${text.match(/^\s*/)?.[0] ?? ''}${translated}`;
  };
}
