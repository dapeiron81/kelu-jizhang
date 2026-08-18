import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempFolders: string[] = []

/**
 * 为每个测试创建独立的临时 SQLite 数据库。
 * 表结构模拟产品的分类、花销和设置约束，并显式开启外键检查。
 * afterEach 会统一删除临时文件，不会接触用户真实账本。
 */
function testDatabase(): { database: DatabaseSync; folder: string; path: string } {
  const folder = mkdtempSync(join(tmpdir(), 'kelu-ledger-test-'))
  const path = join(folder, 'ledger.db')
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE categories (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id), name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income')),
      UNIQUE(parent_id, name)
    );
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY, amount_in_cents INTEGER NOT NULL CHECK(amount_in_cents > 0),
      primary_category TEXT NOT NULL, secondary_category TEXT NOT NULL,
      primary_category_id TEXT REFERENCES categories(id), secondary_category_id TEXT REFERENCES categories(id),
      occurred_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO categories VALUES ('food',NULL,'餐饮',1,1,0,'expense');
    INSERT INTO categories VALUES ('lunch','food','午餐',1,1,0,'expense');
    INSERT INTO categories VALUES ('salary',NULL,'工资收入',1,1,0,'income');
    INSERT INTO categories VALUES ('base-salary','salary','基本工资',1,1,0,'income');
  `)
  tempFolders.push(folder)
  return { database, folder, path }
}

/**
 * 向指定测试库写入一笔固定的 23.50 元午餐。
 * 可替换编号用于制造重复主键场景，其他字段保持一致以便断言。
 */
function addExpense(database: DatabaseSync, id = 'expense-1'): void {
  database.prepare(`INSERT INTO expenses (id,amount_in_cents,primary_category,secondary_category,primary_category_id,secondary_category_id,occurred_at,note,payment_method,merchant,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 2350, '餐饮', '午餐', 'food', 'lunch', '2026-08-15T04:00:00.000Z',
    '工作餐', '微信支付', '小面馆', '2026-08-15T04:00:00.000Z', '2026-08-15T04:00:00.000Z'
  )
}

// 无论测试成功还是抛错，都移除本轮创建的临时目录，防止测试数据积累在系统盘。
afterEach(() => {
  while (tempFolders.length) rmSync(tempFolders.pop()!, { recursive: true, force: true })
})

// 验证数据库层最后一道保护：金额必须为正整数分，分类关联使用稳定编号。
describe('SQLite 金额和关联约束', () => {
  // 先确认正常金额原样保存，再尝试写入 0 分并期待数据库约束拒绝。
  it('保存整数分并拒绝零金额', () => {
    const { database } = testDatabase(); addExpense(database)
    expect((database.prepare('SELECT amount_in_cents AS amount FROM expenses').get() as { amount: number }).amount).toBe(2350)
    expect(() => database.prepare(`INSERT INTO expenses (id,amount_in_cents,primary_category,secondary_category,primary_category_id,secondary_category_id,occurred_at,note,payment_method,merchant,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bad',0,'餐饮','午餐','food','lunch','2026-08-15','','','','x','x')).toThrow()
    database.close()
  })

  // 分类改名需要同步展示名称，但不能改变历史账目保存的分类编号。
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

// 收支升级必须保护旧数据，同时允许收入使用自己独立的分类和正整数金额。
describe('收入记录和旧数据升级', () => {
  it('旧版账目增加字段后自动保持为支出', () => {
    const folder=mkdtempSync(join(tmpdir(),'kelu-ledger-legacy-')),path=join(folder,'legacy.db'),database=new DatabaseSync(path)
    tempFolders.push(folder)
    database.exec(`CREATE TABLE expenses (id TEXT PRIMARY KEY, amount_in_cents INTEGER NOT NULL); INSERT INTO expenses VALUES ('old-expense',1200); ALTER TABLE expenses ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income'));`)
    expect(database.prepare('SELECT entry_type AS entryType FROM expenses').get()).toEqual({entryType:'expense'})
    database.close()
  })

  it('收入保存类型和独立分类，并拒绝未知类型', () => {
    const {database}=testDatabase()
    database.prepare(`INSERT INTO expenses (id,amount_in_cents,primary_category,secondary_category,primary_category_id,secondary_category_id,occurred_at,note,payment_method,merchant,created_at,updated_at,entry_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('income-1',880000,'工资收入','基本工资','salary','base-salary','2026-08-15T04:00:00.000Z','','银行卡','某某公司','x','x','income')
    expect(database.prepare('SELECT amount_in_cents AS amount,entry_type AS entryType FROM expenses WHERE id=?').get('income-1')).toEqual({amount:880000,entryType:'income'})
    expect(()=>database.prepare(`INSERT INTO expenses (id,amount_in_cents,primary_category,secondary_category,occurred_at,created_at,updated_at,entry_type) VALUES ('bad-type',1,'其他','未分类','2026-08-15','x','x','transfer')`).run()).toThrow()
    database.close()
  })
})

// 事务测试关注“全部成功才生效”，备份测试关注三类核心数据是否都进入快照。
describe('数据事务和备份', () => {
  // 第二笔重复编号会失败；回滚后第一笔也必须消失，证明没有留下半批导入。
  it('批量导入遇到错误时整体回滚', () => {
    const { database } = testDatabase()
    database.exec('BEGIN IMMEDIATE')
    try { addExpense(database,'same-id'); addExpense(database,'same-id'); database.exec('COMMIT') }
    catch { database.exec('ROLLBACK') }
    expect((database.prepare('SELECT count(*) AS count FROM expenses').get() as {count:number}).count).toBe(0)
    database.close()
  })

  // 用只读连接重新打开备份，分别核对账目、分类和设置，而不是只看文件是否存在。
  it('完整备份包含账目、分类和设置', () => {
    const { database, folder } = testDatabase(); addExpense(database)
    database.prepare('INSERT INTO settings VALUES (?,?)').run('theme','dark')
    const backupPath=join(folder,'backup.db').replaceAll("'","''")
    database.exec(`VACUUM INTO '${backupPath}'`); database.close()
    const backup=new DatabaseSync(join(folder,'backup.db'),{readOnly:true})
    expect((backup.prepare('SELECT count(*) AS count FROM expenses').get() as {count:number}).count).toBe(1)
    expect((backup.prepare('SELECT count(*) AS count FROM categories').get() as {count:number}).count).toBe(4)
    expect((backup.prepare('SELECT value FROM settings WHERE key=?').get('theme') as {value:string}).value).toBe('dark')
    backup.close()
  })
})
