import type { Expense } from './types'

/**
 * 把用户输入的人民币“元”转换为数据库使用的整数“分”。
 * 只接受大于 0 且最多两位小数的普通数字；无效或过大的金额返回 null。
 * 使用整数分可以避免小数计算误差影响账目总额。
 */
export function parseAmountToCents(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  const cents = Math.round(Number(normalized) * 100)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

/**
 * 生成当前电脑本地时间对应的 YYYY-MM 月份键。
 * 月份补齐两位，使字符串既便于展示，也能稳定排序和筛选。
 */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 汇总日期文本以指定月份键开头的账目，结果单位仍为“分”。
 * 此函数按已保存文本的前七位判断月份，不会在内部转换时区。
 */
export function monthTotal(expenses: Expense[], key: string): number {
  return expenses.filter(item => item.occurredAt.startsWith(key)).reduce((sum, item) => sum + item.amountInCents, 0)
}

/** 按月份和收支类型汇总，供首页与统计页分别计算收入、支出和结余。 */
export function monthTotalByType(entries: Expense[], key: string, entryType: Expense['entryType']): number {
  return entries.filter(item => item.entryType === entryType && item.occurredAt.startsWith(key)).reduce((sum, item) => sum + item.amountInCents, 0)
}

/**
 * 计算当前数值相对上一数值的整数百分比变化。
 * 上一期为 0 时没有有意义的除数，因此返回 null，让界面显示“暂无对比”。
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round((current - previous) / previous * 100)
}
