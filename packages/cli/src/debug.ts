/** With CAPYBARA_DEBUG set, prints what Capybara otherwise gets past quietly, such as why an app does not show up. */
export function debug(message: string, error?: unknown): void {
  if (!process.env.CAPYBARA_DEBUG) return;
  const reason = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`[capybara] ${message}${reason}`);
}
