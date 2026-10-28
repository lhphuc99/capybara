# Dart and Flutter

A [pub workspace](https://dart.dev/tools/pub/workspaces) beside the npm one: the Capybara package for Flutter,
[`packages/capybara_devtools`](packages/capybara_devtools), its packages for
[Riverpod](packages/capybara_devtools_riverpod) and [Bloc](packages/capybara_devtools_bloc), and an example app. Nothing here is part of the npm build,
tests or releases.

## Setup

The Flutter version is pinned in `.fvmrc`, which [fvm](https://fvm.app) and CI both read:

```bash
brew tap leoafarias/fvm && brew install fvm
fvm install            # in this folder
fvm flutter pub get
```

Without fvm, any Flutter of that version works the same way.

## The example app

`example/` has a button for each thing Capybara should show: logs, Flutter errors, HTTP through dio, `http`,
`HttpClient` and `cupertino_http`, a WebSocket, and SharedPreferences, secure storage and Hive.

```bash
node example/tool/mock_server.mjs        # the API the buttons call, on 127.0.0.1:4100
cd example && fvm flutter run            # -d macos, an iOS simulator or an Android emulator
```

On an Android phone on USB, run `adb reverse tcp:4100 tcp:4100` and add `--dart-define=MOCK_HOST=127.0.0.1`.

So run, Capybara reads the app through the Dart VM service. With `--dart-define=CAPYBARA_SDK=true` the app runs the
package instead, and Capybara leaves the VM service alone. `--dart-define=CAPYBARA_PORT=47901` points the package at a
Capybara started with `--port 47901`.

Its buttons can also be pressed without touching the app, through the Dart VM service address that
`flutter run` prints ("A Dart VM Service on … is available at: …"):

```bash
node example/tool/drive.mjs http://127.0.0.1:50300/abc=/ --list
node example/tool/drive.mjs http://127.0.0.1:50300/abc=/ log.print http.dio.get10k storage.prefs
```

The mock server prints one line per request, with the sha256 of each body, to check what Capybara shows against
what went over the wire.

## Checks

```bash
fvm flutter analyze --fatal-infos
dart format --set-exit-if-changed .
cd example && fvm flutter test
cd packages/capybara_devtools && fvm flutter test
fvm flutter test --platform chrome test/web_test.dart   # it has to build for the web
cd ../capybara_devtools_riverpod && fvm flutter test
cd ../capybara_devtools_bloc && fvm flutter test
```

The package's contract tests run it against Capybara's server built from this repository, so `npm run build` at the
root first; without a build, or without Node, they are skipped.
