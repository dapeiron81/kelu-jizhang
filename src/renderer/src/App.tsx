import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { BarChart3, BookOpen, Home, Pencil, Plus, Search, Settings, Tags, Trash2, WalletCards, X } from 'lucide-react'
import type { AppSettings, CategoryGroup, Expense, NewExpense, OperationResult } from '../../shared/types'
import { categories as expenseCategories, categoryEmoji, incomeCategories } from './categories'
import appIcon from '../../../build/icon.png'

type EntryType = Expense['entryType']
type Catalog = Record<string,string[]>

const navItems=[{label:'首页',icon:Home},{label:'流水',icon:BookOpen},{label:'统计',icon:BarChart3},{label:'分类',icon:Tags},{label:'设置',icon:Settings}]
const paymentMethods=['微信支付','支付宝','银行卡','现金','其他']
const money=(c:number)=>`¥${(c/100).toFixed(2)}`
const monthKey=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
const monthLabel=(key:string)=>{const [y,m]=key.split('-');return `${y}年${Number(m)}月`}
const typeLabel=(type:EntryType)=>type==='income'?'收入':'支出'

/** 把 ISO 日期时间转换为 datetime-local 使用的本地时间文本。 */
const localDateTime=(iso?:string)=>{const d=iso?new Date(iso):new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)}

/** 按一级分类汇总同一组记录，金额始终保持整数分。 */
const groupByCategory=(items:Expense[]):[string,number][]=>Object.entries(items.reduce<Record<string,number>>((result,item)=>{result[item.primaryCategory]=(result[item.primaryCategory]??0)+item.amountInCents;return result},{})).sort((a,b)=>b[1]-a[1])

/** 从数据库分类中生成某一种收支类型可用的选择目录；首次加载前使用内置目录。 */
/**
 * 把数据库里的分类整理成表单能直接使用的“两级分类表”。
 * 收入和支出必须分开整理，避免用户记录收入时误选餐饮等支出分类。
 * 停用的分类仍保留在数据库中供历史账目显示，但不再出现在新建账目的选项里。
 */
function enabledCatalog(groups:CategoryGroup[],entryType:EntryType):Catalog {
  const fallback=entryType==='income'?incomeCategories:expenseCategories
  if(!groups.length)return fallback
  return Object.fromEntries(groups.filter(group=>group.entryType===entryType&&group.enabled).map(group=>[group.name,group.children.filter(child=>child.enabled).map(child=>child.name)]).filter(([,children])=>(children as string[]).length))
}

/** 根组件统一加载收支流水、设置和两类分类，并负责页面切换和弹窗状态。 */
export default function App(){
  const [entries,setEntries]=useState<Expense[]>([]),[active,setActive]=useState('首页'),[open,setOpen]=useState(false),[editing,setEditing]=useState<Expense|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('')
  const [settings,setSettings]=useState<AppSettings>({theme:'system',defaultPaymentMethod:'微信支付'})
  const [categoryGroups,setCategoryGroups]=useState<CategoryGroup[]>([])
  const load=async()=>{try{const [items,options,groups]=await Promise.all([window.ledger.listExpenses(),window.ledger.getSettings(),window.ledger.listCategories()]);setEntries(items);setSettings(options);setCategoryGroups(groups)}catch{setError('数据读取失败，请重新启动应用')}finally{setLoading(false)}}
  // 应用首次打开时一次性读取账目、分类和设置，随后各页面共享同一份数据。
  // 这样切换页面不会反复查询数据库，也不会出现各页面显示结果不一致。
  useEffect(()=>{void load()},[])
  // 主题保存在根节点上，所有页面会同时切换，不需要逐个组件修改颜色。
  useEffect(()=>{document.documentElement.dataset.theme=settings.theme},[settings.theme])

  const current=entries.filter(item=>item.occurredAt.startsWith(monthKey(new Date())))
  const income=current.filter(item=>item.entryType==='income').reduce((sum,item)=>sum+item.amountInCents,0)
  const expense=current.filter(item=>item.entryType==='expense').reduce((sum,item)=>sum+item.amountInCents,0)
  const catalogs:{expense:Catalog;income:Catalog}={expense:enabledCatalog(categoryGroups,'expense'),income:enabledCatalog(categoryGroups,'income')}
  const add=()=>{setEditing(null);setOpen(true)}
  const edit=(entry:Expense)=>{setEditing(entry);setOpen(true)}
  const remove=async(entry:Expense)=>{if(!confirm(`确定删除 ${money(entry.amountInCents)} 的${typeLabel(entry.entryType)}记录吗？`))return;await window.ledger.deleteExpense(entry.id);await load()}

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><img className="brand-image" src={appIcon} alt="可噜记账"/><div><strong>可噜记账</strong><small>把每一笔，都记得明白</small></div></div><nav>{navItems.map(({label,icon:Icon})=><button key={label} className={active===label?'active':''} onClick={()=>setActive(label)}><Icon size={19}/>{label}</button>)}</nav><div className="privacy-note"><WalletCards size={20}/><div><strong>数据安心存在本机</strong><span>无需账号，离线也能使用</span></div></div></aside><main><header><div><p className="eyebrow">{new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})}</p><h1>{active==='首页'?'今天，也要好好生活':active}</h1></div><button className="primary" onClick={add}><Plus size={19}/>记一笔</button></header>{active==='首页'?<HomePage entries={entries} current={current} income={income} expense={expense} loading={loading} go={()=>setActive('流水')} edit={edit} remove={remove}/>:active==='流水'?<LedgerPage entries={entries} loading={loading} edit={edit} remove={remove} catalogs={catalogs}/>:active==='统计'?<StatisticsPage entries={entries}/>:active==='分类'?<CategoriesPage groups={categoryGroups} reload={load}/>:active==='设置'?<SettingsPage settings={settings} onSettings={setSettings} onReload={load}/>:null}{error&&<div className="error-toast">{error}</div>}</main><EntryDialog open={open} onOpenChange={setOpen} onSaved={load} entry={editing} defaultPayment={settings.defaultPaymentMethod} catalogs={catalogs}/></div>
}

/** 首页同时展示本月收入、支出、结余、最近流水和支出分类概览。 */
/**
 * 首页汇总当前月份的收入、支出和结余，并展示最近记录。
 * 结余只是“收入减支出”的展示结果，不会在数据库中额外生成一笔账。
 * 分类概览仍默认展示支出，帮助用户快速看清钱主要花在了哪里。
 */
function HomePage({entries,current,income,expense,loading,go,edit,remove}:{entries:Expense[];current:Expense[];income:number;expense:number;loading:boolean;go:()=>void;edit:(x:Expense)=>void;remove:(x:Expense)=>void}){
  const expenseEntries=current.filter(item=>item.entryType==='expense')
  return <><section className="hero-card"><div className="hero-summary"><div><span>本月结余</span><strong className={income-expense<0?'negative':''}>{income-expense<0?'-':''}{money(Math.abs(income-expense))}</strong></div><div className="hero-details"><p><span>收入</span><b className="income-text">+{money(income)}</b></p><p><span>支出</span><b>-{money(expense)}</b></p><p><span>记录</span><b>{current.length} 笔</b></p></div></div><div className="horse-art">动画</div></section><div className="content-grid"><section className="panel"><div className="section-title"><h2>最近流水</h2><button onClick={go}>查看全部</button></div><EntryList entries={entries.slice(0,6)} loading={loading} edit={edit} remove={remove}/></section><section className="panel"><div className="section-title"><h2>支出分类概览</h2><span>本月</span></div><CategoryBars grouped={groupByCategory(expenseEntries)} empty="这个月还没有支出"/></section></div></>
}

/** 流水页组合筛选月份、收支类型、分类、支付或收款方式和关键词。 */
/**
 * 流水页在本地完成筛选，不会改动原账目，也不会向网络发送数据。
 * 用户可组合月份、收支类型、一级分类、支付方式和关键词条件。
 * 切换收支类型后分类选项同步变化，防止收入分类与支出分类混用。
 */
function LedgerPage({entries,loading,edit,remove,catalogs}:{entries:Expense[];loading:boolean;edit:(x:Expense)=>void;remove:(x:Expense)=>void;catalogs:{expense:Catalog;income:Catalog}}){
  const [query,setQuery]=useState(''),[primary,setPrimary]=useState('全部'),[payment,setPayment]=useState('全部'),[month,setMonth]=useState('全部'),[entryType,setEntryType]=useState<'全部'|EntryType>('全部')
  const months=Array.from(new Set(entries.map(item=>item.occurredAt.slice(0,7)))).sort().reverse()
  const categoryNames=Array.from(new Set(entryType==='全部'?[...Object.keys(catalogs.expense),...Object.keys(catalogs.income)]:Object.keys(catalogs[entryType])))
  const filtered=entries.filter(item=>(month==='全部'||item.occurredAt.startsWith(month))&&(entryType==='全部'||item.entryType===entryType)&&(primary==='全部'||item.primaryCategory===primary)&&(payment==='全部'||item.paymentMethod===payment)&&(!query||`${item.merchant} ${item.note} ${item.primaryCategory} ${item.secondaryCategory}`.toLowerCase().includes(query.toLowerCase())))
  const changeType=(value:'全部'|EntryType)=>{setEntryType(value);setPrimary('全部')}
  const clear=()=>{setQuery('');setPrimary('全部');setPayment('全部');setMonth('全部');setEntryType('全部')}
  return <section className="panel page-panel"><div className="section-title"><h2>全部流水</h2><span>{filtered.length} / {entries.length} 笔</span></div><div className="filters income-filters"><label className="search-box"><Search size={16}/><input placeholder="搜索来源、商家、备注或分类" value={query} onChange={event=>setQuery(event.target.value)}/></label><select value={month} onChange={event=>setMonth(event.target.value)}><option>全部</option>{months.map(value=><option key={value} value={value}>{monthLabel(value)}</option>)}</select><select value={entryType} onChange={event=>changeType(event.target.value as '全部'|EntryType)}><option value="全部">全部收支</option><option value="expense">支出</option><option value="income">收入</option></select><select value={primary} onChange={event=>setPrimary(event.target.value)}><option>全部</option>{categoryNames.map(value=><option key={value}>{value}</option>)}</select><select value={payment} onChange={event=>setPayment(event.target.value)}><option>全部</option>{paymentMethods.map(value=><option key={value}>{value}</option>)}</select><button className="filter-clear" onClick={clear}>清除</button></div><EntryList entries={filtered} loading={loading} edit={edit} remove={remove}/></section>
}

/** 统计页固定显示收入、支出和结余，并允许切换趋势及分类分析的收支类型。 */
/**
 * 统计页按所选月份重新计算汇总，不保存重复的统计结果。
 * 用户可以单独分析收入或支出；趋势图和分类占比都跟随该选择。
 * 月结余允许为负数，负数表示当月支出超过收入。
 */
function StatisticsPage({entries}:{entries:Expense[]}){
  const available=Array.from(new Set([monthKey(new Date()),...entries.map(item=>item.occurredAt.slice(0,7))])).sort().reverse()
  const [selected,setSelected]=useState(available[0]),[analysisType,setAnalysisType]=useState<EntryType>('expense')
  const current=entries.filter(item=>item.occurredAt.startsWith(selected))
  const income=current.filter(item=>item.entryType==='income').reduce((sum,item)=>sum+item.amountInCents,0)
  const expense=current.filter(item=>item.entryType==='expense').reduce((sum,item)=>sum+item.amountInCents,0)
  const analyzed=current.filter(item=>item.entryType===analysisType)
  const [year,month]=selected.split('-').map(Number),days=new Date(year,month,0).getDate()
  const daily=Array.from({length:days},(_,index)=>analyzed.filter(item=>new Date(item.occurredAt).getDate()===index+1).reduce((sum,item)=>sum+item.amountInCents,0)),max=Math.max(...daily,1)
  return <div className="stats-page"><div className="stats-toolbar"><select value={analysisType} onChange={event=>setAnalysisType(event.target.value as EntryType)}><option value="expense">分析支出</option><option value="income">分析收入</option></select><select value={selected} onChange={event=>setSelected(event.target.value)}>{available.map(value=><option key={value} value={value}>{monthLabel(value)}</option>)}</select></div><div className="stat-cards"><section className="panel stat-card"><span>本月收入</span><strong className="income-text">+{money(income)}</strong><small>{current.filter(item=>item.entryType==='income').length} 笔收入</small></section><section className="panel stat-card"><span>本月支出</span><strong>-{money(expense)}</strong><small>{current.filter(item=>item.entryType==='expense').length} 笔支出</small></section><section className="panel stat-card"><span>本月结余</span><strong className={income-expense>=0?'income-text':'up'}>{income-expense<0?'-':''}{money(Math.abs(income-expense))}</strong><small>收入减去支出</small></section></div><div className="stats-grid"><section className="panel"><div className="section-title"><h2>每日{typeLabel(analysisType)}趋势</h2><span>{monthLabel(selected)}</span></div><div className={`daily-chart ${analysisType}`}>{daily.map((value,index)=><div key={index} title={`${index+1}日 ${money(value)}`}><i style={{height:`${Math.max(value?5:1,value/max*100)}%`}}/><span>{(index+1)%5===0||index===0?index+1:''}</span></div>)}</div></section><section className="panel"><div className="section-title"><h2>{typeLabel(analysisType)}分类占比</h2><span>{analyzed.length} 笔</span></div><CategoryBars grouped={groupByCategory(analyzed)} empty={`这个月还没有${typeLabel(analysisType)}`}/></section></div></div>
}

/** 设置页管理主题、默认支付方式、本地数据位置、CSV 和完整备份。 */
/**
 * 设置页管理外观、默认支付方式和数据文件位置。
 * 更换数据位置由主进程执行迁移，界面只显示结果，不能直接接触数据库文件。
 * 导入或恢复成功后重新加载数据，确保屏幕内容与磁盘中的实际数据一致。
 */
function SettingsPage({settings,onSettings,onReload}:{settings:AppSettings;onSettings:(x:AppSettings)=>void;onReload:()=>Promise<void>}){
  const [status,setStatus]=useState(''),[dataLocation,setDataLocation]=useState('正在读取…')
  useEffect(()=>{void window.ledger.getDataLocation().then(setDataLocation)},[])
  const save=async(next:AppSettings)=>{const saved=await window.ledger.saveSettings(next);onSettings(saved);setStatus('设置已保存')}
  const run=async(action:()=>Promise<OperationResult>,reload=false)=>{try{setStatus('正在处理…');const result=await action();setStatus(result.message);if(result.success&&reload)await onReload()}catch{setStatus('操作失败，当前数据没有改变')}}
  const importCsv=async()=>{try{setStatus('正在检查文件…');const preview=await window.ledger.previewImportCsv();if(preview.canceled||!preview.success){setStatus(`${preview.message}${preview.errorDetails.length?`：${preview.errorDetails.join('；')}`:''}`);return}const details=`可导入 ${preview.valid} 笔，重复 ${preview.duplicates} 笔，错误 ${preview.errors} 笔。${preview.errorDetails.length?`\n\n${preview.errorDetails.join('\n')}`:''}`;if(preview.valid&&confirm(`${details}\n\n确认导入有效记录吗？`))await run(()=>window.ledger.confirmImportCsv(),true);else setStatus(details)}catch{setStatus('文件检查失败，当前数据没有改变')}}
  const restore=()=>{if(confirm('恢复备份会替换当前账目。系统会先自动保存当前数据，确定继续吗？'))void run(()=>window.ledger.restoreBackup(),true)}
  const changeLocation=async()=>{try{setStatus('正在安全迁移账目…');const result=await window.ledger.changeDataLocation();setStatus(result.message);if(result.path)setDataLocation(result.path);if(result.success)await onReload()}catch{setStatus('迁移失败，当前数据位置没有改变')}}
  return <div className="settings-page"><section className="panel settings-section"><div className="section-title"><h2>外观与记账偏好</h2><span>自动保存</span></div><div className="setting-row"><div><strong>主题模式</strong><p>选择最适合你的显示方式</p></div><select value={settings.theme} onChange={event=>void save({...settings,theme:event.target.value as AppSettings['theme']})}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div className="setting-row"><div><strong>默认支付或收款方式</strong><p>新增收支记录时会自动选中</p></div><select value={settings.defaultPaymentMethod} onChange={event=>void save({...settings,defaultPaymentMethod:event.target.value})}>{paymentMethods.map(value=><option key={value}>{value}</option>)}</select></div></section><section className="panel settings-section"><div className="section-title"><h2>数据管理</h2><span>数据仅保存在本机</span></div><div className="data-location"><div><strong>账目存放位置</strong><code title={dataLocation}>{dataLocation}</code><small>更改时会迁移现有收支，原文件保留为安全备份</small></div><button className="secondary" onClick={()=>void changeLocation()}>更改位置</button></div><div className="data-actions"><button onClick={()=>void run(()=>window.ledger.exportCsv())}><strong>导出 CSV</strong><span>用表格软件查看全部收支流水</span></button><button onClick={()=>void importCsv()}><strong>导入 CSV</strong><span>兼容旧支出文件，导入前先预览</span></button><button onClick={()=>void run(()=>window.ledger.createBackup())}><strong>创建完整备份</strong><span>保存收支、分类、设置和全部数据</span></button><button className="danger-outline" onClick={restore}><strong>恢复完整备份</strong><span>用备份替换当前数据</span></button></div>{status&&<p className="operation-status">{status}</p>}</section><section className="panel settings-section privacy-card"><strong>隐私说明</strong><p>可噜记账无需账号，收支记录不会上传到云端。更换电脑或重装系统前，请主动创建完整备份。</p></section></div>
}

/** 分类管理页用收支切换器分别管理两套互不混用的两级分类。 */
/**
 * 分类管理用标签页分别维护收入分类和支出分类。
 * 新增一级分类时会写入当前标签的收支类型，新增二级分类则继承父分类类型。
 * 已使用分类的删除限制由数据库层负责，避免历史账目失去分类含义。
 */
function CategoriesPage({groups,reload}:{groups:CategoryGroup[];reload:()=>Promise<void>}){
  const [status,setStatus]=useState(''),[entryType,setEntryType]=useState<EntryType>('expense')
  const visible=groups.filter(group=>group.entryType===entryType)
  const act=async(action:()=>Promise<OperationResult>)=>{const result=await action();setStatus(result.message);if(result.success)await reload()}
  const addPrimary=()=>{const name=prompt(`请输入新的${typeLabel(entryType)}一级分类名称`);if(name)void act(()=>window.ledger.addCategory(null,name,entryType))}
  const addChild=(id:string)=>{const name=prompt('请输入新的二级分类名称');if(name)void act(()=>window.ledger.addCategory(id,name,entryType))}
  const rename=(id:string,current:string)=>{const name=prompt('请输入新的分类名称',current);if(name&&name!==current)void act(()=>window.ledger.renameCategory(id,name))}
  const remove=(id:string,name:string)=>{if(confirm(`确定删除“${name}”吗？已有历史记录的分类不会被删除。`))void act(()=>window.ledger.deleteCategory(id))}
  return <section className="panel page-panel categories-page"><div className="section-title"><div><h2>两级分类管理</h2><p>收入和支出分类相互独立，停用不影响历史记录</p></div><button className="primary small" onClick={addPrimary}><Plus size={16}/>新增一级分类</button></div><div className="type-switch"><button className={entryType==='expense'?'active':''} onClick={()=>setEntryType('expense')}>支出分类</button><button className={entryType==='income'?'active income':''} onClick={()=>setEntryType('income')}>收入分类</button></div>{status&&<p className="operation-status">{status}</p>}<div className="category-groups">{visible.map(group=><article key={group.id} className={!group.enabled?'disabled':''}><div className="category-head"><div><span className="expense-icon">{categoryEmoji[group.name]??'✨'}</span><strong>{group.name}</strong><small>{group.children.length} 个二级分类</small></div><div className="category-actions"><button onClick={()=>void act(()=>window.ledger.moveCategory(group.id,'up'))}>↑</button><button onClick={()=>void act(()=>window.ledger.moveCategory(group.id,'down'))}>↓</button><button onClick={()=>rename(group.id,group.name)}>改名</button><button onClick={()=>void act(()=>window.ledger.toggleCategory(group.id,!group.enabled))}>{group.enabled?'停用':'启用'}</button>{!group.isDefault&&<button className="danger-text" onClick={()=>remove(group.id,group.name)}>删除</button>}<button onClick={()=>addChild(group.id)}>+ 二级分类</button></div></div><div className="category-children">{group.children.map(child=><div key={child.id} className={!child.enabled?'disabled':''}><span>{child.name}</span><div><button onClick={()=>void act(()=>window.ledger.moveCategory(child.id,'up'))}>↑</button><button onClick={()=>void act(()=>window.ledger.moveCategory(child.id,'down'))}>↓</button><button onClick={()=>rename(child.id,child.name)}>改名</button><button onClick={()=>void act(()=>window.ledger.toggleCategory(child.id,!child.enabled))}>{child.enabled?'停用':'启用'}</button>{!child.isDefault&&<button className="danger-text" onClick={()=>remove(child.id,child.name)}>删除</button>}</div></div>)}</div></article>)}</div></section>
}

/** 分类横条展示金额最高的七项；收入和支出共用同一绘制规则。 */
/**
 * 分类条形图最多展示金额最高的七项，避免分类过多时首页变得拥挤。
 * 最长的一项作为 100% 基准；小金额仍保留最短可见宽度，方便用户发现它。
 */
function CategoryBars({grouped,empty}:{grouped:[string,number][];empty:string}){return grouped.length?<div className="category-bars">{grouped.slice(0,7).map(([name,value])=><div key={name}><div><span>{categoryEmoji[name]??'✨'} {name}</span><strong>{money(value)}</strong></div><i><b style={{width:`${Math.max(8,value/grouped[0][1]*100)}%`}}/></i></div>)}</div>:<Empty message={empty}/>}

/** 流水金额使用正负号和颜色区分收入与支出，但数据库金额本身始终保存为正整数分。 */
/**
 * 统一渲染首页和流水页的收支列表。
 * 收入使用加号和绿色，支出使用减号，让用户不依赖分类名称也能辨认方向。
 * 编辑和删除只向上层报告目标账目，实际数据库操作由统一流程完成。
 */
function EntryList({entries,loading,edit,remove}:{entries:Expense[];loading:boolean;edit:(x:Expense)=>void;remove:(x:Expense)=>void}){if(loading)return <Empty message="正在读取账目…"/>;if(!entries.length)return <Empty message="没有找到符合条件的收支记录"/>;return <div className="expense-list">{entries.map(entry=><article key={entry.id}><span className="expense-icon">{categoryEmoji[entry.primaryCategory]??'✨'}</span><div className="expense-main"><strong>{entry.secondaryCategory}<em className={`entry-badge ${entry.entryType}`}>{typeLabel(entry.entryType)}</em></strong><span>{entry.merchant||entry.note||entry.primaryCategory} · {entry.paymentMethod}</span></div><time>{new Date(entry.occurredAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</time><b className={entry.entryType==='income'?'income-text':''}>{entry.entryType==='income'?'+':'-'}{money(entry.amountInCents)}</b><div className="row-actions"><button aria-label="编辑" onClick={()=>edit(entry)}><Pencil size={15}/></button><button aria-label="删除" onClick={()=>void remove(entry)}><Trash2 size={15}/></button></div></article>)}</div>}

/** 在读取中或没有匹配数据时给出明确提示，避免用户误以为程序卡住。 */
function Empty({message}:{message:string}){return <div className="empty"><span>✦</span><p>{message}</p></div>}

/** 新增与编辑共用表单；切换收支类型时同步切换分类和字段文案。 */
/**
 * “记一笔”对话框同时承担新增与编辑功能。
 * 打开旧账目时完整回填原收支类型；新账目默认从支出开始，减少日常操作步骤。
 * 金额在这里以人民币元输入，保存前交给共享规则转换为整数分并校验。
 * 切换收支类型会重置为该类型的首个分类，避免提交一组不匹配的分类。
 */
function EntryDialog({open,onOpenChange,onSaved,entry,defaultPayment,catalogs}:{open:boolean;onOpenChange:(value:boolean)=>void;onSaved:()=>Promise<void>;entry:Expense|null;defaultPayment:string;catalogs:{expense:Catalog;income:Catalog}}){
  const [entryType,setEntryType]=useState<EntryType>('expense'),[amount,setAmount]=useState(''),[primary,setPrimary]=useState('餐饮'),[secondary,setSecondary]=useState('早餐'),[occurredAt,setOccurredAt]=useState(localDateTime()),[merchant,setMerchant]=useState(''),[note,setNote]=useState(''),[paymentMethod,setPaymentMethod]=useState('微信支付'),[saving,setSaving]=useState(false),[formError,setFormError]=useState('')
  // 每次打开都从账目或默认值重新初始化，关闭未保存的输入不会污染下一次记账。
  useEffect(()=>{if(!open)return;const type=entry?.entryType??'expense',catalog=catalogs[type],first=Object.keys(catalog)[0];setEntryType(type);setAmount(entry?(entry.amountInCents/100).toFixed(2):'');setPrimary(entry?.primaryCategory??first);setSecondary(entry?.secondaryCategory??catalog[first]?.[0]??'');setOccurredAt(localDateTime(entry?.occurredAt));setMerchant(entry?.merchant??'');setNote(entry?.note??'');setPaymentMethod(entry?.paymentMethod||defaultPayment);setFormError('')},[open,entry,defaultPayment])
  const changeType=(type:EntryType)=>{const catalog=catalogs[type],first=Object.keys(catalog)[0];setEntryType(type);setPrimary(first);setSecondary(catalog[first]?.[0]??'')}
  const changePrimary=(value:string)=>{setPrimary(value);setSecondary(catalogs[entryType][value]?.[0]??'')}
  const save=async(event:React.FormEvent)=>{event.preventDefault();const cents=Math.round(Number(amount)*100);if(!amount||!Number.isFinite(cents)||cents<=0||!/^\d+(\.\d{1,2})?$/.test(amount)){setFormError('请输入大于 0、最多两位小数的金额');return}const record:NewExpense={entryType,amountInCents:cents,primaryCategory:primary,secondaryCategory:secondary,occurredAt:new Date(occurredAt).toISOString(),note:note.trim(),paymentMethod,merchant:merchant.trim()};try{setSaving(true);setFormError('');if(entry)await window.ledger.updateExpense(entry.id,record);else await window.ledger.createExpense(record);await onSaved();onOpenChange(false)}catch{setFormError('保存失败，请检查收支类型、金额和分类后重试')}finally{setSaving(false)}}
  const selectedChildren=catalogs[entryType][primary]??[secondary]
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog-content"><div className="dialog-heading"><div><Dialog.Title>{entry?'编辑收支记录':'记一笔'}</Dialog.Title><Dialog.Description>{entry?'修改后会立即更新流水和统计。':'记录每一笔收入，也记清每一笔支出。'}</Dialog.Description></div><Dialog.Close className="icon-button"><X size={20}/></Dialog.Close></div><form onSubmit={save}><div className="type-switch dialog-type"><button type="button" className={entryType==='expense'?'active':''} onClick={()=>changeType('expense')}>支出</button><button type="button" className={entryType==='income'?'active income':''} onClick={()=>changeType('income')}>收入</button></div><label className={`amount-field ${entryType}`}><span>{entryType==='income'?'收了多少钱':'花了多少钱'}</span><div><i>¥</i><input autoFocus inputMode="decimal" placeholder="0.00" value={amount} onChange={event=>setAmount(event.target.value)}/></div></label><div className="form-grid"><label>一级分类<select value={primary} onChange={event=>changePrimary(event.target.value)}>{Object.keys(catalogs[entryType]).map(value=><option key={value}>{value}</option>)}</select></label><label>二级分类<select value={secondary} onChange={event=>setSecondary(event.target.value)}>{selectedChildren.map(value=><option key={value}>{value}</option>)}</select></label><label>日期时间<input type="datetime-local" value={occurredAt} onChange={event=>setOccurredAt(event.target.value)}/></label><label>{entryType==='income'?'收款方式':'支付方式'}<select value={paymentMethod} onChange={event=>setPaymentMethod(event.target.value)}>{paymentMethods.map(value=><option key={value}>{value}</option>)}</select></label><label>{entryType==='income'?'来源（选填）':'商家（选填）'}<input placeholder={entryType==='income'?'例如：某某公司':'例如：街角咖啡店'} value={merchant} onChange={event=>setMerchant(event.target.value)}/></label><label>备注（选填）<input placeholder="写点什么…" value={note} onChange={event=>setNote(event.target.value)}/></label></div>{formError&&<p className="form-error">{formError}</p>}<div className="dialog-actions"><Dialog.Close type="button" className="secondary">取消</Dialog.Close><button className="primary" disabled={saving}>{saving?'正在保存…':entry?'保存修改':`保存${typeLabel(entryType)}`}</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
}
