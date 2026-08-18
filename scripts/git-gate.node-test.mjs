import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createSnapshot, finishGateRun, prepareStagedWorkspace, writeReceipt } from './git-gate.mjs'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'git-gate.mjs')

/** 创建隔离的临时 Git 仓库，避免门禁测试接触项目历史或用户账目。 */
function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'kelu-git-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'gate@example.invalid'], { cwd: root })
  writeFileSync(join(root, 'ledger.txt'), 'baseline\n', 'utf8')
  execFileSync('git', ['add', 'ledger.txt'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: root })
  writeFileSync(join(root, 'ledger.txt'), 'baseline\nchange\n', 'utf8')
  execFileSync('git', ['add', 'ledger.txt'], { cwd: root })
  return root
}

function runVerify(root) {
  return spawnSync(process.execPath, [scriptPath, 'verify'], { cwd: root, encoding: 'utf8' })
}

function writePassingReceipts(root, checkedAt) {
  const snapshot = createSnapshot(root)
  for (const checker of ['unit-test', 'quality']) {
    writeReceipt({
      checker,
      verdict: 'passed',
      expectedHead: snapshot.headCommit,
      expectedHash: snapshot.stagedDiffHash,
      checkedAt,
      commands: checker === 'unit-test' ? ['npm.cmd run typecheck', 'npm.cmd test'] : ['security-audit', 'comments-check', 'quality-review'],
      summary: checker === 'unit-test'
        ? { conclusion: 'passed', typecheckPassed: true, testsPassed: true, testsPassedCount: 19 }
        : { conclusion: 'passed', seriousCount: 0, newHighCount: 0 },
      cwd: root
    })
  }
}

test('缺少检查凭证时拒绝提交', () => {
  const root = createRepository()
  try {
    const result = runVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unit-test: 凭证不存在/)
    assert.match(result.stderr, /quality: 凭证不存在/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('两项检查都通过且代码未变化时允许提交', () => {
  const root = createRepository()
  try {
    writePassingReceipts(root)
    const result = runVerify(root)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /门禁通过/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('只有一张有效凭证时仍然拒绝提交', () => {
  const root = createRepository()
  try {
    const snapshot = createSnapshot(root)
    writeReceipt({ checker: 'unit-test', verdict: 'passed', expectedHead: snapshot.headCommit, expectedHash: snapshot.stagedDiffHash, commands: ['npm.cmd run typecheck', 'npm.cmd test'], summary: { typecheckPassed: true, testsPassed: true, testsPassedCount: 19 }, cwd: root })
    const result = runVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /quality: 凭证不存在/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('隔离快照只包含暂存版本，不会混入同一文件的未暂存修改', () => {
  const root = createRepository()
  try {
    writeFileSync(join(root, 'ledger.txt'), 'working tree only\n', 'utf8')
    const prepared = prepareStagedWorkspace(root)
    const exported = readFileSync(join(prepared.stagedWorkspace, 'ledger.txt'), 'utf8').replaceAll('\r\n', '\n')
    assert.equal(exported, 'baseline\nchange\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('门禁相关文件变化时强制要求专项测试记录', () => {
  const root = createRepository()
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'git-gate.mjs'), 'gate change\n', 'utf8')
    execFileSync('git', ['add', 'scripts/git-gate.mjs'], { cwd: root })
    writePassingReceipts(root)
    let result = runVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /缺少门禁专项测试记录/)

    const snapshot = createSnapshot(root)
    writeReceipt({ checker: 'unit-test', verdict: 'passed', expectedHead: snapshot.headCommit, expectedHash: snapshot.stagedDiffHash, commands: ['npm.cmd run typecheck', 'npm.cmd test', 'npm.cmd run test:git-gate'], summary: { typecheckPassed: true, testsPassed: true, testsPassedCount: 19 }, cwd: root })
    result = runVerify(root)
    assert.equal(result.status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('结束清理会删除快照和凭证，但保持暂存内容不变', () => {
  const root = createRepository()
  try {
    const before = prepareStagedWorkspace(root)
    writePassingReceipts(root)
    assert.equal(existsSync(before.stagedWorkspace), true)
    assert.equal(existsSync(join(root, '.codex', 'check-results', 'unit-test.json')), true)

    finishGateRun(root)
    const after = createSnapshot(root)
    assert.equal(existsSync(before.stagedWorkspace), false)
    assert.equal(existsSync(join(root, '.codex', 'check-results', 'unit-test.json')), false)
    assert.equal(existsSync(join(root, '.codex', 'check-results', 'quality.json')), false)
    assert.equal(after.stagedDiffHash, before.stagedDiffHash)
    assert.ok(after.stagedDiffBytes > 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('检查后暂存内容变化时拒绝旧凭证', () => {
  const root = createRepository()
  try {
    writePassingReceipts(root)
    writeFileSync(join(root, 'ledger.txt'), 'baseline\nchanged again\n', 'utf8')
    execFileSync('git', ['add', 'ledger.txt'], { cwd: root })
    const result = runVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /检查后待提交内容已经改变/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('超过 60 分钟的凭证拒绝提交', () => {
  const root = createRepository()
  try {
    writePassingReceipts(root, new Date(Date.now() - 61 * 60 * 1000).toISOString())
    const result = runVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /已超过 60 分钟/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('失败结论、损坏凭证和 HEAD 改变都会被识别', () => {
  const root = createRepository()
  try {
    writePassingReceipts(root)
    const snapshot = createSnapshot(root)
    writeReceipt({ checker: 'unit-test', verdict: 'failed', expectedHead: snapshot.headCommit, expectedHash: snapshot.stagedDiffHash, commands: ['npm.cmd run typecheck', 'npm.cmd test'], summary: { conclusion: 'failed', typecheckPassed: false, testsPassed: false, testsPassedCount: 0 }, cwd: root })
    let result = runVerify(root)
    assert.match(result.stderr, /检查结论不是通过/)
    writeFileSync(join(root, '.codex', 'check-results', 'unit-test.json'), '{broken', 'utf8')
    result = runVerify(root)
    assert.match(result.stderr, /凭证损坏/)
    writePassingReceipts(root)
    execFileSync('git', ['commit', '-q', '-m', 'move head'], { cwd: root })
    writeFileSync(join(root, 'ledger.txt'), 'new staged change\n', 'utf8')
    execFileSync('git', ['add', 'ledger.txt'], { cwd: root })
    result = runVerify(root)
    assert.match(result.stderr, /不属于当前 Git 基线/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('真实 pre-commit Hook 会先拒绝再放行临时仓库提交', () => {
  const root = createRepository()
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, '.githooks'), { recursive: true })
    copyFileSync(scriptPath, join(root, 'scripts', 'git-gate.mjs'))
    const hookSource = join(dirname(scriptPath), '..', '.githooks', 'pre-commit')
    copyFileSync(hookSource, join(root, '.githooks', 'pre-commit'))
    copyFileSync(join(dirname(hookSource), 'post-commit'), join(root, '.githooks', 'post-commit'))
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })

    let result = spawnSync('git', ['commit', '-m', 'should be blocked'], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /凭证不存在/)

    const prepared = prepareStagedWorkspace(root)
    writePassingReceipts(root)
    result = spawnSync('git', ['commit', '-m', 'verified commit'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /门禁通过/)
    assert.equal(existsSync(prepared.stagedWorkspace), false)
    assert.equal(existsSync(join(root, '.codex', 'check-results', 'unit-test.json')), false)
    assert.equal(existsSync(join(root, '.codex', 'check-results', 'quality.json')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
