import type { Expense } from './types'

export function parseAmountToCents(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  const cents = Math.round(Number(normalized) * 100)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function monthTotal(expenses: Expense[], key: string): number {
  return expenses.filter(item => item.occurredAt.startsWith(key)).reduce((sum, item) => sum + item.amountInCents, 0)
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round((current - previous) / previous * 100)
}
