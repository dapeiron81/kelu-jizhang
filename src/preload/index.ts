import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, LedgerApi, NewExpense } from '../shared/types'

const api: LedgerApi = {
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
  addCategory: (parentId: string | null, name: string) => ipcRenderer.invoke('categories:add', parentId, name),
  renameCategory: (id: string, name: string) => ipcRenderer.invoke('categories:rename', id, name),
  toggleCategory: (id: string, enabled: boolean) => ipcRenderer.invoke('categories:toggle', id, enabled),
  deleteCategory: (id: string) => ipcRenderer.invoke('categories:delete', id),
  moveCategory: (id: string, direction: 'up' | 'down') => ipcRenderer.invoke('categories:move', id, direction),
  getDataLocation: () => ipcRenderer.invoke('data:get-location'),
  changeDataLocation: () => ipcRenderer.invoke('data:change-location')
}
contextBridge.exposeInMainWorld('ledger', api)
