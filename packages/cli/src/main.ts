/**
 * CLI entry: `diorama [dir] [--port n] [--host ip]`.
 *
 * M0 is one foreground server for one directory (plan.md): no gateway, no
 * background process, no socket.
 */
import { runGateway } from './gateway-command.ts'
import { main as serveMain } from './run.ts'

/**
 * Sub-command dispatch: `diorama gateway run` is the foreground daemon; every
 * other invocation is the serve path (`diorama [dir] …`, contract.md §7.6).
 */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const [first, second] = argv
  if (first === 'gateway' && second === 'run') {
    try {
      await runGateway()
    } catch (failure) {
      process.stderr.write(`diorama: gateway cannot start: ${(failure as Error).message}\n`)
      return 1
    }
    // Keep the process alive until a `stop` closes the gateway.
    return new Promise<number>(() => {})
  }
  return serveMain(argv)
}
