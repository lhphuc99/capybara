---
"@capybara-devtools/protocol": patch
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

The Logs tab shows the other console methods the way browsers print them: entries logged inside `console.group()` are indented under the group's line, which opens and closes on a click (`console.groupCollapsed()` starts closed), `console.table()` shows a table, `console.trace()` the stack it was called from, and `console.count()`, `console.time()`/`timeLog()`/`timeEnd()` and a failed `console.assert()` the line the browser prints. This works through Metro too, and `capybara mcp` indents grouped entries. In React Native apps with the SDK, an unhandled promise rejection is now marked as one, as it already was through Metro.
