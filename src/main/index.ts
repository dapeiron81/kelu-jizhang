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
type CsvExpense = [string, 'expense' | 'income', number, string, string, string, string, string, string, string, string]
let pendingImport: CsvExpense[] = []

app.setName('可噜记账')

/**
 * 确定本次启动要使用的账目文件和配置文件夹。
 * 默认数据库位于当前 Windows 用户的应用数据目录，不会打包进安装程序。
 * 如果发现旧“黑马记账”数据库而新库尚不存在，会复制一份完整快照完成名称迁移。
 * storage-location.json 只记录用户后来选择的路径；读取失败时退回默认位置并留下启动警告。
 * 此函数只准备路径，不打开数据库，也不会删除旧文件。
 */
function prepareDataDirectory(): void {
  const newDirectory = join(app.getPath('appData'), '可噜记账')
  const newDatabase = join(newDirectory, 'kelu-ledger.db')
  const oldDatabase = join(app.getPath('appData'), 'heima-ledger', 'heima-ledger.db')
  mkdirSync(newDirectory, { recursive: true })
  // VACUUM INTO 让 SQLite 自己生成一致的快照，比应用逐表复制更不容易遗漏数据。
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
  // 自定义位置不可用时继续打开默认账本；startupWarning 会在窗口启动后告知界面。
  if (existsSync(locationFile)) {
    try {
      const configured = JSON.parse(readFileSync(locationFile, 'utf8')) as { databasePath?: string }
      if (configured.databasePath && existsSync(dirname(configured.databasePath))) databasePath = configured.databasePath
      else startupWarning = '自定义数据位置当前不可用，已临时使用默认位置'
    } catch { startupWarning = '数据位置配置无法读取，已使用默认位置' }
  }
}

/**
 * 打开 databasePath 指向的 SQLite 文件，并补齐第一版需要的表和字段。
 * SQLite 是随应用运行环境提供的本地数据库，用户不需要另装数据库软件。
 * WAL 模式把正在写入的内容暂存到日志文件，减少读取和写入相互阻塞。
 * 已存在的数据库不会被清空；CREATE IF NOT EXISTS 只创建缺少的表。
 * 最后会补充默认分类，并尝试为旧账目回填稳定分类编号。
 */
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
      updated_at TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income'))
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
      entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income')),
      UNIQUE(parent_id, name)
    );
  `)
  // 当前兼容逻辑会忽略 ALTER TABLE 的所有异常，通常代表字段已存在，但也可能掩盖其他数据库错误。
  // 这条注释明确记录真实行为和风险，不能把任何异常都误称为“已经迁移成功”。
  try { database.exec('ALTER TABLE expenses ADD COLUMN primary_category_id TEXT REFERENCES categories(id)') } catch { /* 已迁移 */ }
  try { database.exec('ALTER TABLE expenses ADD COLUMN secondary_category_id TEXT REFERENCES categories(id)') } catch { /* 已迁移 */ }
  // 旧版本只有支出，因此新增字段的默认值必须是 expense，升级后历史账目含义保持不变。
  try { database.exec("ALTER TABLE expenses ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income'))") } catch { /* 已迁移 */ }
  try { database.exec("ALTER TABLE categories ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'expense' CHECK(entry_type IN ('expense','income'))") } catch { /* 已迁移 */ }
  seedCategories()
}

const defaultSettings: AppSettings = { theme: 'system', defaultPaymentMethod: '微信支付' }
const defaultCategoryCatalog: Record<string,string[]> = {
  餐饮:['早餐','午餐','晚餐','零食饮料','外卖','聚餐'],交通:['公共交通','打车','加油','停车','车辆保养','长途出行'],居住:['房租','房贷','物业','水费','电费','燃气','维修'],购物:['日用品','服饰','美妆','数码','家居','其他购物'],娱乐:['电影演出','游戏','旅游','兴趣爱好','会员订阅'],医疗健康:['看病','药品','体检','健身','健康用品'],教育:['书籍','课程','考试','学习用品'],人情往来:['礼物','红包','请客','捐赠'],家庭:['育儿','老人','宠物','家庭公共支出'],其他:['手续费','罚款','临时支出','未分类']
}
const defaultIncomeCategoryCatalog: Record<string,string[]> = {
  工资收入:['基本工资','奖金','津贴补贴','加班收入'],经营收入:['商品销售','服务收入','副业收入','项目收入'],投资收益:['利息','分红','基金股票','理财收益'],退款报销:['购物退款','费用报销','保险理赔'],人情收款:['红包','礼金','亲友转入'],资产处置:['二手出售','资产转让'],其他收入:['奖励','意外所得','未分类']
}
/**
 * 在新数据库中加入产品文档规定的默认两级分类。
 * INSERT OR IGNORE 保留用户已有分类，不会因每次启动而重复插入或覆盖改名结果。
 * 默认编号由固定顺序生成，使同一版本在不同电脑上得到稳定编号。
 * 随后的两条 UPDATE 只处理尚无编号的旧账目，并按原有分类名称寻找对应编号。
 */
function seedCategories(): void {
  const insert = database.prepare('INSERT OR IGNORE INTO categories (id,parent_id,name,enabled,is_default,sort_order,entry_type) VALUES (?,?,?,?,1,?,?)')
  const seed = (catalog:Record<string,string[]>,entryType:'expense'|'income',prefix:string) => {
    let order = 0
    for (const [primary, children] of Object.entries(catalog)) {
      const primaryId = `${prefix}-primary-${order}`; insert.run(primaryId,null,primary,1,order,entryType)
      children.forEach((child,index)=>insert.run(`${primaryId}-child-${index}`,primaryId,child,1,index,entryType)); order += 1
    }
  }
  seed(defaultCategoryCatalog,'expense','default')
  seed(defaultIncomeCategoryCatalog,'income','default-income')
  database.exec(`
    UPDATE expenses SET primary_category_id=(SELECT id FROM categories WHERE parent_id IS NULL AND name=expenses.primary_category LIMIT 1) WHERE primary_category_id IS NULL;
    UPDATE expenses SET secondary_category_id=(SELECT id FROM categories WHERE parent_id=expenses.primary_category_id AND name=expenses.secondary_category LIMIT 1) WHERE secondary_category_id IS NULL;
  `)
}
const csvHeaders = ['唯一编号','收支类型','金额（元）','一级分类','二级分类','日期时间','备注','支付或收款方式','商家或来源']
const legacyCsvHeaders = ['唯一编号','金额（元）','一级分类','二级分类','日期时间','备注','支付方式','商家']

/**
 * 从键值表读取全部设置，并与默认值合并。
 * 数据库里没有保存过的设置继续使用默认值，因此旧版本升级后不会得到 undefined。
 * 本函数只读取数据，不修改数据库。
 */
function readSettings(): AppSettings {
  const rows = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return rows.reduce<AppSettings>((result, row) => ({ ...result, [row.key]: row.value }), { ...defaultSettings })
}

/**
 * 根据一级和二级分类名称找到数据库中的稳定编号。
 * 查询同时要求二级分类确实属于所选一级分类，避免保存错误的两级组合。
 * 找不到匹配项时抛出可读错误，调用方应阻止花销写入。
 */
function resolveCategoryIds(primary: string, secondary: string, entryType: 'expense' | 'income'): { primaryCategoryId: string; secondaryCategoryId: string } {
  const row = database.prepare(`SELECT p.id AS primaryCategoryId, s.id AS secondaryCategoryId FROM categories p JOIN categories s ON s.parent_id=p.id WHERE p.name=? AND s.name=? AND p.entry_type=? AND s.entry_type=? LIMIT 1`).get(primary,secondary,entryType,entryType) as { primaryCategoryId:string; secondaryCategoryId:string } | undefined
  if (!row) throw new Error('所选分类不存在或已被移除')
  return row
}

/**
 * 注册界面能够调用的全部账本操作。
 * IPC 可以理解为界面和主进程之间的受限消息通道：界面发出固定名称的请求，主进程执行数据库或文件工作。
 * 数据库始终留在主进程，React 页面不会获得任意 SQL、任意路径或任意系统命令能力。
 * 每个处理器的返回值会通过预加载层传回界面；抛出的错误由界面显示为失败提示。
 */
function registerLedgerHandlers(): void {
  /** 返回全部账目，按实际发生时间从新到旧排列；金额单位保持为整数分。 */
  ipcMain.handle('expenses:list', () => database.prepare(`
    SELECT id, amount_in_cents AS amountInCents,
      primary_category AS primaryCategory, secondary_category AS secondaryCategory,
      occurred_at AS occurredAt, note, payment_method AS paymentMethod, merchant,
      created_at AS createdAt, updated_at AS updatedAt, entry_type AS entryType
    FROM expenses ORDER BY occurred_at DESC
  `).all())

  /**
   * 新建一笔花销。
   * 主进程再次验证正整数金额和完整分类，不能只相信界面已经检查过。
   * 唯一编号和创建、修改时间在这里生成，保存成功后返回完整记录。
   */
  ipcMain.handle('expenses:create', (_event, expense: NewExpense) => {
    if (!Number.isInteger(expense.amountInCents) || expense.amountInCents <= 0) throw new Error('金额格式不正确')
    if (!expense.primaryCategory || !expense.secondaryCategory) throw new Error('请选择完整分类')
    const now = new Date().toISOString()
    if (!['expense','income'].includes(expense.entryType)) throw new Error('收支类型不正确')
    const record = { ...expense, ...resolveCategoryIds(expense.primaryCategory,expense.secondaryCategory,expense.entryType), id: randomUUID(), createdAt: now, updatedAt: now }
    database.prepare(`
      INSERT INTO expenses (id, amount_in_cents, primary_category, secondary_category,
        occurred_at, note, payment_method, merchant, created_at, updated_at, primary_category_id, secondary_category_id, entry_type)
      VALUES (@id, @amountInCents, @primaryCategory, @secondaryCategory,
        @occurredAt, @note, @paymentMethod, @merchant, @createdAt, @updatedAt, @primaryCategoryId, @secondaryCategoryId, @entryType)
    `).run(record)
    return record
  })

  /**
   * 更新指定账目并保留最初的创建时间。
   * 修改分类时重新解析稳定编号；不存在的账目会明确失败，不会悄悄新建一笔。
   */
  ipcMain.handle('expenses:update', (_event, id: string, expense: NewExpense) => {
    if (!Number.isInteger(expense.amountInCents) || expense.amountInCents <= 0) throw new Error('金额格式不正确')
    if (!expense.primaryCategory || !expense.secondaryCategory) throw new Error('请选择完整分类')
    const existing = database.prepare('SELECT created_at AS createdAt FROM expenses WHERE id = ?').get(id) as { createdAt: string } | undefined
    if (!existing) throw new Error('找不到需要修改的账目')
    if (!['expense','income'].includes(expense.entryType)) throw new Error('收支类型不正确')
    const record = { ...expense, ...resolveCategoryIds(expense.primaryCategory,expense.secondaryCategory,expense.entryType), id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
    database.prepare(`
      UPDATE expenses SET amount_in_cents=@amountInCents, primary_category=@primaryCategory,
        secondary_category=@secondaryCategory, occurred_at=@occurredAt, note=@note,
        payment_method=@paymentMethod, merchant=@merchant, updated_at=@updatedAt,
        primary_category_id=@primaryCategoryId, secondary_category_id=@secondaryCategoryId, entry_type=@entryType
      WHERE id=@id
    `).run(record)
    return record
  })

  /** 按唯一编号永久删除一笔花销；二次确认由界面在调用前完成。 */
  ipcMain.handle('expenses:delete', (_event, id: string) => {
    database.prepare('DELETE FROM expenses WHERE id = ?').run(id)
  })

  // 设置采用“有则更新、无则新增”的写法，使第一次保存和以后修改走同一条路径。
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    if (!['system', 'light', 'dark'].includes(settings.theme)) throw new Error('主题设置无效')
    const save = database.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    save.run('theme', settings.theme); save.run('defaultPaymentMethod', settings.defaultPaymentMethod)
    return readSettings()
  })

  /** 返回当前真正打开的数据库文件路径，设置页只把它显示给用户。 */
  ipcMain.handle('data:get-location', () => databasePath)
  /**
   * 把整个账本迁移到用户选择的文件夹。
   * 先生成 SQLite 快照，再核对账目、分类和设置数量；三者一致才切换当前连接。
   * 目标已有同名账本时拒绝覆盖，原数据库也始终保留，便于意外时人工找回。
   * 若新数据库无法打开，会重新打开原路径；外层失败结果不会把内部异常细节暴露给界面。
   */
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
      // 先把 WAL 日志合并进主文件，再创建快照，避免刚写入的账目遗漏在迁移外。
      database.exec(`VACUUM INTO '${escapedTarget}'`)
      const sourceCounts = database.prepare('SELECT (SELECT count(*) FROM expenses) AS expenses, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM settings) AS settings').get() as { expenses:number; categories:number; settings:number }
      const candidate = new DatabaseSync(targetDatabase, { readOnly: true })
      const targetCounts = candidate.prepare('SELECT (SELECT count(*) FROM expenses) AS expenses, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM settings) AS settings').get() as { expenses:number; categories:number; settings:number }
      candidate.close()
      if (sourceCounts.expenses !== targetCounts.expenses || sourceCounts.categories !== targetCounts.categories || sourceCounts.settings !== targetCounts.settings) throw new Error('迁移后的数据数量不一致')
      // 只有快照数量核对完成后才关闭旧连接并尝试切换，降低中途失败影响当前账本的概率。
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

  /**
   * 把全部流水写成 UTF-8 CSV 文件，供常见表格软件打开。
   * 数据库中的整数分在导出时转换为固定两位小数的元；第一行使用固定中文列名。
   * 文件开头的 BOM 用于帮助 Windows 表格软件正确识别中文编码。
   */
  ipcMain.handle('data:export-csv', async (): Promise<OperationResult> => {
    const result = await dialog.showSaveDialog({ title: '导出收支流水', defaultPath: `可噜记账流水-${new Date().toISOString().slice(0,10)}.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] })
    if (result.canceled || !result.filePath) return { success: false, canceled: true, message: '已取消导出' }
    const rows = database.prepare(`SELECT id, entry_type AS entryType, amount_in_cents AS amount, primary_category AS primaryCategory, secondary_category AS secondaryCategory, occurred_at AS occurredAt, note, payment_method AS paymentMethod, merchant FROM expenses ORDER BY occurred_at DESC`).all() as Record<string, unknown>[]
    const lines = [csvHeaders.map(csvCell).join(','), ...rows.map(row => [row.id, row.entryType==='income'?'收入':'支出', (Number(row.amount) / 100).toFixed(2), row.primaryCategory, row.secondaryCategory, row.occurredAt, row.note, row.paymentMethod, row.merchant].map(csvCell).join(','))]
    writeFileSync(result.filePath, `\uFEFF${lines.join('\r\n')}`, 'utf8')
    return { success: true, message: `已导出 ${rows.length} 笔收支记录` }
  })

  /**
   * 读取用户选择的 CSV 并预览，不立即写入数据库。
   * 首先核对固定列名，然后逐行检查编号、正金额、分类文本和可解析日期。
   * 数据库已有编号或同一文件重复编号会计入 duplicates；少量错误原因返回界面展示。
   * 合格记录暂存在内存 pendingImport，只有用户下一步确认才会保存。
   */
  ipcMain.handle('data:preview-import-csv', async (): Promise<ImportPreview> => {
    const result = await dialog.showOpenDialog({ title: '导入收支流水', properties: ['openFile'], filters: [{ name: 'CSV 表格', extensions: ['csv'] }] })
    pendingImport = []
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, message: '已取消导入', valid: 0, duplicates: 0, errors: 0, errorDetails: [] }
    const text = readFileSync(result.filePaths[0], 'utf8').replace(/^\uFEFF/, '')
    const rows = parseCsv(text)
    const isLegacy = rows[0]?.join('|') === legacyCsvHeaders.join('|')
    if (!rows.length || (!isLegacy && rows[0].join('|') !== csvHeaders.join('|'))) return { success: false, message: 'CSV 列名与可噜记账模板不一致', valid: 0, duplicates: 0, errors: 1, errorDetails: ['第一行必须使用可噜记账 CSV 模板列名'] }
    const exists = database.prepare('SELECT 1 FROM expenses WHERE id = ?')
    // seen 发现文件内部重复编号，数据库查询则发现与现有账目重复的编号。
    const seen = new Set<string>(); let duplicates = 0; const errorDetails: string[] = []
    rows.slice(1).forEach((columns, index) => {
      const [id, rawType, amount, primary, secondary, occurredAt, note = '', payment = '', merchant = ''] = isLegacy ? [columns[0],'支出',...columns.slice(1)] : columns
      const entryType = rawType === '收入' ? 'income' : rawType === '支出' ? 'expense' : null
      const cents = Math.round(Number(amount) * 100); const rowNumber = index + 2
      if (!id || !entryType || !Number.isInteger(cents) || cents <= 0 || !primary || !secondary || Number.isNaN(Date.parse(occurredAt))) {
        if (errorDetails.length < 8) errorDetails.push(`第 ${rowNumber} 行：金额、分类、日期或唯一编号不正确`)
      } else if (seen.has(id) || exists.get(id)) duplicates += 1
      else {
        try {
          const ids=resolveCategoryIds(primary,secondary,entryType)
          seen.add(id); pendingImport.push([id,entryType,cents,primary,secondary,new Date(occurredAt).toISOString(),note,payment,merchant,ids.primaryCategoryId,ids.secondaryCategoryId])
        } catch { if (errorDetails.length < 8) errorDetails.push(`第 ${rowNumber} 行：所选${entryType==='income'?'收入':'支出'}分类不存在`) }
      }
    })
    const errors = rows.length - 1 - pendingImport.length - duplicates
    return { success: true, message: '文件检查完成，请确认后导入', valid: pendingImport.length, duplicates, errors, errorDetails }
  })

  /**
   * 把上一步预览中暂存的有效记录一次性写入数据库。
   * BEGIN IMMEDIATE 开始事务：可以把它理解为“全部成功才生效”的保护范围。
   * 任意一条写入失败都会 ROLLBACK 整批撤销，避免只导入半份文件。
   * 成功后清空内存中的待导入列表，防止用户误点两次造成重复写入。
   */
  ipcMain.handle('data:confirm-import-csv', (): OperationResult => {
    if (!pendingImport.length) return { success: false, message: '没有等待导入的有效记录' }
    const insert = database.prepare(`INSERT INTO expenses (id,entry_type,amount_in_cents,primary_category,secondary_category,occurred_at,note,payment_method,merchant,primary_category_id,secondary_category_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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

  /**
   * 把当前 SQLite 账本保存为用户指定的独立 .db 备份文件。
   * VACUUM INTO 由数据库生成一致快照，包含账目、分类和设置；不会移动或删除当前账本。
   */
  ipcMain.handle('data:create-backup', async (): Promise<OperationResult> => {
    const result = await dialog.showSaveDialog({ title: '创建完整备份', defaultPath: `可噜记账备份-${new Date().toISOString().slice(0,10)}.db`, filters: [{ name: '可噜记账备份', extensions: ['db'] }] })
    if (result.canceled || !result.filePath) return { success: false, canceled: true, message: '已取消备份' }
    const escaped = result.filePath.replaceAll("'", "''")
    database.exec(`VACUUM INTO '${escaped}'`)
    return { success: true, message: '完整备份已创建' }
  })

  /**
   * 用用户选择的 .db 备份替换当前账本。
   * 当前实现先试读 expenses 和 settings 表，再在同目录保存 before-restore 安全副本。
   * 随后关闭当前连接、复制备份并重新打开；这是真实覆盖操作，不是把数据合并到现有账本。
   * 注意：复制或重新打开失败时目前没有自动把安全副本恢复回来，这是待修复的数据可靠性风险。
   */
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

  /**
   * 读取扁平的分类表并组装成“一级分类带 children”的界面结构。
   * SQLite 用 0/1 保存开关，这里转换为更清楚的布尔值 true/false。
   */
  ipcMain.handle('categories:list', (): CategoryGroup[] => {
    type CategoryRow = { id:string; parentId:string|null; name:string; enabled:number; isDefault:number; entryType:'expense'|'income' }
    const rows = database.prepare('SELECT id,parent_id AS parentId,name,enabled,is_default AS isDefault,entry_type AS entryType FROM categories ORDER BY entry_type,sort_order,name').all() as CategoryRow[]
    const item = (row:typeof rows[number]):CategoryItem => ({id:row.id,name:row.name,enabled:Boolean(row.enabled),isDefault:Boolean(row.isDefault)})
    return rows.filter(row=>!row.parentId).map(row=>({...item(row),entryType:row.entryType,children:rows.filter(child=>child.parentId===row.id).map(item)}))
  })
  /**
   * 新增一级或二级分类。
   * parentId 为空表示一级分类，否则必须指向真实的一级分类；同一层级不允许重名。
   * 新分类排在同层末尾，默认启用且不标记为系统默认分类。
   */
  ipcMain.handle('categories:add', (_event, parentId:string|null, rawName:string, requestedType:'expense'|'income'):OperationResult => {
    const name=rawName.trim(); if(!name)return {success:false,message:'分类名称不能为空'}
    const parent=parentId?database.prepare('SELECT entry_type AS entryType FROM categories WHERE id=? AND parent_id IS NULL').get(parentId) as {entryType:'expense'|'income'}|undefined:undefined
    if(parentId&&!parent)return {success:false,message:'一级分类不存在'}
    const entryType=parent?.entryType??requestedType;if(!['expense','income'].includes(entryType))return {success:false,message:'分类类型不正确'}
    try { const max=database.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS value FROM categories WHERE parent_id IS ? AND entry_type=?').get(parentId,entryType) as {value:number}; database.prepare('INSERT INTO categories (id,parent_id,name,enabled,is_default,sort_order,entry_type) VALUES (?,?,?,1,0,?,?)').run(randomUUID(),parentId,name,max.value,entryType); return {success:true,message:'分类已添加'} }
    catch{return {success:false,message:'同一级下已存在这个分类名称'}}
  })
  /**
   * 修改分类名称，并用事务同步所有历史账目的展示名称。
   * 稳定分类编号保持不变，因此改名不会切断账目和分类之间的关联。
   * 重名或任意写入失败时整体回滚，分类表和历史账目不会只改一半。
   */
  ipcMain.handle('categories:rename', (_event,id:string,rawName:string):OperationResult => {
    const name=rawName.trim(),category=database.prepare('SELECT parent_id AS parentId,name FROM categories WHERE id=?').get(id) as {parentId:string|null;name:string}|undefined
    if(!category||!name)return {success:false,message:'分类名称不能为空'}
    database.exec('BEGIN IMMEDIATE')
    try { database.prepare('UPDATE categories SET name=? WHERE id=?').run(name,id); if(category.parentId)database.prepare('UPDATE expenses SET secondary_category=? WHERE secondary_category_id=?').run(name,id);else database.prepare('UPDATE expenses SET primary_category=? WHERE primary_category_id=?').run(name,id); database.exec('COMMIT'); return {success:true,message:'分类已改名，历史账目已同步'} }
    catch{database.exec('ROLLBACK');return {success:false,message:'同一级下已存在这个分类名称'}}
  })
  /**
   * 启用或停用分类；停用一级分类时同时停用它的全部二级分类。
   * 此操作不删除记录，也不改历史账目，只控制新增账目时是否还能选择该分类。
   */
  ipcMain.handle('categories:toggle', (_event,id:string,enabled:boolean):OperationResult => { database.prepare('UPDATE categories SET enabled=? WHERE id=?').run(enabled?1:0,id); if(!enabled)database.prepare('UPDATE categories SET enabled=0 WHERE parent_id=?').run(id); return {success:true,message:enabled?'分类已启用':'分类已停用，历史账目不受影响'} })
  /**
   * 删除尚未使用的自定义分类。
   * 默认分类不能删除；有历史账目的分类只能停用；一级分类仍有子项时也必须先处理子项。
   * 这些限制防止删除分类时让既有账目失去可解释的归属。
   */
  ipcMain.handle('categories:delete', (_event,id:string):OperationResult => {
    const row=database.prepare('SELECT parent_id AS parentId,is_default AS isDefault FROM categories WHERE id=?').get(id) as {parentId:string|null;isDefault:number}|undefined
    if(!row)return {success:false,message:'分类不存在'};if(row.isDefault)return {success:false,message:'默认分类不能删除，可以选择停用'}
    const used=row.parentId?database.prepare('SELECT 1 FROM expenses WHERE secondary_category_id=? LIMIT 1').get(id):database.prepare('SELECT 1 FROM expenses WHERE primary_category_id=? LIMIT 1').get(id)
    if(used)return {success:false,message:'该分类已有历史账目，只能停用'}
    if(!row.parentId&&database.prepare('SELECT 1 FROM categories WHERE parent_id=? LIMIT 1').get(id))return {success:false,message:'请先删除该分类下的二级分类'}
    database.prepare('DELETE FROM categories WHERE id=?').run(id);return {success:true,message:'分类已删除'}
  })
  /**
   * 把分类与同层相邻项目交换排序号，实现向上或向下移动一步。
   * 两次更新放在事务中，任意失败都会恢复原顺序，不留下重复或半更新的排序号。
   */
  ipcMain.handle('categories:move', (_event,id:string,direction:'up'|'down'):OperationResult => {
    const current=database.prepare('SELECT parent_id AS parentId,sort_order AS sortOrder FROM categories WHERE id=?').get(id) as {parentId:string|null;sortOrder:number}|undefined
    if(!current)return {success:false,message:'分类不存在'}
    const operator=direction==='up'?'<':'>';const ordering=direction==='up'?'DESC':'ASC'
    const neighbor=database.prepare(`SELECT id,sort_order AS sortOrder FROM categories WHERE parent_id IS ? AND sort_order ${operator} ? ORDER BY sort_order ${ordering} LIMIT 1`).get(current.parentId,current.sortOrder) as {id:string;sortOrder:number}|undefined
    if(!neighbor)return {success:false,message:direction==='up'?'已经在最前面':'已经在最后面'}
    database.exec('BEGIN IMMEDIATE');try{database.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(neighbor.sortOrder,id);database.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(current.sortOrder,neighbor.id);database.exec('COMMIT');return {success:true,message:'分类顺序已更新'}}catch{database.exec('ROLLBACK');return {success:false,message:'排序失败'}}
  })
}

/**
 * 创建应用主窗口并加载 React 界面。
 * 最小尺寸保证主要记账控件仍有可用空间；背景色减少页面加载前的白色闪烁。
 * contextIsolation 隔离网页和预加载环境，nodeIntegration=false 禁止网页直接使用 Node.js 本机能力。
 * 开发模式加载本地开发地址，正式安装包则加载已经构建好的本地 HTML 文件。
 */
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

// Electron 准备完成后，按“路径 → 数据库 → IPC → 窗口”的顺序启动，避免界面先于数据层工作。
app.whenReady().then(() => {
  prepareDataDirectory()
  openDatabase()
  registerLedgerHandlers()
  createWindow()
  // macOS 点击程序坞图标时可能需要重新建窗；Windows 第一版不会走到这一分支。
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
// Windows 所有窗口关闭后结束进程；保留 macOS 常见的程序坞驻留行为，方便未来恢复跨平台支持。
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
