/** Host Angular dev builds, standalone Vite dev, and active linked dev packages can open the preview. */
export function cppBlocklyPreviewEnabled(search: string, viteDev: boolean, linkedDev: boolean): boolean {
  return viteDev || linkedDev || new URLSearchParams(search).get('blocklyPreviewDev') === 'true'
}
