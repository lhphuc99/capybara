import 'storage.dart';

/// flutter_secure_storage in Capybara, read-only unless [readOnly] is false. Its values are marked secret, so
/// `capybara mcp` hides them. Pass the instance the app uses, with its options: reading with others finds other
/// values, and options that ask for biometrics make each listing ask too.
final class CapybaraSecureStorage extends CapybaraStorage {
  CapybaraSecureStorage(this._storage, {bool readOnly = true, this.label = 'Secure storage'}) : _readOnly = readOnly;

  final Object _storage;
  final bool _readOnly;

  @override
  final String label;

  @override
  String get id => 'secure_storage';

  @override
  bool get readOnly => _readOnly;

  @override
  bool get secret => true;

  @override
  Future<Iterable<String>> keys() async => ((await (_storage as dynamic).readAll()) as Map).keys.cast<String>();

  @override
  Future<String?> get(String key) async => await (_storage as dynamic).read(key: key) as String?;

  @override
  Future<void> set(String key, String value) async => (_storage as dynamic).write(key: key, value: value);

  @override
  Future<void> remove(String key) async => (_storage as dynamic).delete(key: key);

  @override
  Future<void> clear() async => (_storage as dynamic).deleteAll();
}
