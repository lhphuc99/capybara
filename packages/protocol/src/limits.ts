// Limits the SDK, the Metro bridge and the server must agree on, so the UI shows the same with or without the SDK.

/** Request and response bodies are cut after this many characters (bytes for binary ones); a state read is kept to it too. */
export const MAX_BODY_SIZE = 128 * 1024;
/** WebSocket messages are cut after this many characters. */
export const MAX_SOCKET_MESSAGE_SIZE = 16 * 1024;
/** Strings inside logged values are cut after this many characters. */
export const MAX_STRING_LENGTH = 10_000;
/** A storage listing shows this many keys, sorted. */
export const MAX_STORAGE_KEYS = 1_000;
/** Characters of each value in a storage listing, and of one value read on its own. */
export const STORAGE_PREVIEW_LENGTH = 2_000;
export const STORAGE_VALUE_LENGTH = 1_000_000;
/** How long the server waits for an app to answer a command. The UI and `capybara mcp` wait longer, so its answer comes first. */
export const COMMAND_TIMEOUT_MS = 10_000;
