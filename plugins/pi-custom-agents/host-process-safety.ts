/**
 * Host process safety guidance.
 *
 * Pi runs on Node and this session lives inside that process: the TUI, the
 * transcript, and the conversation with the user are the Node process. Any
 * command that kills node processes (pkill node, killall node, taskkill /IM
 * node.exe, Stop-Process -Name node) terminates the session mid-turn.
 *
 * SSOT: injected into every parent mode system prompt (index.ts
 * build_system_prompt) and every subagent system prompt (runner.ts). Never
 * duplicate this text in another plugin.
 */
export const HOST_PROCESS_SAFETY_GUIDANCE = `
Host Process Safety:

Do not use any command to kill node as that is the process we are talking through.`;
