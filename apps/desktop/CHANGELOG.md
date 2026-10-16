# @capybara-devtools/desktop

## 0.2.0

### Minor Changes

- 4e64ddc: Say when a newer Capybara is out. `npx capybara-devtools` prints a line when npm has a newer version, and the UI shows a notice with the install command when a connected app uses an older SDK. The desktop app asks before updating: the Windows installer and the AppImage download the update and restart into it, other builds open the release page. `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK=1` turns the checks off.
