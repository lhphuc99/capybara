/// Sends a Flutter app's logs, errors, requests and storage to Capybara, the local devtools for React Native, Flutter
/// and web apps.
library;

export 'src/capybara.dart' show Capybara, CapybaraOptions;
export 'src/network/http_client.dart' show CapybaraHttpClient;
export 'src/storage/hive.dart' show CapybaraHiveBox;
export 'src/storage/secure_storage.dart' show CapybaraSecureStorage;
export 'src/storage/shared_preferences.dart' show CapybaraSharedPreferences;
export 'src/storage/storage.dart' show CapybaraStorage;
export 'src/version.dart' show capybaraVersion;
