/**
 * Timezone validation for the ML contract (v1.1: `trialData.sites[].timezone`).
 *
 * The Python service accepts only CANONICAL, case-sensitive IANA region names ('Asia/Kolkata', 'UTC'). Node's `Intl` is far more
 * lenient: it also accepts offsets ('+05:30'), abbreviations ('IST'), lower-case names and legacy aliases, so `Intl` alone is not
 * a safe validator. This function applies Python's rule as closely as it can be checked without a tz database:
 *   - 'UTC', or a name containing '/' (no offsets, no abbreviations, no legacy region-less names such as 'EST5EDT'),
 *   - tz-database casing (every path segment starts with a capital letter),
 *   - known to the runtime's ICU data,
 *   - not one of the legacy country-prefix aliases (US/, Canada/, ...), which Python's `available_timezones()` omits.
 * Residual risk: an old alias that ICU knows but Python does not (e.g. 'Asia/Calcutta'). Python then answers HTTP 422 and the
 * backend falls back to its baseline engine with a diagnosable reason; it never guesses.
 */
const LEGACY_PREFIXES = ['US/', 'Canada/', 'Mexico/', 'Brazil/', 'Chile/'];
const SHAPE = /^(?:UTC|[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*)+)$/;

export function isCanonicalIanaTimezone(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
  if (!SHAPE.test(name)) return false;
  if (LEGACY_PREFIXES.some((p) => name.startsWith(p))) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
