import 'dart:async';
import 'dart:convert';

import 'storage.dart';

/// A Hive box (hive_ce or hive) in Capybara: a `Box` or a `LazyBox`. Writes the app makes show at once.
/// Values that are not strings show as JSON; edited, JSON is stored as the value it describes, other text as a
/// string. Objects of the app's own types, stored through a TypeAdapter, are shown but not written.
final class CapybaraHiveBox extends CapybaraStorage {
  CapybaraHiveBox(this._box, {String? label}) : label = label ?? 'Hive: ${(_box as dynamic).name}';

  final Object _box;

  @override
  final String label;

  @override
  String get id => 'hive:${(_box as dynamic).name}';

  @override
  String get note =>
      'Values are shown as JSON. Edited JSON is stored as the value it describes (a map, a list, a number), other '
      'text as a string; a string value stays a string.';

  // Hive keys are strings or ints; the UI gets them all as text.
  Object _hiveKey(String key) {
    for (final candidate in (_box as dynamic).keys as Iterable) {
      if ('$candidate' == key) return candidate as Object;
    }
    return int.tryParse(key) ?? key;
  }

  Future<Object?> _read(Object key) async {
    final Object? value = (_box as dynamic).get(key);
    return value is Future ? await value : value;
  }

  @override
  Future<Iterable<String>> keys() async => [for (final key in (_box as dynamic).keys as Iterable) '$key'];

  @override
  Future<String?> get(String key) async {
    final value = await _read(_hiveKey(key));
    return value == null ? null : storageText(value);
  }

  @override
  Future<void> set(String key, String value) async {
    final hiveKey = _hiveKey(key);
    final current = await _read(hiveKey);
    final Object? typed;
    if (current == null || current is String) {
      typed = value;
    } else if (current is num || current is bool || current is List || current is Map) {
      try {
        typed = jsonDecode(value);
      } catch (_) {
        throw FormatException('$key holds ${current.runtimeType}: write it as JSON');
      }
    } else {
      throw UnsupportedError('$key holds a ${current.runtimeType}, which Capybara does not write');
    }
    await ((_box as dynamic).put(hiveKey, typed) as Future);
  }

  @override
  Future<void> remove(String key) async => (_box as dynamic).delete(_hiveKey(key));

  @override
  Future<void> clear() async => (_box as dynamic).clear();

  @override
  Stream<({String op, String? key})> get changes => ((_box as dynamic).watch() as Stream).map(
    (event) => (op: (event as dynamic).deleted == true ? 'remove' : 'set', key: '${(event as dynamic).key}'),
  );
}
