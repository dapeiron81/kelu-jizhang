export interface Expense {
  id: string
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

export type NewExpense = Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  defaultPaymentMethod: string
}

export interface OperationResult {
  success: boolean
  canceled?: boolean
  message: string
  imported?: number
  skipped?: number
}

export interface ImportPreview extends OperationResult {
  valid: number
  duplicates: number
  errors: number
  errorDetails: string[]
}

export interface CategoryItem {
  id: string
  name: string
  enabled: boolean
  isDefault: boolean
}

export interface CategoryGroup extends CategoryItem {
  children: CategoryItem[]
}

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
  addCategory(parentId: string | null, name: string): Promise<OperationResult>
  renameCategory(id: string, name: string): Promise<OperationResult>
  toggleCategory(id: string, enabled: boolean): Promise<OperationResult>
  deleteCategory(id: string): Promise<OperationResult>
  moveCategory(id: string, direction: 'up' | 'down'): Promise<OperationResult>
  getDataLocation(): Promise<string>
  changeDataLocation(): Promise<OperationResult & { path?: string }>
}
