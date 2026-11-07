import { getClassWithColor } from 'file-icons-js'

/** 文件名 → file-icons 彩色图标类名；未知类型返回 null，调用方回退通用图标。 */
export function fileIconClass(name: string): string | null {
  if (!name) return null
  return getClassWithColor(name)
}