---
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

On windows that are narrow and short, such as a phone or a small split window, the Storage and State tabs show their list of stores again. It was squeezed to nothing behind the table header, because the two rows below it took all the height. The list now keeps its height, up to 40% of the window, and the tab scrolls.
