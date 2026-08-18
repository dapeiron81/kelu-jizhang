import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RECEIPT_SCHEMA_VERSION = 1
const RECEIPT_MAX_AGE_MS = 60 * 60 * 1000
const CHECKERS = { 'unit-test': 'unit-test.json', quality: 'quality.json' }

/** 执行只读 Git 命令，并原样返回输出，确保所有指纹都由同一套规则生成。 */
function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** 找到当前仓库根目录，使脚本从子目录运行时仍能定位凭证。 */
export function findRepositoryRoot(cwd = process.cwd()) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd }).trim()
}

/** 计算 HEAD 与已暂存差异的指纹，唯一标识这一次真正准备存档的内容。 */
export function createSnapshot(cwd = process.cwd()) {
  const root = findRepositoryRoot(cwd)
  const headCommit = runGit(['rev-parse', 'HEAD'], { cwd: root }).trim()
  const stagedDiff = runGit(
    ['diff', '--cached', '--binary', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'],
    { cwd: root, encoding: 'buffer' }
  )
  const stagedPaths = runGit(['diff', '--cached', '--name-only', '-z'], { cwd: root })
    .split('\0')
    .filter(Boolean)
  return {
    root,
    headCommit,
    stagedDiffHash: createHash('sha256').update(stagedDiff).digest('hex'),
    stagedDiffBytes: stagedDiff.length,
    stagedPaths
  }
}

/** 返回不会上传 GitHub 的本地临时凭证目录。 */
function receiptDirectory(root) {
  return join(root, '.codex', 'check-results')
}

/** 删除上一轮的两个门禁凭证，防止旧结果干扰新检查。 */
export function clearReceipts(cwd = process.cwd()) {
  const { root } = createSnapshot(cwd)
  for (const file of Object.values(CHECKERS)) {
    rmSync(join(receiptDirectory(root), file), { force: true })
  }
}

/**
 * 把 Git 暂存区导出到隔离目录。检查器只读取这里，避免部分暂存时测到未提交版本。
 * 目录位于项目内部，因此 Node 仍能向上找到项目的 node_modules，不必重复安装依赖。
 */
export function prepareStagedWorkspace(cwd = process.cwd()) {
  const snapshot = createSnapshot(cwd)
  if (snapshot.stagedDiffBytes === 0) throw new Error('当前没有已暂存的代码，不能准备检查快照。')
  const target = join(snapshot.root, '.codex', 'gate-worktree')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const prefix = `${target.replaceAll('\\', '/')}/`
  runGit(['checkout-index', '--all', '--force', `--prefix=${prefix}`], { cwd: snapshot.root })
  return { ...snapshot, stagedWorkspace: target }
}

/** 清理隔离快照；固定目录不会包含用户文件，也不会删除仓库其他位置。 */
export function cleanupStagedWorkspace(cwd = process.cwd()) {
  const root = findRepositoryRoot(cwd)
  rmSync(join(root, '.codex', 'gate-worktree'), { recursive: true, force: true })
}

/**
 * 完成或取消一轮门禁后删除快照和凭证。
 * 这里只清理可再生成的临时文件，不改变暂存区、工作目录或 Git 历史。
 */
export function finishGateRun(cwd = process.cwd()) {
  cleanupStagedWorkspace(cwd)
  clearReceipts(cwd)
}

/** 检查代码未变化后，写入某个检查器的机器可验证结果。 */
export function writeReceipt({ checker, verdict, expectedHead, expectedHash, commands = [], summary = {}, checkedAt = new Date().toISOString(), cwd = process.cwd() }) {
  if (!(checker in CHECKERS)) throw new Error(`未知检查器：${checker}`)
  if (!['passed', 'failed'].includes(verdict)) throw new Error(`未知检查结论：${verdict}`)
  const current = createSnapshot(cwd)
  if (current.headCommit !== expectedHead || current.stagedDiffHash !== expectedHash) {
    throw new Error('检查期间待提交代码发生了变化，本次检查结果已经作废。')
  }
  if (current.stagedDiffBytes === 0) throw new Error('当前没有已暂存的代码，不能生成提交凭证。')

  const directory = receiptDirectory(current.root)
  mkdirSync(directory, { recursive: true })
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    checker,
    verdict,
    headCommit: current.headCommit,
    stagedDiffHash: current.stagedDiffHash,
    checkedAt,
    commands,
    summary
  }
  writeFileSync(join(directory, CHECKERS[checker]), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receipt
}

/** 核对一张凭证的格式、结论、有效期和代码身份，并返回全部错误。 */
function validateReceipt(receipt, expectedChecker, snapshot, now) {
  const errors = []
  if (!receipt || typeof receipt !== 'object') return ['内容不是有效对象']
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push('凭证版本不受支持')
  if (receipt.checker !== expectedChecker) errors.push('检查器名称不匹配')
  if (receipt.verdict !== 'passed') errors.push('检查结论不是通过')
  if (receipt.headCommit !== snapshot.headCommit) errors.push('凭证不属于当前 Git 基线')
  if (receipt.stagedDiffHash !== snapshot.stagedDiffHash) errors.push('检查后待提交内容已经改变')
  const checkedTime = Date.parse(receipt.checkedAt)
  if (!Number.isFinite(checkedTime)) errors.push('检查时间格式无效')
  else if (checkedTime > now + 5 * 60 * 1000) errors.push('检查时间异常地晚于当前时间')
  else if (now - checkedTime > RECEIPT_MAX_AGE_MS) errors.push('检查结果已超过 60 分钟')
  if (!Array.isArray(receipt.commands)) errors.push('执行命令记录格式无效')
  if (!receipt.summary || typeof receipt.summary !== 'object' || Array.isArray(receipt.summary)) errors.push('检查摘要格式无效')
  if (expectedChecker === 'unit-test') {
    if (!receipt.commands?.includes('npm.cmd run typecheck')) errors.push('缺少类型检查执行记录')
    if (!receipt.commands?.includes('npm.cmd test')) errors.push('缺少完整测试执行记录')
    if (receipt.summary?.typecheckPassed !== true || receipt.summary?.testsPassed !== true) errors.push('测试成功状态不完整')
    if (!Number.isInteger(receipt.summary?.testsPassedCount) || receipt.summary.testsPassedCount < 0) errors.push('测试通过数量无效')
    const gateFilesChanged = snapshot.stagedPaths.some((path) =>
      path.startsWith('.githooks/') ||
      path.startsWith('scripts/git-gate') ||
      path.startsWith('.codex/agents/') ||
      path.startsWith('.agents/skills/git-save/')
    )
    if (gateFilesChanged && !receipt.commands?.includes('npm.cmd run test:git-gate')) errors.push('门禁文件有改动，但缺少门禁专项测试记录')
  }
  if (expectedChecker === 'quality') {
    for (const required of ['security-audit', 'comments-check', 'quality-review']) {
      if (!receipt.commands?.includes(required)) errors.push(`缺少质量检查记录：${required}`)
    }
    if (receipt.summary?.seriousCount !== 0) errors.push('质量报告仍包含严重问题')
    if (receipt.summary?.newHighCount !== 0) errors.push('本次改动仍包含新增高风险')
  }
  return errors
}

/** 校验两张凭证；Hook 只在没有任何错误时允许 Git 提交。 */
export function verifyReceipts(cwd = process.cwd(), now = Date.now()) {
  const snapshot = createSnapshot(cwd)
  const errors = []
  if (snapshot.stagedDiffBytes === 0) errors.push('当前没有已暂存的代码。')
  for (const [checker, filename] of Object.entries(CHECKERS)) {
    const path = join(receiptDirectory(snapshot.root), filename)
    let receipt
    try {
      receipt = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push(`${checker}: ${error?.code === 'ENOENT' ? '凭证不存在' : '凭证损坏或不是有效 JSON'}`)
      continue
    }
    for (const error of validateReceipt(receipt, checker, snapshot, now)) errors.push(`${checker}: ${error}`)
  }
  return { ok: errors.length === 0, errors, snapshot }
}

/** 把命令行的 --key value 参数整理成对象，供 agent 稳定调用。 */
function parseArguments(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) parsed[key] = true
    else { parsed[key] = next; index += 1 }
  }
  return parsed
}

function parseJsonArgument(value, fallback, label) {
  if (value === undefined) return fallback
  try { return JSON.parse(value) } catch { throw new Error(`${label} 不是有效 JSON。`) }
}

/** 提供快照、凭证写入和验证等固定命令给 agent 与 Hook。 */
export function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const args = parseArguments(rest)
  if (command === 'snapshot') {
    process.stdout.write(`${JSON.stringify(createSnapshot())}\n`)
    return 0
  }
  if (command === 'clear') {
    clearReceipts()
    process.stdout.write('已清除旧的 Git 检查凭证。\n')
    return 0
  }
  if (command === 'prepare') {
    process.stdout.write(`${JSON.stringify(prepareStagedWorkspace())}\n`)
    return 0
  }
  if (command === 'cleanup') {
    cleanupStagedWorkspace()
    process.stdout.write('已清理 Git 检查快照。\n')
    return 0
  }
  if (command === 'finish') {
    finishGateRun()
    process.stdout.write('已清理 Git 检查快照和凭证，暂存内容保持不变。\n')
    return 0
  }
  if (command === 'write') {
    const receipt = writeReceipt({
      checker: args.checker,
      verdict: args.verdict,
      expectedHead: args['expected-head'],
      expectedHash: args['expected-hash'],
      commands: parseJsonArgument(args['commands-json'], [], 'commands-json'),
      summary: parseJsonArgument(args['summary-json'], {}, 'summary-json')
    })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    return 0
  }
  if (command === 'verify') {
    const result = verifyReceipts()
    if (result.ok) {
      process.stdout.write('Git 提交门禁通过：单元测试和质量检查凭证均有效。\n')
      return 0
    }
    process.stderr.write('Git 提交已被保护机制拦截：\n')
    for (const error of result.errors) process.stderr.write(`- ${error}\n`)
    process.stderr.write('请重新调用 gitcommit-agent 完成检查，不要使用 --no-verify 绕过。\n')
    return 1
  }
  process.stderr.write('用法：node scripts/git-gate.mjs <snapshot|prepare|cleanup|finish|clear|write|verify>\n')
  return 2
}

const invokedPath = process.argv[1]?.replaceAll('\\', '/')
if (invokedPath && import.meta.url === new URL(`file:///${invokedPath}`).href) {
  try { process.exitCode = runCli() }
  catch (error) { process.stderr.write(`Git 门禁工具执行失败：${error.message}\n`); process.exitCode = 1 }
}
