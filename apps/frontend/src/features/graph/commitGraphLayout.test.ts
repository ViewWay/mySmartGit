import { describe, expect, it } from 'vitest'
import { buildCommitGraphLayout, type GraphCommit } from './commitGraphLayout'

const WIDTH = 220

function node(hash: string, parents: string[], status?: string): GraphCommit {
  return { id: hash.slice(0, 7), fullHash: hash, parents, status }
}

// 与后端 `git log --all --date-order` 一致的前提：父提交一定排在子提交之后。
// m6 merge 两条轨道；b1/b2 是 feature 侧；m1 是根提交。
const FULL: GraphCommit[] = [
  node('m6aaaaaaa', ['m5bbbbbbb', 'b2ccccccc']),
  node('b2ccccccc', ['b1ddddddd']),
  node('m5bbbbbbb', ['m4eeeeeee']),
  node('b1ddddddd', ['m3fffffff']),
  node('m4eeeeeee', ['m3fffffff']),
  node('m3fffffff', ['m2ggggggg']),
  node('m2ggggggg', ['m1hhhhhhh']),
  node('m1hhhhhhh', []),
]

function rowsOf(commits: GraphCommit[]) {
  return buildCommitGraphLayout(commits, WIDTH).rows
}

describe('commit graph layout under cursor pagination (W3-3)', () => {
  it('keeps lane and color of already-rendered rows when later pages append', () => {
    // 分页模型：前端累计数组永远是全量 log 序列的前缀；先渲染前 4 行，
    // 再追加后 4 行。已发行行的 lane/颜色必须与整表重算完全一致。
    const firstPage = rowsOf(FULL.slice(0, 4))
    const accumulated = rowsOf(FULL)
    for (let index = 0; index < 4; index += 1) {
      expect(accumulated[index].lane, `row ${index} lane drifted after appending a page`).toBe(firstPage[index].lane)
      expect(accumulated[index].color, `row ${index} color drifted after appending a page`).toBe(firstPage[index].color)
    }
  })

  it('reconnects a merge edge to a parent that only arrives on a later page', () => {
    // m5 的父 m4 在第二页；第一页内 m5 行是“路径终点”，第二页到达后
    // 整表重算必须补出 m4 的轨道，且 m4 作为第一父延续 m5 的 lane。
    const firstPage = rowsOf(FULL.slice(0, 3))
    expect(firstPage[2].parentCount).toBe(0)
    const accumulated = rowsOf(FULL)
    expect(accumulated[2].parentCount).toBe(1)
    const m5Lane = accumulated[2].lane
    const m4Index = FULL.findIndex((commit) => commit.fullHash === 'm4eeeeeee')
    expect(accumulated[m4Index].lane, 'first-parent lineage must continue the child rail across pages').toBe(m5Lane)
  })

  it('lays out the whole accumulated history identically no matter where pages were cut', () => {
    // 任意页边界（1/5/7 处切分）重放：整表 lane 序列一致（游标分页不改变布局语义）。
    const oneShot = rowsOf(FULL)
    for (const cut of [1, 5, 7]) {
      const replayed = [...FULL.slice(0, cut), ...FULL.slice(cut)]
      const rows = rowsOf(replayed)
      expect(rows.map((row) => row.lane)).toEqual(oneShot.map((row) => row.lane))
      expect(rows.map((row) => row.color)).toEqual(oneShot.map((row) => row.color))
    }
  })

  it('keeps stash commits on their own rail without reserving the pruned index parent', () => {
    // stash 提交只按第一父连线（与后端流式剪枝一致：index 父不进图谱）。
    const commits: GraphCommit[] = [
      node('s1aaaaaaa', ['m1bbbbbbb', 'i1ccccccc'], 'stash'),
      node('m1bbbbbbb', ['m2ddddddd']),
      node('m2ddddddd', []),
    ]
    const rows = rowsOf(commits)
    expect(rows[0].segments.filter((segment) => segment.kind === 'stash').length).toBeGreaterThan(0)
    const layout = buildCommitGraphLayout(commits, WIDTH)
    expect(layout.rows[1].lane, 'stash first parent continues the stash rail').toBe(rows[0].lane)
  })
})
