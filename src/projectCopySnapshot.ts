export interface CopyTextModel {
  path: string
  version: number
  encoding: string | undefined
  text: string
}

/** Snapshot preparation never saves or clears source models. Check after every asynchronous encode. */
export async function captureProjectCopy(
  read: () => CopyTextModel[],
  encode: (model: CopyTextModel) => Promise<Uint8Array>,
) {
  const models = read()
  const identity = (values: CopyTextModel[]) => JSON.stringify(values)
  const baseline = identity(models)
  const assertCurrent = () => {
    if (identity(read()) !== baseline) throw new Error('Code editors changed during Save As; please try again.')
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (const model of models) {
    const bytes = await encode(model)
    assertCurrent()
    files.push({ path: model.path, bytes })
  }
  assertCurrent()
  return { files, assertCurrent }
}
