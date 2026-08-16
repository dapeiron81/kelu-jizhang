import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AppSettings, CategoryGroup, CategoryItem, ImportPreview, NewExpense, OperationResult } from '../shared/types'
import { csvCell, parseCsv } from '../shared/csv'

let database: DatabaseSync
let databasePath = ''
let configurationDirectory = ''
let startupWarning = ''
type CsvExpense = [string, number, string, string, string, string, string, string]
let pendingImport: CsvExpense[] = []

app.setName('可噜记账')

function prepareDataDirectory(): void {
  const newDirectory = join(app.getPath('appData'), '可噜记账')
  const newDatabase = join(newDirectory, 'kelu-ledger.db')
  const oldDatabase = join(app.getPath('appData'), 'heima-ledger', 'heima-ledger.db')
  mkdirSync(newDirectory, { recursive: true })
  if (!existsSync(newDatabase) && existsSync(oldDatabase)) {
    const legacyDatabase = new DatabaseSync(oldDatabase, { readOnly: true })
    const escapedDestination = newDatabase.replaceAll("'", "''")
    legacyDatabase.exec(`VACUUM INTO '${escapedDestination}'`)
    legacyDatabase.close()
  }
  app.setPath('userData', newDirectory)
  configurationDirectory = newDirectory
  const locationFile = join(configurationDirectory, 'storage-location.json')
  databasePath = newDatabase
  if (existsSync(locationFile)) {
    try {
      const configured = JSON.parse(readFileSync(locationFile, 'utf8')) as { databasePath?: string }
      if (configured.databasePath && existsSync(dirname(configured.databasePath))) databasePath = configured.databasePath
      else startupWarning = '自定义数据位置当前不可用，已临时使用默认位置'
    } catch { startupWarning = '数据位置配置无法读取，已使用默认位置' }
  }
}

function openDatabase(): void {
  database = new DatabaseSync(databasePath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      amount_in_cents INTEGER NOT NULL CHECK (amount_in_cents > 0),
      primary_category TEXT NOT NULL,
      secondary_category TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES categories(id),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(parent_id, name)
    );
  `)
  try { database.exec('ALTER TABLE expenses ADD COLUMN primary_category_id TEXT REFERENCES categories(id)') } catch { /* 已迁移 */ }
  try { database.exec('ALTER TABLE expenses ADD COLUMN secondary_category_id TEXT REFERENCES categories(id)') } catch { /* 已迁移 */ }
  seedCategories()
}

const defaultSettings: AppSettings = { theme: 'system', defaultPaymentMethod: '微信支付' }
const defaultCategoryCatalog: Record<string,string[]> = {
  餐饮:['早餐','午餐','晚餐','零食饮料','外卖','聚餐'],交通:['公共交通','打车','加油','停车','车辆保养','长途出行'],居住:['房租','房贷','物业','水费','电费','燃气','维修'],购物:['日用品','服饰','美妆','数码','家居','其他购物'],娱乐:['电影演出','游戏','旅游','兴趣爱好','会员订阅'],医疗健康:['看病','药品','体检','健身','健康用品'],教育:['书籍','课程','考试','学习用品'],人情往来:['礼物','红包','请客','捐赠'],家庭:['育儿','老人','宠物','家庭公共支出'],其他:['手续费','罚款','临时支出','未分类']
}
function seedCategories(): void {
  const insert = database.prepare('INSERT OR IGNORE INTO categories (id,parent_id,name,enabled,is_default,sort_order) VALUES (?,?,?,?,1,?)')
  let order = 0
  for (const [primary, children] of Object.entries(defaultCategoryCatalog)) {
    const primaryId = `default-primary-${order}`; insert.run(primaryId,null,primary,1,order)
    children.forEach((child,index)=>insert.run(`${primaryId}-child-${index}`,primaryId,child,1,index)); order += 1
  }
  database.exec(`
    UPDATE expenses SET primary_category_id=(SELECT id FROM categories WHERE parent_id IS NULL AND name=expenses.primary_category LIMIT 1) WHERE primary_category_id IS NULL;
    UPDATE expenses SET secondary_category_id=(SELECT id FROM categories WHERE parent_id=expenses.primary_category_id AND name=expenses.secondary_category LIMIT 1) WHERE secondary_category_id IS NULL;
  `)
}
const csvHeaders = ['唯一编号','金额（元）','一级分类','二级分类','日期时间','备注','支付方式','商家']

function readSettings(): AppSettings {
  const rows = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return rows.reduce<AppSettings>((result, row) => ({ ...result, [row.key]: row.value }), { ...defaultSettings })
}

function resolveCategoryIds(primary: string, secondary: string): { primaryCategoryId: string; secondaryCategoryId: string } {
  const row = database.prepare(`SELECT p.id AS primaryCategoryId, s.id AS secondaryCategoryId FROM categories p JOIN categories s ON s.parent_id=p.id WHERE p.name=? AND s.name=? LIMIT 1`).get(primary,secondary) as { primaryCategoryId:string; secondaryCategoryId:string } | undefined
  if (!row) throw new Error('所选分类不存在或已被移除')
  return row
}

function registerLedgerHandlers(): void {
  ipcMain.handle('expenses:list', () => database.prepare(`
    SELECT id, amount_in_cents AS amountInCents,
      primary_category AS primaryCategory, secondary_category AS secondaryCategory,
      occurred_at AS occurredAt, note, payment_method AS paymentMethod, merchant,
      created_at AS createdAt, updated_at AS updatedAt
    FROM expenses ORDER BY occurred_at DESC
  `).all())

  ipcMain.handle('expenses:create', (_event, expense: NewExpense) => {
    if (!Number.isInteger(expense.amountInCents) || expense.amountInCents <= 0) throw new Error('金额格式不正确')
    if (!expense.primaryCategory || !expense.secondaryCategory) throw new Error('请选择完整分类')
    const now = new Date().toISOString()
    const record = { ...expense, ...resolveCategoryIds(expense.primaryCategory,expense.secondaryCategory), id: randomUUID(), createdAt: now, updatedAt: now }
    database.prepare(`
      INSERT INTO expenses (id, amount_in_cents, primary_category, secondary_category,
        occurred_at, note, payment_method, merchant, created_at, updated_at, primary_category_id, secondary_category_id)
      VALUES (@id, @amountInCents, @primaryCategory, @secondaryCategory,
        @occurredAt, @note, @paymentMethod, @merchant, @createdAt, @updatedAt, @primaryCategoryId, @secondaryCategoryId)
    `).run(record)
    return record
  })

  ipcMain.handle('expenses:update', (_event, id: string, expense: NewExpense) => {
    if (!Number.isInteger(expense.amountInCents) || expense.amountInCents <= 0) throw new Error('金额格式不正确')
    if (!expense.primaryCategory || !expense.secondaryCategory) throw new Error('请选择完整分类')
    const existing = database.prepare('SELECT created_at AS createdAt FROM expenses WHERE id = ?').get(id) as { createdAt: string } | undefined
    if (!existing) throw new Error('找不到需要修改的账目')
    const record = { ...expense, ...resolveCategoryIds(expense.primaryCategory,expense.secondaryCategory), id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
    database.prepare(`
      UPDATE expenses SET amount_in_cents=@amountInCents, primary_category=@primaryCategory,
        secondary_category=@secondaryCategory, occurred_at=@occurredAt, note=@note,
        payment_method=@paymentMethod, merchant=@merchant, updated_at=@updatedAt,
        primary_category_id=@primaryCategoryId, secondary_category_id=@secondaryCategoryId
      WHERE id=@id
    `).run(record)
    return record
  })

  ipcMain.handle('expenses:delete', (_event, id: string) => {
    database.prepare('DELETE FROM expenses WHERE id = ?').run(id)
  })

  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    if (!['system', 'light', 'dark'].includes(settings.theme)) throw new Error('主题设置无效')
    const save = database.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    save.run('theme', settings.theme); save.run('defaultPaymentMethod', settings.defaultPaymentMethod)
    return readSettings()
  })

  ipcMain.handle('data:get-location', () => databasePath)
  ipcMain.handle('data:change-location', async (): Promise<OperationResult & { path?: string }> => {
    const result = await dialog.showOpenDialog({ title: '选择账目数据存放文件夹', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, message: '已取消更改' }
    const targetDirectory = result.filePaths[0]
    const targetDatabase = join(targetDirectory, 'kelu-ledger.db')
    if (targetDatabase.toLowerCase() === databasePath.toLowerCase()) return { success: false, message: '当前账目已经保存在这个文件夹中', path: databasePath }
    if (existsSync(targetDatabase)) return { success: false, message: '目标文件夹中已有同名账本，请选择其他文件夹，避免覆盖数据' }
    const sourcePath = databasePath
    try {
      const escapedTarget = targetDatabase.replaceAll("'", "''")
      database.exec('PRAGMA wal_checkpoint(FULL)')
      database.exec(`VACUUM INTO '${escapedTarget}'`)
      const sourceCounts = database.prepare('SELECT (SELECT count(*) FROM expenses) AS expenses, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM settings) AS settings').get() as { expenses:number; categories:number; settings:number }
      const candidate = new DatabaseSync(targetDatabase, { readOnly: true })
      const targetCounts = candidate.prepare('SELECT (SELECT count(*) FROM expenses) AS expenses, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM settings) AS settings').get() as { expenses:number; categories:number; settings:number }
      candidate.close()
      if (sourceCounts.expenses !== targetCounts.expenses || sourceCounts.categories !== targetCounts.categories || sourceCounts.settings !== targetCounts.settings) throw new Error('迁移后的数据数量不一致')
      database.close()
      databasePath = targetDatabase
      try { openDatabase() }
      catch (error) { databasePath = sourcePath; openDatabase(); throw error }
      writeFileSync(join(configurationDirectory, 'storage-location.json'), JSON.stringify({ databasePath }, null, 2), 'utf8')
      return { success: true, message: '账目已安全迁移到新位置，原文件保留为备份', path: databasePath }
    } catch {
      return { success: false, message: '迁移失败，应用仍在使用原数据位置', path: sourcePath }
    }
  })

  ipcMain.handle('data:export-csv', async (): Promise<OperationResult> => {
    const result = await dialog.showSaveDialog({ title: '导出花销流水', defaultPath: `可噜记账流水-${new Date().toISOString().slice(0,10)}.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] })
    if (result.canceled || !result.filePath) return { success: false, canceled: true, message: '已取消导出' }
    const rows = database.prepare(`SELECT id, amount_in_cents AS amount, primary_category AS primaryCategory, secondary_category AS secondaryCategory, occurred_at AS occurredAt, note, payment_method AS paymentMethod, merchant FROM expenses ORDER BY occurred_at DESC`).all() as Record<string, unknown>[]
    const lines = [csvHeaders.map(csvCell).join(','), ...rows.map(row => [row.id, (Number(row.amount) / 100).toFixed(2), row.primaryCategory, row.secondaryCategory, row.occurredAt, row.note, row.paymentMethod, row.merchant].map(csvCell).join(','))]
    writeFileSync(result.filePath, `\uFEFF${lines.join('\r\n')}`, 'utf8')
    return { success: true, message: `已导出 ${rows.length} 笔花销` }
  })

  ipcMain.handle('data:preview-import-csv', async (): Promise<ImportPreview> => {
    const result = await dialog.showOpenDialog({ title: '导入花销流水', properties: ['openFile'], filters: [{ name: 'CSV 表格', extensions: ['csv'] }] })
    pendingImport = []
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, message: '已取消导入', valid: 0, duplicates: 0, errors: 0, errorDetails: [] }
    const text = readFileSync(result.filePaths[0], 'utf8').replace(/^\uFEFF/, '')
    const rows = parseCsv(text)
    if (!rows.length || rows[0].join('|') !== csvHeaders.join('|')) return { success: false, message: 'CSV 列名与可噜记账模板不一致', valid: 0, duplicates: 0, errors: 1, errorDetails: ['第一行必须使用可噜记账 CSV 模板列名'] }
    const exists = database.prepare('SELECT 1 FROM expenses WHERE id = ?')
    const seen = new Set<string>(); let duplicates = 0; const errorDetails: string[] = []
    rows.slice(1).forEach((columns, index) => {
      const [id, amount, primary, secondary, occurredAt, note = '', payment = '', merchant = ''] = columns
      const cents = Math.round(Number(amount) * 100); const rowNumber = index + 2
      if (!id || !Number.isInteger(cents) || cents <= 0 || !primary || !secondary || Number.isNaN(Date.parse(occurredAt))) {
        if (errorDetails.length < 8) errorDetails.push(`第 ${rowNumber} 行：金额、分类、日期或唯一编号不正确`)
      } else if (seen.has(id) || exists.get(id)) duplicates += 1
      else { seen.add(id); pendingImport.push([id,cents,primary,secondary,new Date(occurredAt).toISOString(),note,payment,merchant]) }
    })
    const errors = rows.length - 1 - pendingImport.length - duplicates
    return { success: true, message: '文件检查完成，请确认后导入', valid: pendingImport.length, duplicates, errors, errorDetails }
  })

  ipcMain.handle('data:confirm-import-csv', (): OperationResult => {
    if (!pendingImport.length) return { success: false, message: '没有等待导入的有效记录' }
    const insert = database.prepare(`INSERT INTO expenses (id,amount_in_cents,primary_category,secondary_category,occurred_at,note,payment_method,merchant,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    let imported = 0
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of pendingImport) {
        const now = new Date().toISOString(); insert.run(...row,now,now); imported += 1
      }
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    pendingImport = []
    return { success: true, message: `成功导入 ${imported} 笔`, imported, skipped: 0 }
  })

  ipcMain.handle('data:create-backup', async (): Promise<OperationResult> => {
    const result = await dialog.showSaveDialog({ title: '创建完整备份', defaultPath: `可噜记账备份-${new Date().toISOString().slice(0,10)}.db`, filters: [{ name: '可噜记账备份', extensions: ['db'] }] })
    if (result.canceled || !result.filePath) return { success: false, canceled: true, message: '已取消备份' }
    const escaped = result.filePath.replaceAll("'", "''")
    database.exec(`VACUUM INTO '${escaped}'`)
    return { success: true, message: '完整备份已创建' }
  })

  ipcMain.handle('data:restore-backup', async (): Promise<OperationResult> => {
    const result = await dialog.showOpenDialog({ title: '恢复完整备份', properties: ['openFile'], filters: [{ name: '可噜记账备份', extensions: ['db'] }] })
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, message: '已取消恢复' }
    const source = result.filePaths[0]; const validation = new DatabaseSync(source, { readOnly: true })
    try { validation.prepare('SELECT count(*) FROM expenses').get(); validation.prepare('SELECT count(*) FROM settings').get() }
    catch { validation.close(); return { success: false, message: '这不是有效的可噜记账备份文件' } }
    validation.close()
    const dbPath = databasePath, safetyPath = join(dirname(databasePath), `before-restore-${Date.now()}.db`)
    database.close(); copyFileSync(dbPath, safetyPath); copyFileSync(source, dbPath); openDatabase()
    return { success: true, message: '备份恢复成功，原数据已自动保存' }
  })

  ipcMain.handle('categories:list', (): CategoryGroup[] => {
    type CategoryRow = { id:string; parentId:string|null; name:string; enabled:number; isDefault:number }
    const rows = database.prepare('SELECT id,parent_id AS parentId,name,enabled,is_default AS isDefault FROM categories ORDER BY sort_order,name').all() as CategoryRow[]
    const item = (row:typeof rows[number]):CategoryItem => ({id:row.id,name:row.name,enabled:Boolean(row.enabled),isDefault:Boolean(row.isDefault)})
    return rows.filter(row=>!row.parentId).map(row=>({...item(row),children:rows.filter(child=>child.parentId===row.id).map(item)}))
  })
  ipcMain.handle('categories:add', (_event, parentId:string|null, rawName:string):OperationResult => {
    const name=rawName.trim(); if(!name)return {success:false,message:'分类名称不能为空'}
    if(parentId&&!database.prepare('SELECT 1 FROM categories WHERE id=? AND parent_id IS NULL').get(parentId))return {success:false,message:'一级分类不存在'}
    try { const max=database.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS value FROM categories WHERE parent_id IS ?').get(parentId) as {value:number}; database.prepare('INSERT INTO categories (id,parent_id,name,enabled,is_default,sort_order) VALUES (?,?,?,1,0,?)').run(randomUUID(),parentId,name,max.value); return {success:true,message:'分类已添加'} }
    catch{return {success:false,message:'同一级下已存在这个分类名称'}}
  })
  ipcMain.handle('categories:rename', (_event,id:string,rawName:string):OperationResult => {
    const name=rawName.trim(),category=database.prepare('SELECT parent_id AS parentId,name FROM categories WHERE id=?').get(id) as {parentId:string|null;name:string}|undefined
    if(!category||!name)return {success:false,message:'分类名称不能为空'}
    database.exec('BEGIN IMMEDIATE')
    try { database.prepare('UPDATE categories SET name=? WHERE id=?').run(name,id); if(category.parentId)database.prepare('UPDATE expenses SET secondary_category=? WHERE secondary_category_id=?').run(name,id);else database.prepare('UPDATE expenses SET primary_category=? WHERE primary_category_id=?').run(name,id); database.exec('COMMIT'); return {success:true,message:'分类已改名，历史账目已同步'} }
    catch{database.exec('ROLLBACK');return {success:false,message:'同一级下已存在这个分类名称'}}
  })
  ipcMain.handle('categories:toggle', (_event,id:string,enabled:boolean):OperationResult => { database.prepare('UPDATE categories SET enabled=? WHERE id=?').run(enabled?1:0,id); if(!enabled)database.prepare('UPDATE categories SET enabled=0 WHERE parent_id=?').run(id); return {success:true,message:enabled?'分类已启用':'分类已停用，历史账目不受影响'} })
  ipcMain.handle('categories:delete', (_event,id:string):OperationResult => {
    const row=database.prepare('SELECT parent_id AS parentId,is_default AS isDefault FROM categories WHERE id=?').get(id) as {parentId:string|null;isDefault:number}|undefined
    if(!row)return {success:false,message:'分类不存在'};if(row.isDefault)return {success:false,message:'默认分类不能删除，可以选择停用'}
    const used=row.parentId?database.prepare('SELECT 1 FROM expenses WHERE secondary_category_id=? LIMIT 1').get(id):database.prepare('SELECT 1 FROM expenses WHERE primary_category_id=? LIMIT 1').get(id)
    if(used)return {success:false,message:'该分类已有历史账目，只能停用'}
    if(!row.parentId&&database.prepare('SELECT 1 FROM categories WHERE parent_id=? LIMIT 1').get(id))return {success:false,message:'请先删除该分类下的二级分类'}
    database.prepare('DELETE FROM categories WHERE id=?').run(id);return {success:true,message:'分类已删除'}
  })
  ipcMain.handle('categories:move', (_event,id:string,direction:'up'|'down'):OperationResult => {
    const current=database.prepare('SELECT parent_id AS parentId,sort_order AS sortOrder FROM categories WHERE id=?').get(id) as {parentId:string|null;sortOrder:number}|undefined
    if(!current)return {success:false,message:'分类不存在'}
    const operator=direction==='up'?'<':'>';const ordering=direction==='up'?'DESC':'ASC'
    const neighbor=database.prepare(`SELECT id,sort_order AS sortOrder FROM categories WHERE parent_id IS ? AND sort_order ${operator} ? ORDER BY sort_order ${ordering} LIMIT 1`).get(current.parentId,current.sortOrder) as {id:string;sortOrder:number}|undefined
    if(!neighbor)return {success:false,message:direction==='up'?'已经在最前面':'已经在最后面'}
    database.exec('BEGIN IMMEDIATE');try{database.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(neighbor.sortOrder,id);database.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(current.sortOrder,neighbor.id);database.exec('COMMIT');return {success:true,message:'分类顺序已更新'}}catch{database.exec('ROLLBACK');return {success:false,message:'排序失败'}}
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180, height: 760, minWidth: 920, minHeight: 620,
    title: '可噜记账', backgroundColor: '#f7f4ee',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  prepareDataDirectory()
  openDatabase()
  registerLedgerHandlers()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
