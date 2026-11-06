import { describe, expect, it } from 'vitest'
import type { RepositorySubmodule, SubmoduleOperationReport } from '../../repository'
import {
  canSubmitSubmoduleDraft,
  credentialNotice,
  deriveSubmodulePath,
  findPathConflict,
  hasEmbeddedCredentials,
  needsSubmoduleConfirmation,
  parseCloneDepth,
  submoduleConfirmationText,
  validateSubmoduleBranch,
  validateSubmoduleDraft,
  validateSubmoduleName,
  validateSubmodulePath,
  validateSubmoduleUrl,
} from './submoduleAddForm'

const submodule = (path: string, overrides: Partial<RepositorySubmodule> = {}): RepositorySubmodule => ({
  path,
  hash: '0123456789012345678901234567890123456789',
  status: 'ok',
  ...overrides,
})

const report = (overrides: Partial<SubmoduleOperationReport> = {}): SubmoduleOperationReport => ({
  action: 'submodule-add',
  executed: true,
  requiresConfirmation: false,
  summary: '已添加 Submodule vendor/lib（https://host.example/team/lib.git）',
  warnings: [],
  affected: ['vendor/lib', 'vendor/lib'],
  submodules: [],
  ...overrides,
})

describe('submodule url 校验', () => {
  it('放行常见协议与本地路径', () => {
    for (const url of [
      'https://host.example/team/repo.git',
      'http://host.example/team/repo.git',
      'ssh://git@host.example/team/repo.git',
      'git://host.example/repo.git',
      'file:///srv/repo.git',
      'git@host.example:team/repo.git',
      'deploy@buildbox:/srv/repo.git',
      '/srv/local/repo.git',
      'https://user:token@host.example/team/repo.git',
    ]) {
      expect(validateSubmoduleUrl(url), url).toBeNull()
    }
  })

  it('拒绝可执行传输、选项注入与畸形地址', () => {
    const rejected = [
      '',
      '   ',
      'ext::sh -c touch% /tmp/pwned',
      'fd::11/foo',
      'pass::arg',
      '--upload-pack=evil',
      'https://',
      'https://host.example/a b',
      'not-a-url-at-all',
      'user:pw@host.example:team/repo.git',
      'ssh://',
      'host.example',
    ]
    for (const url of rejected) {
      expect(validateSubmoduleUrl(url), url).not.toBeNull()
    }
  })

  it('只把真正的内嵌凭据当风险，SSH 裸用户名不算', () => {
    expect(hasEmbeddedCredentials('https://user:token@host.example/a.git')).toBe(true)
    expect(hasEmbeddedCredentials('https://token@host.example/a.git')).toBe(true)
    expect(hasEmbeddedCredentials('git@host.example:team/repo.git')).toBe(false)
    expect(hasEmbeddedCredentials('https://host.example/team/repo.git')).toBe(false)
    expect(credentialNotice('https://user:token@host.example/a.git')).toContain('明文写进 .gitmodules')
    expect(credentialNotice('http://host.example/a.git')).toContain('https')
    expect(credentialNotice('git@host.example:team/repo.git')).toBeNull()
  })
})

describe('submodule 路径与名称校验', () => {
  it('拒绝越界、绝对路径与保留目标', () => {
    for (const path of ['/etc/passwd', '../escape', 'vendor/../../x', '-b', '.git/hooks', 'vendor/.git/m', '.gitmodules', 'vendor//m', 'vendor/m/', 'a\x01b']) {
      expect(validateSubmodulePath(path), path).not.toBeNull()
    }
  })

  it('放行正常相对路径，空值交给后端推断', () => {
    for (const path of ['vendor/lib', 'libs/sub-module.2', '中文/目录', '']) {
      expect(validateSubmodulePath(path), path).toBeNull()
    }
  })

  it('段名拒绝 config 特殊字符与路径分隔符', () => {
    for (const name of ['-x', 'a/b', 'a b', 'a[b]', '.hidden', 'x.lock', 'a..b']) {
      expect(validateSubmoduleName(name), name).not.toBeNull()
    }
    expect(validateSubmoduleName('shared-lib')).toBeNull()
    expect(validateSubmoduleName('')).toBeNull()
  })

  it('跟踪分支只挡明显错误', () => {
    expect(validateSubmoduleBranch('feat/tracking')).toBeNull()
    expect(validateSubmoduleBranch('')).toBeNull()
    // refs/heads/x 作为分支名写法很别扭，但 Git 的 check-ref-format --branch 确实接受，
    // 前端不能替 Git 做更严的决定（否则后端放行、前端拦人）。
    expect(validateSubmoduleBranch('refs/heads/x')).toBeNull()
    for (const branch of ['-b', 'feat branch', 'a..b', 'x@{1}', '.hidden', 'trailing/']) {
      expect(validateSubmoduleBranch(branch), branch).not.toBeNull()
    }
  })

  it('路径冲突同时挡住父子层级互占', () => {
    const existing = [submodule('vendor/lib'), submodule('libs/vendor/deep')]
    expect(findPathConflict('vendor/lib', existing)?.kind).toBe('submodule')
    expect(findPathConflict('VENDOR/LIB', existing)?.kind).toBe('submodule')
    expect(findPathConflict('vendor/lib/extra', existing)?.kind).toBe('nested')
    expect(findPathConflict('libs/vendor', existing)?.kind).toBe('nested')
    expect(findPathConflict('vendor/other', existing)).toBeNull()
    expect(findPathConflict('', existing)).toBeNull()
  })
})

describe('地址推断默认目录', () => {
  it('取仓库名并去掉 .git 后缀', () => {
    expect(deriveSubmodulePath('git@host.example:team/repo.git')).toBe('repo')
    expect(deriveSubmodulePath('https://host.example/team/repo.git/')).toBe('repo')
    expect(deriveSubmodulePath('/srv/local/repo')).toBe('repo')
    expect(deriveSubmodulePath('file:///srv/repo.git')).toBe('repo')
  })

  it('没有路径段时不拿主机名当目录', () => {
    expect(deriveSubmodulePath('https://host.example')).toBe('')
    expect(deriveSubmodulePath('https://host.example/')).toBe('')
    expect(deriveSubmodulePath('')).toBe('')
  })
})

describe('表单聚合校验', () => {
  const draft = { url: 'https://host.example/team/repo.git', path: 'vendor/lib', name: '', branch: '' }

  it('干净草稿可以提交', () => {
    expect(validateSubmoduleDraft(draft, [submodule('libs/other')])).toEqual({})
    expect(canSubmitSubmoduleDraft(draft, [submodule('libs/other')])).toBe(true)
  })

  it('逐字段报告错误并且不掩盖路径冲突', () => {
    const errors = validateSubmoduleDraft(
      { url: 'ext::sh -c true', path: '../out', name: 'a b', branch: '-x' },
      [],
    )
    expect(Object.keys(errors).sort()).toEqual(['branch', 'name', 'path', 'url'])
    expect(validateSubmoduleDraft(draft, [submodule('vendor/lib')]).path).toContain('已登记')
  })

  it('留空路径时按地址推断，推断不出来就要求手动指定', () => {
    expect(validateSubmoduleDraft({ ...draft, path: '' }, [])).toEqual({})
    const errors = validateSubmoduleDraft({ ...draft, url: 'https://host.example', path: '' }, [])
    expect(errors.url).toContain('无法从地址推断')
  })
})

describe('预览确认与克隆深度', () => {
  it('只有后端明确「等待确认」时才走二次确认', () => {
    expect(needsSubmoduleConfirmation(report())).toBe(false)
    expect(needsSubmoduleConfirmation(report({ executed: false, requiresConfirmation: true }))).toBe(true)
    expect(needsSubmoduleConfirmation(report({ executed: false }))).toBe(false)
  })

  it('确认文案把摘要、警告与受影响项都摊开', () => {
    const text = submoduleConfirmationText(report({
      executed: false,
      requiresConfirmation: true,
      summary: '将收养目录里已有的仓库作为 Submodule：vendor/lib',
      warnings: ['收养不会删除目录内容'],
      affected: ['vendor/lib'],
    }))
    expect(text).toContain('收养')
    expect(text).toContain('· 收养不会删除目录内容')
    expect(text).toContain('受影响：vendor/lib')
  })

  it('浅克隆深度只接受 1..=10000 的整数', () => {
    expect(parseCloneDepth('')).toEqual({ depth: null, error: null })
    expect(parseCloneDepth('1')).toEqual({ depth: 1, error: null })
    expect(parseCloneDepth(' 12 ')).toEqual({ depth: 12, error: null })
    expect(parseCloneDepth('0').error).toContain('正整数')
    expect(parseCloneDepth('-3').error).toContain('正整数')
    expect(parseCloneDepth('1.5').error).toContain('正整数')
    expect(parseCloneDepth('abc').error).toContain('正整数')
    expect(parseCloneDepth('10001').error).toContain('上限')
  })
})
