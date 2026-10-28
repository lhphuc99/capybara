## 0.1.0

- First version: sends logs (`print`, `debugPrint`, `Capybara.log`) and errors (Flutter's, and uncaught ones of
  futures and zones) to Capybara, from Android, iOS, macOS, Windows and Linux. Does nothing in release builds.
- Requests through dart:io's `HttpClient` (`package:http`, dio, `Image.network`) with their bodies;
  `CapybaraHttpClient` for clients outside dart:io; `Capybara.webSocket` for a WebSocket's messages.
- Storage the app adds with `Capybara.addStorage`: shared_preferences (all three APIs), flutter_secure_storage
  (read-only and secret by default) and Hive boxes, editable from Capybara.
- State: `Capybara.watch` for ValueNotifiers and ChangeNotifiers; Riverpod and Bloc through capybara_devtools_riverpod
  and capybara_devtools_bloc, which build on `package:capybara_devtools/adapter.dart`.
