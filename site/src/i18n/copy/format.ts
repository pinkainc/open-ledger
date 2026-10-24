// Number and date formatting per language: HR uses a decimal comma, `24. listopada 2026.`
import type { Lang } from '../ui';

const hrMonths = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja', 'srpnja',
  'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca'];
const enMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export function date(lang: Lang, iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return lang === 'hr' ? `${d}. ${hrMonths[m - 1]} ${y}.` : `${d} ${enMonths[m - 1]} ${y}`;
}

export function num(lang: Lang, n: number): string {
  const s = String(n);
  return lang === 'hr' ? s.replace('.', ',') : s;
}

/** Ranges such as 221–245. */
export const range = ([a, b]: number[]) => `${a}–${b}`;

/** Croatian noun form after a number: 1, 21 → one; 2–4, 22–24 → few; otherwise many. */
export function pl(n: number, one: string, few: string, many: string): string {
  const t = n % 10, h = n % 100;
  if (t === 1 && h !== 11) return one;
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return few;
  return many;
}
