import ts from 'typescript'

const CJK = /[\u3400-\u9fff]/

function lineAt(source, position) {
  const start = source.lastIndexOf('\n', position) + 1
  const end = source.indexOf('\n', position)
  return source.slice(start, end === -1 ? source.length : end)
}

export function scanSource(source, fileName) {
  const isTsx = fileName.endsWith('.tsx')
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let count = 0
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    const allowed = lineAt(source, node.getStart(file)).includes('i18n-allow')
    if (!allowed && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))) {
      if (CJK.test(node.getText(file))) count += 1
    }
    node.forEachChild(visit)
  }
  visit(file)
  return count
}
