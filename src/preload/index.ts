import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, LedgerApi, NewExpense } from '../shared/types'

/**
 * 提供给 React 界面的受限操作集合。
 * ipcRenderer.invoke 可以理解为“向主进程提出一次请求并等待结果”；它不会让网页直接接触数据库。
 * 参数会原样传给主进程，所以真正的数据校验仍必须在主进程再做一次。
 */
const api: LedgerApi = {
  // 收支操作只暴露增删改查四个固定请求，不提供任意 SQL 或任意文件访问能力。
  listExpenses: () => ipcRenderer.invoke('expenses:list'),
  createExpense: (expense: NewExpense) => ipcRenderer.invoke('expenses:create', expense),
  updateExpense: (id: string, expense: NewExpense) => ipcRenderer.invoke('expenses:update', id, expense),
  deleteExpense: (id: string) => ipcRenderer.invoke('expenses:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings),
  exportCsv: () => ipcRenderer.invoke('data:export-csv'),
  previewImportCsv: () => ipcRenderer.invoke('data:preview-import-csv'),
  confirmImportCsv: () => ipcRenderer.invoke('data:confirm-import-csv'),
  createBackup: () => ipcRenderer.invoke('data:create-backup'),
  restoreBackup: () => ipcRenderer.invoke('data:restore-backup'),
  listCategories: () => ipcRenderer.invoke('categories:list'),
  addCategory: (parentId: string | null, name: string, entryType: 'expense' | 'income') => ipcRenderer.invoke('categories:add', parentId, name, entryType),
  renameCategory: (id: string, name: string) => ipcRenderer.invoke('categories:rename', id, name),
  toggleCategory: (id: string, enabled: boolean) => ipcRenderer.invoke('categories:toggle', id, enabled),
  deleteCategory: (id: string) => ipcRenderer.invoke('categories:delete', id),
  moveCategory: (id: string, direction: 'up' | 'down') => ipcRenderer.invoke('categories:move', id, direction),
  getDataLocation: () => ipcRenderer.invoke('data:get-location'),
  changeDataLocation: () => ipcRenderer.invoke('data:change-location')
}
// contextBridge 把上述白名单挂到 window.ledger，同时保持网页和 Node.js 运行环境相互隔离。
contextBridge.exposeInMainWorld('ledger', api)
  // 设置和数据管理可能弹出系统文件选择窗口，窗口和文件读写都由主进程负责。
  // 分类操作使用稳定编号，改名时不依赖可能变化的中文名称来定位历史关联。
