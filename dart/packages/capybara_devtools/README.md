# capybara_devtools

Sends a Flutter app's logs and errors to [Capybara](https://capybara.lhphuc.com), the local devtools for React
Native, Flutter and web apps. Network requests, storage and state come in later versions.

Capybara already reads apps started with `flutter run` without this package, through the Dart VM service. The
package adds what that cannot see:

- uncaught errors of futures and zones, which never reach the VM service;
- values logged with `Capybara.log`, shown as trees you can open;
- builds without a debugger, such as a build for testers made with `--dart-define=CAPYBARA_ENABLED=true`;
- phones on Wi‑Fi, with `--dart-define=CAPYBARA_HOST=<your computer's address>`.

## Install

```bash
flutter pub add capybara_devtools
```

## Use

```dart
import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter/widgets.dart';

void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const MyApp());
  });
}
```

Start Capybara on your computer (`npx capybara-devtools`, or the desktop app), then run the app as usual.

`Capybara.run` runs the app in a zone, so what it prints with `print` or `debugPrint`, and the errors nothing catches,
go to Capybara as well as to the console. Call `WidgetsFlutterBinding.ensureInitialized()` inside it, not before:
Flutter warns when the binding and `runApp` are set up in different zones. Flutter's own errors, the ones it prints
with a red screen or an "EXCEPTION CAUGHT BY" banner, are sent too, and still reach the handler you or a crash
reporter set.

When a zone does not suit the app, `Capybara.init()` before `runApp` sends `debugPrint` output and errors, but not
`print`.

### Logs with values

```dart
Capybara.log('Cart saved', level: 'info', data: {'items': cart.items, 'total': cart.total});
```

Maps, lists, sets, dates, errors with their stack, and objects with a `toJson()` method or Equatable's `props` arrive
as trees; anything else as its `toString()`.

`developer.log` writes only to the Dart VM service, which Capybara stops reading once the app has this package. To
see a logger's records, send them on with `Capybara.log`. With `package:logging`:

```dart
Logger.root.onRecord.listen((record) {
  Capybara.log(
    '[${record.loggerName}] ${record.message}',
    level: record.level >= Level.SEVERE
        ? 'error'
        : record.level >= Level.WARNING
            ? 'warn'
            : 'info',
    data: record.error,
  );
});
```

## Finding Capybara

| The app runs on | What to do |
| --- | --- |
| iOS simulator, Windows, Linux | Nothing. |
| macOS | Add `com.apple.security.network.client` to `macos/Runner/DebugProfile.entitlements`: the sandbox blocks connections without it, and Flutter's template leaves it out. The package says so in the console when it is missing. |
| Android emulator, or an Android phone on USB | Nothing: the package also tries 10.0.2.2, and Capybara runs `adb reverse` for devices on USB. |
| A phone on Wi‑Fi | Build with `--dart-define=CAPYBARA_HOST=192.168.1.20`, the address Capybara prints under "Network". |

Capybara on another port than 7357: `--dart-define=CAPYBARA_PORT=…`, or `CapybaraOptions(port: …)`.

## Release builds

The package does nothing in release builds, and is left out of them: it runs only where `kDebugMode`, a constant,
is true. To use it in a profile or release build for testers, build with `--dart-define=CAPYBARA_ENABLED=true`.
Such a build sends what the app logs to whoever runs Capybara where it looks, so keep it away from the store.

## Platforms

Android, iOS, macOS, Windows and Linux. On the web the package builds and does nothing yet.
