import 'dart:convert';

import 'storage.dart';

const _typedNote =
    'Values keep their type when edited: a number stays a number, true or false a bool, a JSON list of '
    'strings a list. New keys are strings.';

/// shared_preferences in Capybara. Pass the instance the app uses: on Android, `SharedPreferencesAsync` keeps its
/// values apart from the legacy `SharedPreferences`.
abstract final class CapybaraSharedPreferences {
  /// `SharedPreferences.getInstance()`'s. Values the platform wrote outside Dart show after a refresh.
  static CapybaraStorage legacy(Object prefs, {String label = 'SharedPreferences'}) => _Prefs(
    id: 'shared_preferences',
    label: label,
    keys: () async {
      final dynamic p = prefs;
      await p.reload();
      return (p.getKeys() as Set).cast<String>();
    },
    read: (key) async => (prefs as dynamic).get(key),
    write: (method, key, value) => Function.apply(_method(prefs, method), [key, value]) as Future<Object?>,
    remove: (key) => (prefs as dynamic).remove(key) as Future<Object?>,
    clear: () => (prefs as dynamic).clear() as Future<Object?>,
  );

  /// A `SharedPreferencesAsync`, limited to [allowList] when the app's options are.
  static CapybaraStorage async(Object prefs, {Set<String>? allowList, String label = 'SharedPreferencesAsync'}) =>
      _Prefs(
        id: 'shared_preferences_async',
        label: label,
        keys: () async => ((await (prefs as dynamic).getKeys(allowList: allowList)) as Set).cast<String>(),
        read: (key) async {
          final values = await (prefs as dynamic).getAll(allowList: {key}) as Map;
          return values[key];
        },
        write: (method, key, value) => Function.apply(_method(prefs, method), [key, value]) as Future<Object?>,
        remove: (key) => (prefs as dynamic).remove(key) as Future<Object?>,
        clear: () => (prefs as dynamic).clear(allowList: allowList) as Future<Object?>,
      );

  /// A `SharedPreferencesWithCache`. Its cache is read again before each listing.
  static CapybaraStorage withCache(Object prefs, {String label = 'SharedPreferencesWithCache'}) => _Prefs(
    id: 'shared_preferences_with_cache',
    label: label,
    keys: () async {
      final dynamic p = prefs;
      await p.reloadCache();
      return (p.keys as Set).cast<String>();
    },
    read: (key) async => (prefs as dynamic).get(key),
    write: (method, key, value) => Function.apply(_method(prefs, method), [key, value]) as Future<Object?>,
    remove: (key) => (prefs as dynamic).remove(key) as Future<Object?>,
    clear: () => (prefs as dynamic).clear() as Future<Object?>,
  );

  static Function _method(Object prefs, String name) {
    final dynamic p = prefs;
    return switch (name) {
      'setString' => p.setString,
      'setInt' => p.setInt,
      'setDouble' => p.setDouble,
      'setBool' => p.setBool,
      _ => p.setStringList,
    };
  }
}

final class _Prefs extends CapybaraStorage {
  _Prefs({
    required this.id,
    required this.label,
    required Future<Iterable<String>> Function() keys,
    required Future<Object?> Function(String key) read,
    required Future<Object?> Function(String method, String key, Object value) write,
    required Future<Object?> Function(String key) remove,
    required Future<Object?> Function() clear,
  }) : _keys = keys,
       _read = read,
       _write = write,
       _remove = remove,
       _clear = clear;

  @override
  final String id;

  @override
  final String label;

  final Future<Iterable<String>> Function() _keys;
  final Future<Object?> Function(String key) _read;
  final Future<Object?> Function(String method, String key, Object value) _write;
  final Future<Object?> Function(String key) _remove;
  final Future<Object?> Function() _clear;

  @override
  String get note => _typedNote;

  @override
  Future<Iterable<String>> keys() => _keys();

  @override
  Future<String?> get(String key) async {
    final value = await _read(key);
    return value == null ? null : (value is List ? jsonEncode(value) : '$value');
  }

  @override
  Future<void> set(String key, String value) async {
    final current = await _read(key);
    final (method, typed) = switch (current) {
      int() => ('setInt', int.tryParse(value.trim()) ?? (throw FormatException('$key holds an int'))),
      double() => ('setDouble', double.tryParse(value.trim()) ?? (throw FormatException('$key holds a double'))),
      bool() => ('setBool', _bool(key, value)),
      List() => ('setStringList', _stringList(key, value)),
      _ => ('setString', value),
    };
    await _write(method, key, typed);
  }

  @override
  Future<void> remove(String key) => _remove(key);

  @override
  Future<void> clear() => _clear();

  static bool _bool(String key, String value) => switch (value.trim()) {
    'true' => true,
    'false' => false,
    _ => throw FormatException('$key holds a bool: write true or false'),
  };

  static List<String> _stringList(String key, String value) {
    try {
      return (jsonDecode(value) as List).map((item) => item as String).toList();
    } catch (_) {
      throw FormatException('$key holds a list of strings: write it as JSON, like ["a", "b"]');
    }
  }
}
