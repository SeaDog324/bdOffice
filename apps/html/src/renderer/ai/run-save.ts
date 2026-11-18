/** A first-save hook is part of completion, so history cannot outrun the writer. */
export async function settleRunSave(
  text: string,
  lang: string,
  save: () => void | Promise<{ saved: boolean } | undefined>,
): Promise<string> {
  let receipt: { saved: boolean } | undefined
  try {
    receipt = (await save()) || undefined
  } catch {
    receipt = { saved: false }
  }
  if (!receipt) return text
  const status = lang.startsWith('zh')
    ? receipt.saved
      ? '保存结果：已保存。'
      : '保存结果：未完成，请检查编辑器状态。'
    : receipt.saved
      ? 'Save result: saved.'
      : 'Save result: not completed; check the editor status.'
  return [text, status].filter(Boolean).join('\n\n')
}
