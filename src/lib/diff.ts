/**
 * Minimal line diff (LCS based) used for raw-config history views.
 * Falls back to a naive set difference when inputs are too large for DP.
 */
export function diffLines(
  a: string,
  b: string,
  maxLines = 800,
): { added: string[]; removed: string[] } {
  const oldLines = a.split("\n").slice(0, maxLines)
  const newLines = b.split("\n").slice(0, maxLines)

  // Guard: LCS DP is O(n*m); fall back for huge configs.
  if (oldLines.length * newLines.length > 250_000) {
    const oldSet = new Set(oldLines)
    const newSet = new Set(newLines)
    return {
      removed: oldLines.filter((l) => !newSet.has(l)),
      added: newLines.filter((l) => !oldSet.has(l)),
    }
  }

  const m = oldLines.length
  const n = newLines.length
  const dp: Uint32Array[] = Array.from(
    { length: m + 1 },
    () => new Uint32Array(n + 1),
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const added: string[] = []
  const removed: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(oldLines[i++])
    } else {
      added.push(newLines[j++])
    }
  }
  while (i < m) removed.push(oldLines[i++])
  while (j < n) added.push(newLines[j++])
  return { added, removed }
}
