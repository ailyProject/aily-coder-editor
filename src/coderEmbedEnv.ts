/**
 * setup.common 在解析 URL 后写入；扩展运行在 Worker 中无 window，依赖此标志判断是否向 Electron 宿主发 OS 级 Reveal。
 * 与 `useEmbedHostLocalFolder` 语义一致，避免 setup ↔ 扩展 循环依赖时重复计算。
 */
export let coderUseEmbedHostNativeFsBridge = false

/** 仅 setup.common 应在启动时调用一次 */
export function setCoderUseEmbedHostNativeFsBridge(v: boolean): void {
  coderUseEmbedHostNativeFsBridge = v
}
