---
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
---

Events from a web app whose tab is in the background reach Capybara right away. The SDK sent them on a 50 ms timer, which browsers run at most once a second in a hidden tab (Chrome once a minute after a while), so with the app in one tab and Capybara in another, logs, requests and storage changes came in bursts. While the page is hidden, the SDK now sends at the end of the task that recorded them.
