/**
 * 把任意值转换为一个 CSV 单元格。
 * 所有内容都放在双引号中，内容里的双引号写成两个，因而逗号和换行不会拆散一条记录。
 * null 和 undefined 会导出为空文本；本函数只负责 CSV 结构转义，不负责业务字段校验。
 */
export function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

/**
 * 把 CSV 文件文本解析成“多行、多列”的字符串数组。
 * 解析器理解带引号的逗号、双引号、跨行内容以及 Windows 的 CRLF 换行。
 * 它不判断列名、金额、分类或日期是否合法，这些产品规则由导入预览流程检查。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    // 两个连续双引号代表单元格内容中的一个真正双引号，第二个字符需要一起跳过。
    if (char === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1 }
    else if (char === '"') quoted = !quoted
    // 只有不在引号中的逗号和换行才是分隔符；引号里的同类字符属于用户原文。
    else if (char === ',' && !quoted) { row.push(value); value = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      // Windows 用两个字符表示一次换行，这里把它当成一个行尾，避免产生空记录。
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(value); if (row.some(cell => cell.length)) rows.push(row); row = []; value = ''
    } else value += char
  }
  row.push(value); if (row.some(cell => cell.length)) rows.push(row)
  return rows
}
