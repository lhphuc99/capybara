import 'dart:async';
import 'dart:convert';

import '../core/client.dart';

/// Keys a listing shows, characters of each value in it, and of one value read on its own, as in the JS SDK.
const int maxStorageKeys = 1000;
const int storagePreviewLength = 2000;
const int storageValueLength = 1000000;

/// A store of the app's that Capybara shows, and edits unless [readOnly]. Values go to the UI as text.
abstract class CapybaraStorage {
  /// Names the store in commands; stores registered again under the same id replace the earlier one.
  String get id;

  String get label;

  bool get readOnly => false;

  bool get canClear => !readOnly;

  /// Every value is a secret, as in a keychain: `capybara mcp` hides them all.
  bool get secret => false;

  /// Shown under the store in the UI, e.g. how values are typed when written.
  String? get note => null;

  Future<Iterable<String>> keys();

  Future<String?> get(String key);

  Future<void> set(String key, String value) => throw UnsupportedError('$label is read-only');

  Future<void> remove(String key) => throw UnsupportedError('$label is read-only');

  Future<void> clear() => throw UnsupportedError('$label cannot be cleared');

  /// Writes the app makes, so the UI can read the store again; null when the store does not tell.
  Stream<({String op, String? key})>? get changes => null;
}

/// The `storage` plugin: lists the stores the app registered and answers the UI's reads and writes.
final class StoragePlugin extends CapybaraPlugin {
  final Map<String, CapybaraStorage> _stores = {};
  final Map<String, StreamSubscription<Object?>> _watching = {};
  PluginContext? _context;

  @override
  String get name => 'storage';

  void add(CapybaraStorage store) {
    unawaited(_watching.remove(store.id)?.cancel());
    _stores[store.id] = store;
    _watch(store);
    // The UI lists the stores when it opens the tab; one registered later shows after this.
    _context?.emit('storage.change', {'adapter': store.id, 'op': 'unknown'});
  }

  @override
  void Function()? setup(PluginContext context) {
    _context = context;
    _stores.values.forEach(_watch);
    return () {
      _context = null;
      for (final subscription in _watching.values) {
        unawaited(subscription.cancel());
      }
      _watching.clear();
    };
  }

  void _watch(CapybaraStorage store) {
    final context = _context;
    if (context == null) return;
    try {
      final changes = store.changes;
      if (changes == null) return;
      _watching[store.id] = changes.listen(
        (change) => context.emit('storage.change', {'adapter': store.id, 'op': change.op, 'key': ?change.key}),
        onError: (Object _) {},
      );
    } catch (_) {
      // A store that cannot be watched is still listed; the UI has Refresh.
    }
  }

  CapybaraStorage _find(Object? params) {
    final id = (params is Map ? params['adapter'] : null)?.toString();
    final store = _stores[id];
    if (store == null) throw StateError('Unknown storage "$id"');
    return store;
  }

  static String _key(Object? params) => '${(params! as Map)['key']}';

  @override
  Map<String, CommandHandler> get commands => {
    'list': (_) => [
      for (final store in _stores.values)
        {
          'id': store.id,
          'label': store.label,
          'readOnly': store.readOnly,
          'canClear': store.canClear,
          if (store.secret) 'secret': true,
          'note': ?store.note,
        },
    ],
    'entries': (params) async {
      final store = _find(params);
      final keys = [...await store.keys()]..sort();
      final shown = keys.take(maxStorageKeys).toList();
      final values = await Future.wait(shown.map(store.get));
      return {
        'entries': [for (var i = 0; i < shown.length; i++) _entry(shown[i], values[i], storagePreviewLength)],
        'total': keys.length,
      };
    },
    'get': (params) async {
      final key = _key(params);
      final value = await _find(params).get(key);
      return value == null ? null : _entry(key, value, storageValueLength);
    },
    'set': (params) async {
      final store = _find(params);
      if (store.readOnly) throw StateError('${store.label} is read-only');
      await store.set(_key(params), '${(params! as Map)['value']}');
      return null;
    },
    'remove': (params) async {
      final store = _find(params);
      if (store.readOnly) throw StateError('${store.label} is read-only');
      await store.remove(_key(params));
      return null;
    },
    'clear': (params) async {
      final store = _find(params);
      if (!store.canClear) throw StateError('${store.label} cannot be cleared');
      await store.clear();
      return null;
    },
  };

  static Map<String, Object?> _entry(String key, String? value, int limit) {
    if (value == null) return {'key': key, 'value': null, 'size': 0, 'truncated': false};
    final truncated = value.length > limit;
    return {
      'key': key,
      'value': truncated ? value.substring(0, limit) : value,
      'size': utf8.encode(value).length,
      'truncated': truncated,
    };
  }
}

/// A value as text: strings as they are, the rest as JSON, objects through their `toJson()` or `toString()`.
String storageText(Object? value) {
  if (value is String) return value;
  try {
    return jsonEncode(
      value,
      toEncodable: (object) {
        try {
          return (object as dynamic).toJson();
        } catch (_) {
          return object.toString();
        }
      },
    );
  } catch (_) {
    return value.toString();
  }
}
