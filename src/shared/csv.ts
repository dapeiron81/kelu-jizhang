export function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(value); value = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(value); if (row.some(cell => cell.length)) rows.push(row); row = []; value = ''
    } else value += char
  }
  row.push(value); if (row.some(cell => cell.length)) rows.push(row)
  return rows
}
