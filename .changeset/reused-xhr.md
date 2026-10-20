---
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
---

A reused `XMLHttpRequest` is recorded right. When an app opened the same XHR again for the next request, the earlier request's listeners stayed on it, so the earlier request also got the later one's response. Each request now ends with its own result: one cut off by opening the XHR again while it was on its way shows as aborted, and one opened again from its `onload` is recorded before the `loadend` the browser still sends for it.
