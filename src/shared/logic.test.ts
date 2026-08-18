import { describe, expect, it } from 'vitest'
import { csvCell, parseCsv } from './csv'
import { monthTotal, monthTotalByType, parseAmountToCents, percentChange } from './logic'
import type { Expense } from './types'

/**
 * 创建统计测试使用的最小花销对象。
 * 金额单位为分，日期由测试用例明确给出；其他字段使用固定占位值。
 */
const expense = (amountInCents: number, occurredAt: string): Expense => ({
  id: crypto.randomUUID(), entryType: 'expense', amountInCents, occurredAt,
  primaryCategory: '餐饮', secondaryCategory: '午餐', note: '',
  paymentMethod: '微信支付', merchant: '', createdAt: occurredAt, updatedAt: occurredAt
})

// 金额换算同时覆盖合法格式和必须拒绝的边界，防止三位小数被悄悄四舍五入。
describe('人民币金额换算', () => {
  // 合法整数、一位小数和两位小数都应精确转换成整数分。
  it.each([['0.01',1],['12',1200],['12.3',1230],['9999.99',999999]])('将 %s 元换算为整数分', (input, expected) => expect(parseAmountToCents(input)).toBe(expected))
  // 空值、零、负数、三位小数和非数字都不能进入账本。
  it.each(['','0','-1','1.234','abc','.5','NaN'])('拒绝无效金额 %s', input => expect(parseAmountToCents(input)).toBeNull())
})

// 月度统计保持整数分相加，并验证上月为零时不生成无意义百分比。
describe('月度统计', () => {
  const rows=[expense(1000,'2026-08-01T10:00:00.000Z'),expense(2550,'2026-08-20T10:00:00.000Z'),expense(800,'2026-07-31T10:00:00.000Z')]
  it('只汇总指定月份', () => expect(monthTotal(rows,'2026-08')).toBe(3550))
  it('计算较上月变化并处理上月为零', () => { expect(percentChange(150,100)).toBe(50); expect(percentChange(50,100)).toBe(-50); expect(percentChange(100,0)).toBeNull() })
  it('分别汇总收入和支出', () => {
    const entries=[expense(1000,'2026-08-01T10:00:00.000Z'),{...expense(3000,'2026-08-02T10:00:00.000Z'),entryType:'income' as const}]
    expect(monthTotalByType(entries,'2026-08','expense')).toBe(1000)
    expect(monthTotalByType(entries,'2026-08','income')).toBe(3000)
  })
})

// CSV 往返测试确保用户原文中的中文和分隔符不会改变列数或内容。
describe('CSV 往返', () => {
  // 逗号、引号和换行最容易破坏 CSV 结构，导出再解析后必须逐字一致。
  it('保留中文、逗号、引号和跨行文本', () => {
    const values=['午餐','面馆,二店','备注中有"引号"','第一行\n第二行']
    const parsed=parseCsv(values.map(csvCell).join(','))
    expect(parsed).toEqual([values])
  })
  // Windows 的 CRLF 换行必须只产生两条记录，不能额外制造空行。
  it('解析 Windows 换行和多条记录', () => expect(parseCsv('"a","b"\r\n"1","2"\r\n')).toEqual([['a','b'],['1','2']]))
})
