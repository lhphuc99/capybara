# capybara_devtools

Sends a Flutter app's logs, errors, requests, WebSocket messages, storage and state to
[Capybara](https://capybara.lhphuc.com), the local devtools for React Native, Flutter and web apps.

Capybara already reads apps started with `flutter run` without this package, through the Dart VM service. The
package adds what that cannot see:

- uncaught errors of futures and zones, which never reach the VM service;
- WebSocket messages, and requests from the app's first moment on, also on a phone that `flutter run` did not start;
- the app's storage, which can be edited from Capybara, and its state, with what each change did;
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

### Requests

Requests made through dart:io's `HttpClient` are recorded with their bodies, with nothing to add: `package:http`'s
default client, dio's default adapter, `Image.network`. Capybara sets `HttpOverrides.global`, in front of overrides the
app set before `Capybara.run`, or in its first 30 seconds, so theirs still apply.

Clients outside dart:io, such as cupertino_http's and cronet_http's, are recorded when wrapped:

```dart
final client = CapybaraHttpClient(CupertinoClient.defaultSessionConfiguration());
```

dio with `native_dio_adapter` goes outside dart:io too, and is not recorded yet. To leave requests out:
`CapybaraOptions(ignoreUrls: ['/health', RegExp(r'analytics')])`, or `network: false` for all of dart:io's.

### WebSockets

Wrap the channel where the app makes it, and use what comes back:

```dart
final channel = Capybara.webSocket(WebSocketChannel.connect(url), url: url);
```

Messages both ways, and how the socket closed, show in Capybara's Network tab. A socket that is not wrapped shows only
as its handshake request.

### Storage

Add the app's stores where it opens them, and they show in Capybara's Storage tab:

```dart
Capybara.addStorage(CapybaraSharedPreferences.legacy(await SharedPreferences.getInstance()));
Capybara.addStorage(CapybaraSecureStorage(const FlutterSecureStorage()));
Capybara.addStorage(CapybaraHiveBox(await Hive.openBox('settings')));
```

- shared_preferences: `legacy` for `SharedPreferences`, `async` for `SharedPreferencesAsync`, `withCache` for
  `SharedPreferencesWithCache`. Pass the instance the app uses: on Android the async API keeps its values apart from
  the legacy one. Edited values keep their type: numbers, `true`/`false` and JSON lists of strings are written back as
  such.
- flutter_secure_storage: read-only unless `readOnly: false`, and secret, so `capybara mcp` hides every value. Pass the
  instance with the app's options; options that ask for biometrics make each listing ask too.
- Hive (hive_ce or hive), a `Box` or a `LazyBox`: values show as JSON, and the app's writes show as they happen.
  Objects stored through a TypeAdapter are shown but not edited.

Any other store can be shown by extending `CapybaraStorage`.

### State

Riverpod and Bloc have packages of their own, which add an observer:
[capybara_devtools_riverpod](https://pub.dev/packages/capybara_devtools_riverpod) and
[capybara_devtools_bloc](https://pub.dev/packages/capybara_devtools_bloc). A `ValueNotifier` or `ChangeNotifier` shows
with `Capybara.watch`:

```dart
Capybara.watch('cart', cart, read: () => {'items': cart.items, 'total': cart.total});
```

A `ValueNotifier` needs no `read`; without one, a `ChangeNotifier` shows as its `toJson()`.

## Finding Capybara

| The app runs on | What to do |
| --- | --- |
| iOS simulator, Windows, Linux | Nothing. |
| macOS | Add `com.apple.security.network.client` to `macos/Runner/DebugProfile.entitlements`: the sandbox blocks connections without it, and Flutter's template leaves it out. The package says so in the console when it is missing. |
| Android emulator, or an Android phone on USB | Nothing: the package also tries 10.0.2.2, and Capybara runs `adb reverse` for devices on USB. |
| An iPhone, even on USB, or a phone on Wi‑Fi | Build with `--dart-define=CAPYBARA_HOST=192.168.1.20`, the address Capybara prints under "Network", with the phone on the computer's network: on an iPhone 127.0.0.1 is the phone, and iOS has no `adb reverse`. Allow the Local Network prompt on iOS. |

Capybara on another port than 7357: `--dart-define=CAPYBARA_PORT=…`, or `CapybaraOptions(port: …)`.

## Release builds

The package does nothing in release builds, and is left out of them: it runs only where `kDebugMode`, a constant,
is true. To use it in a profile or release build for testers, build with `--dart-define=CAPYBARA_ENABLED=true`.
Such a build sends what the app logs to whoever runs Capybara where it looks, so keep it away from the store. On iOS
it also needs an `NSLocalNetworkUsageDescription` in Info.plist to reach a computer on the network: Flutter adds one to
debug builds only.

## Platforms

Android, iOS, macOS, Windows and Linux. On the web the package builds and does nothing yet.
