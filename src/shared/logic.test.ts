import { describe, expect, it } from 'vitest'
import { csvCell, parseCsv } from './csv'
import { monthTotal, parseAmountToCents, percentChange } from './logic'
import type { Expense } from './types'

const expense = (amountInCents: number, occurredAt: string): Expense => ({
  id: crypto.randomUUID(), amountInCents, occurredAt,
  primaryCategory: '餐饮', secondaryCategory: '午餐', note: '',
  paymentMethod: '微信支付', merchant: '', createdAt: occurredAt, updatedAt: occurredAt
})

describe('人民币金额换算', () => {
  it.each([['0.01',1],['12',1200],['12.3',1230],['9999.99',999999]])('将 %s 元换算为整数分', (input, expected) => expect(parseAmountToCents(input)).toBe(expected))
  it.each(['','0','-1','1.234','abc','.5','NaN'])('拒绝无效金额 %s', input => expect(parseAmountToCents(input)).toBeNull())
})

describe('月度统计', () => {
  const rows=[expense(1000,'2026-08-01T10:00:00.000Z'),expense(2550,'2026-08-20T10:00:00.000Z'),expense(800,'2026-07-31T10:00:00.000Z')]
  it('只汇总指定月份', () => expect(monthTotal(rows,'2026-08')).toBe(3550))
  it('计算较上月变化并处理上月为零', () => { expect(percentChange(150,100)).toBe(50); expect(percentChange(50,100)).toBe(-50); expect(percentChange(100,0)).toBeNull() })
})

describe('CSV 往返', () => {
  it('保留中文、逗号、引号和跨行文本', () => {
    const values=['午餐','面馆,二店','备注中有"引号"','第一行\n第二行']
    const parsed=parseCsv(values.map(csvCell).join(','))
    expect(parsed).toEqual([values])
  })
  it('解析 Windows 换行和多条记录', () => expect(parseCsv('"a","b"\r\n"1","2"\r\n')).toEqual([['a','b'],['1','2']]))
})
