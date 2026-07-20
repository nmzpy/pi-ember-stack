export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_PROVIDER_NAME = "Cursor Subscription";
export const CURSOR_API_IDENTIFIER = "cursor-cli";
export const CURSOR_PLACEHOLDER_BASE_URL = "https://cursor.com";
export const CURSOR_AUTH_MARKER = "cursor-cli-authenticated";

export const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;
export const CURSOR_DEFAULT_MAX_TOKENS = 32_000;

export const CURSOR_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Official Cursor Agent CLI installer (macOS/Linux/WSL). */
export const CURSOR_AGENT_INSTALL_URL = "https://cursor.com/install";
/** Official Cursor Agent CLI installer (native Windows PowerShell). */
export const CURSOR_AGENT_WINDOWS_INSTALL_URL = "https://cursor.com/install?win32=true";
/** Max time for an ensure/install attempt. */
export const CURSOR_AGENT_INSTALL_TIMEOUT_MS = 3 * 60_000;
