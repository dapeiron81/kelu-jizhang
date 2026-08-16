import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempFolders: string[] = []

function testDatabase(): { database: DatabaseSync; folder: string; path: string } {
  const folder = mkdtempSync(join(tmpdir(), 'kelu-ledger-test-'))
  const path = join(folder, 'ledger.db')
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE categories (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id), name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0, UNIQUE(parent_id, name)
    );
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY, amount_in_cents INTEGER NOT NULL CHECK(amount_in_cents > 0),
      primary_category TEXT NOT NULL, secondary_category TEXT NOT NULL,
      primary_category_id TEXT REFERENCES categories(id), secondary_category_id TEXT REFERENCES categories(id),
      occurred_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO categories VALUES ('food',NULL,'餐饮',1,1,0);
    INSERT INTO categories VALUES ('lunch','food','午餐',1,1,0);
  `)
  tempFolders.push(folder)
  return { database, folder, path }
}

function addExpense(database: DatabaseSync, id = 'expense-1'): void {
  database.prepare(`INSERT INTO expenses VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 2350, '餐饮', '午餐', 'food', 'lunch', '2026-08-15T04:00:00.000Z',
    '工作餐', '微信支付', '小面馆', '2026-08-15T04:00:00.000Z', '2026-08-15T04:00:00.000Z'
  )
}

afterEach(() => {
  while (tempFolders.length) rmSync(tempFolders.pop()!, { recursive: true, force: true })
})

describe('SQLite 金额和关联约束', () => {
  it('保存整数分并拒绝零金额', () => {
    const { database } = testDatabase(); addExpense(database)
    expect((database.prepare('SELECT amount_in_cents AS amount FROM expenses').get() as { amount: number }).amount).toBe(2350)
    expect(() => database.prepare(`INSERT INTO expenses VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bad',0,'餐饮','午餐','food','lunch','2026-08-15','','','','x','x')).toThrow()
    database.close()
  })

  it('分类改名时稳定编号不变且历史名称同步', () => {
    const { database } = testDatabase(); addExpense(database)
    database.exec('BEGIN IMMEDIATE')
    database.prepare('UPDATE categories SET name=? WHERE id=?').run('工作午餐','lunch')
    database.prepare('UPDATE expenses SET secondary_category=? WHERE secondary_category_id=?').run('工作午餐','lunch')
    database.exec('COMMIT')
    const row=database.prepare('SELECT secondary_category AS name,secondary_category_id AS id FROM expenses').get() as {name:string;id:string}
    expect(row).toEqual({name:'工作午餐',id:'lunch'}); database.close()
  })
})

describe('数据事务和备份', () => {
  it('批量导入遇到错误时整体回滚', () => {
    const { database } = testDatabase()
    database.exec('BEGIN IMMEDIATE')
    try { addExpense(database,'same-id'); addExpense(database,'same-id'); database.exec('COMMIT') }
    catch { database.exec('ROLLBACK') }
    expect((database.prepare('SELECT count(*) AS count FROM expenses').get() as {count:number}).count).toBe(0)
    database.close()
  })

  it('完整备份包含账目、分类和设置', () => {
    const { database, folder } = testDatabase(); addExpense(database)
    database.prepare('INSERT INTO settings VALUES (?,?)').run('theme','dark')
    const backupPath=join(folder,'backup.db').replaceAll("'","''")
    database.exec(`VACUUM INTO '${backupPath}'`); database.close()
    const backup=new DatabaseSync(join(folder,'backup.db'),{readOnly:true})
    expect((backup.prepare('SELECT count(*) AS count FROM expenses').get() as {count:number}).count).toBe(1)
    expect((backup.prepare('SELECT count(*) AS count FROM categories').get() as {count:number}).count).toBe(2)
    expect((backup.prepare('SELECT value FROM settings WHERE key=?').get('theme') as {value:string}).value).toBe('dark')
    backup.close()
  })
})
