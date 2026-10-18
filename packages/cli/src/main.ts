/**
 * CLI entry: `diorama [dir] [--port n] [--host ip]`.
 *
 * M0 is one foreground server for one directory (plan.md): no gateway, no
 * background process, no socket.
 */
export { main } from './run.ts'
