---
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

Opening an entry in the Logs tab no longer scrolls it out of view. While the list followed the newest rows, opening an entry above them pushed its first line off the top; now opening it stops following (**Jump to latest** comes back), and the list scrolls only as far as the entry needs, never past its first line. The newest entry still opens at the bottom of a list that keeps following.
