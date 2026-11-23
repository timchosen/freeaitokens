// makeTranslator(strings, lang) → t(key, vars): the string with {vars} filled in.
// A number in vars.n picks the plural form (key_one, key_few, …, falling back to key_other).
// A plain script, so the windows load it with <script> and the main process imports it.
globalThis.makeTranslator = function makeTranslator(strings, lang) {
  const rules = new Intl.PluralRules(lang);
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString(lang) : v);
  return (key, vars = {}) => {
    let k = key;
    if (typeof vars.n === 'number' && strings[`${key}_other`] != null) {
      const form = `${key}_${rules.select(vars.n)}`;
      k = strings[form] != null ? form : `${key}_other`;
    }
    return String(strings[k] ?? key).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? fmt(vars[x]) : m));
  };
};
