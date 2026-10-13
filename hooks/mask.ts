// Masks personal details for display while a screen is being recorded:
// set CLAUDE_MODS_RECORDING=1 (and optionally CLAUDE_MODS_RECORDING_TERMS, a
// JSON array of extra words to hide) in the session's environment.

type Rule = [RegExp, string | ((match: string, ...groups: string[]) => string)]

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const RULES: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][A-Za-z0-9_-]{12,}/g, '[secret]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[secret]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[secret]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[secret]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[secret]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[secret]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, (_m, lead) => `${lead}[secret]`],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, (_m, lead) => `${lead}[secret]`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/\b\d(?:[ -]?\d){12,18}\b/g, m => {
    const digits = m.replace(/\D/g, '')
    return /^[3-6]/.test(digits) && luhn(digits) ? '[card]' : m
  }],
  [/(?:US\$|HK\$|NT\$|A\$|C\$|S\$|\$|€|£|¥|₩|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmM]|bn)\b)?/g, '[amount]'],
  [/\b\d[\d,]*(?:\.\d+)?\s?(?:USD|HKD|EUR|GBP|JPY|CNY|RMB|AUD|CAD|SGD|TWD)\b/g, '[amount]'],
  [/\+\d{1,3}[\s.-]?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}\b/g, '[phone]'],
  [/\(\d{3}\)\s?\d{3}[-.\s]\d{4}\b/g, '[phone]'],
  [/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '[ip]'],
  [/\/Users\/[^/\s'"]+/g, '/Users/[user]'],
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mask(text: string, extra: readonly string[] = []): string {
  let out = text
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === 'string'
      ? out.replace(pattern, replacement)
      : out.replace(pattern, replacement as (m: string, ...g: string[]) => string)
  }
  for (const term of extra) {
    if (term.trim() !== '') out = out.replace(new RegExp(escape(term.trim()), 'gi'), '[hidden]')
  }
  return out
}

export function maskDeep(value: unknown, extra: readonly string[] = []): unknown {
  if (typeof value === 'string') return mask(value, extra)
  if (Array.isArray(value)) return value.map(v => maskDeep(v, extra))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v, extra)]))
  }
  return value
}

// The extra words `/recording hide` adds, as recording-mode publishes them in
// CLAUDE_MODS_RECORDING_TERMS (a JSON array), so every mod hides them too.
export function recordingTerms(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}
