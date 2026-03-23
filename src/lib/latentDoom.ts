interface LatentDoomOptions {
  baseDelay?: number
  jitter?: number
  doomDelay?: number
}

const DEFAULT_OPTIONS: Required<LatentDoomOptions> = {
  baseDelay: 26,
  jitter: 42,
  doomDelay: 640,
}

function tokenize(text: string): string[] {
  const tokens = text.match(/(\.\.\.|[\r\n]+|[^\s\r\n]+|\s+)/g)
  return tokens ?? [text]
}

function includesDotThenLineBreak(token: string, nextToken?: string): boolean {
  if (token.includes('.\n') || token.includes('.\r\n')) {
    return true
  }

  if (token.endsWith('.') && typeof nextToken === 'string') {
    return /^\r?\n/.test(nextToken)
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export async function streamWithLatentDoom(
  text: string,
  onToken: (token: string) => void,
  options: LatentDoomOptions = {},
): Promise<void> {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const tokens = tokenize(text)

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const nextToken = tokens[index + 1]
    const isDoomMoment = token.includes('...') || includesDotThenLineBreak(token, nextToken)
    const base = token.trim().length > 0 ? settings.baseDelay : Math.max(8, settings.baseDelay / 2)
    const randomJitter = Math.floor(Math.random() * settings.jitter)
    const totalDelay = base + randomJitter + (isDoomMoment ? settings.doomDelay : 0)

    onToken(token)
    await sleep(totalDelay)
  }
}