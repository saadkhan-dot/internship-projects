/**
 * RFC-4180 compliant CSV generator with spreadsheet formula injection protection (CWE-1236).
 *
 * Ensures:
 * 1. Fields starting with dangerous formula characters (=, +, -, @, Tab, CR)
 *    are neutralized by prepending a single quote (') so spreadsheet applications
 *    (Excel, Calc, Sheets) treat them as literal text instead of executable formulas.
 * 2. Neutralization occurs prior to RFC-4180 escaping.
 * 3. Fields containing commas, double quotes, or newlines are enclosed in double quotes.
 * 4. Embedded double quotes are escaped by doubling them ("").
 * 5. Records are separated by CRLF (\r\n).
 *
 * @param {Array<{ key: string, label: string, getter?: (item: any) => any }>} columns
 * @param {Array<Object>} records
 * @returns {string}
 */
const DANGEROUS_FORMULA_PREFIX_REGEX = /^[\s\uFEFF]*[=+\-@\t\r]/

export function generateCsv(columns, records) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return ''
    let str = String(val)
    if (str.length === 0) return ''

    // Neutralize dangerous leading formula triggers (CWE-1236 / DEF-001)
    if (DANGEROUS_FORMULA_PREFIX_REGEX.test(str)) {
      str = `'${str}`
    }

    // RFC-4180 compliant quoting and escaping
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const header = columns.map(c => escapeCell(c.label || c.key)).join(',')
  const rows = (records || []).map(record => {
    return columns.map(c => {
      const val = typeof c.getter === 'function' ? c.getter(record) : record[c.key]
      return escapeCell(val)
    }).join(',')
  })

  return [header, ...rows].join('\r\n')
}

