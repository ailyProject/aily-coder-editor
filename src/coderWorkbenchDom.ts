/** Workbench 渲染根（含 Shadow DOM 内的 workbench 容器）；供主线程 DOM 操作使用 */
let workbenchQueryRoot: ParentNode | null = null

export function setCoderWorkbenchQueryRoot(root: ParentNode): void {
  workbenchQueryRoot = root
}

export function getCoderWorkbenchQueryRoot(): ParentNode {
  return workbenchQueryRoot ?? document
}
