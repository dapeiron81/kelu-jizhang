/**
 * 一笔已经保存成功的收支记录。
 * 金额始终以整数“分”保存；三个时间字段使用可被 JavaScript 读取的日期时间文本。
 * 分类名称用于直接展示，稳定分类编号只在主进程数据库内部维护。
 */
export interface Expense {
  id: string
  entryType: 'expense' | 'income'
  amountInCents: number
  primaryCategory: string
  secondaryCategory: string
  occurredAt: string
  note: string
  paymentMethod: string
  merchant: string
  createdAt: string
  updatedAt: string
}

/**
 * 新增或编辑收支记录时由界面提交的内容。
 * 唯一编号和创建、修改时间由主进程生成，界面不能自行指定这些字段。
 */
export type NewExpense = Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 用户可调整的本机设置。
 * 主题影响整个界面；默认支付方式会自动填入新的收入或支出，用户仍可临时修改。
 */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  defaultPaymentMethod: string
}

/**
 * 数据管理和分类操作共用的结果格式。
 * success 表示操作是否真正完成；用户主动取消时另用 canceled 区分，不当成程序错误。
 */
export interface OperationResult {
  success: boolean
  canceled?: boolean
  message: string
  imported?: number
  skipped?: number
}

/**
 * CSV 写入数据库前的预览统计。
 * errorDetails 只保留少量可读错误，避免一个大文件让界面显示过多文字。
 */
export interface ImportPreview extends OperationResult {
  valid: number
  duplicates: number
  errors: number
  errorDetails: string[]
}

/** 一级或二级分类的共同信息；停用分类仍保留，保证历史账目可以继续显示。 */
export interface CategoryItem {
  id: string
  name: string
  enabled: boolean
  isDefault: boolean
}

/** 一级分类及其直属二级分类，供界面一次性绘制完整的两级结构。 */
export interface CategoryGroup extends CategoryItem {
  entryType: 'expense' | 'income'
  children: CategoryItem[]
}

/**
 * React 界面可以调用的全部本机能力。
 * 这是一道安全边界：界面只能使用这里列出的具体操作，不能直接读文件或执行任意 SQL。
 * 每个 Promise 的实际工作都由 Electron 主进程完成，失败时会把错误传回界面处理。
 */
export interface LedgerApi {
  listExpenses(): Promise<Expense[]>
  createExpense(expense: NewExpense): Promise<Expense>
  updateExpense(id: string, expense: NewExpense): Promise<Expense>
  deleteExpense(id: string): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  exportCsv(): Promise<OperationResult>
  previewImportCsv(): Promise<ImportPreview>
  confirmImportCsv(): Promise<OperationResult>
  createBackup(): Promise<OperationResult>
  restoreBackup(): Promise<OperationResult>
  listCategories(): Promise<CategoryGroup[]>
  addCategory(parentId: string | null, name: string, entryType: 'expense' | 'income'): Promise<OperationResult>
  renameCategory(id: string, name: string): Promise<OperationResult>
  toggleCategory(id: string, enabled: boolean): Promise<OperationResult>
  deleteCategory(id: string): Promise<OperationResult>
  moveCategory(id: string, direction: 'up' | 'down'): Promise<OperationResult>
  getDataLocation(): Promise<string>
  changeDataLocation(): Promise<OperationResult & { path?: string }>
}
