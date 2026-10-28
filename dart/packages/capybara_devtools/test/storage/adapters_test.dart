@TestOn('vm')
library;

import 'dart:io';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

Future<Map<String, String?>> _read(CapybaraStorage store) async => {
  for (final key in (await store.keys()).toList()..sort()) key: await store.get(key),
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('shared_preferences', () {
    final values = <String, Object>{
      'name': 'Capy',
      'count': 3,
      'ratio': 0.5,
      'on': true,
      'tags': ['a', 'b'],
    };

    Future<void> writesKeepTheirType(CapybaraStorage store, Future<Object?> Function(String key) read) async {
      await store.set('count', '7');
      await store.set('ratio', '1.5');
      await store.set('on', 'false');
      await store.set('tags', '["x"]');
      await store.set('fresh', 'new');
      expect(await read('count'), 7);
      expect(await read('ratio'), 1.5);
      expect(await read('on'), false);
      expect(await read('tags'), ['x']);
      expect(await read('fresh'), 'new');
      await expectLater(store.set('count', 'many'), throwsA(isA<FormatException>()));
      await expectLater(store.set('on', 'yes'), throwsA(isA<FormatException>()));
      await store.remove('fresh');
      expect(await read('fresh'), isNull);
    }

    test('legacy: shows every type as text, and writes each back as its type', () async {
      SharedPreferences.setMockInitialValues(values);
      final prefs = await SharedPreferences.getInstance();
      final store = CapybaraSharedPreferences.legacy(prefs);
      expect(await _read(store), {'count': '3', 'name': 'Capy', 'on': 'true', 'ratio': '0.5', 'tags': '["a","b"]'});
      await writesKeepTheirType(store, (key) async => prefs.get(key));
    });

    test('async and with cache', () async {
      SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty();
      final prefs = SharedPreferencesAsync();
      await prefs.setString('name', 'Capy');
      await prefs.setInt('count', 3);
      await prefs.setDouble('ratio', 0.5);
      await prefs.setBool('on', true);
      await prefs.setStringList('tags', ['a', 'b']);
      final store = CapybaraSharedPreferences.async(prefs);
      expect(await _read(store), containsPair('tags', '["a","b"]'));
      await writesKeepTheirType(store, (key) async => (await prefs.getAll(allowList: {key}))[key]);

      final cached = await SharedPreferencesWithCache.create(cacheOptions: const SharedPreferencesWithCacheOptions());
      final cachedStore = CapybaraSharedPreferences.withCache(cached);
      expect(await _read(cachedStore), containsPair('name', 'Capy'));
      await writesKeepTheirType(cachedStore, (key) async => cached.get(key));
    });
  });

  test('secure storage: read-only and secret unless told otherwise', () async {
    FlutterSecureStorage.setMockInitialValues({'token': 'abc'});
    const storage = FlutterSecureStorage();
    final store = CapybaraSecureStorage(storage);
    expect(store.secret, isTrue);
    expect(store.readOnly, isTrue);
    expect(await _read(store), {'token': 'abc'});
    final writable = CapybaraSecureStorage(storage, readOnly: false);
    await writable.set('token', 'xyz');
    expect(await storage.read(key: 'token'), 'xyz');
    await writable.clear();
    expect(await storage.readAll(), isEmpty);
  });

  group('hive', () {
    late Directory dir;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('capybara_hive');
      Hive.init(dir.path);
    });

    tearDown(() async {
      await Hive.close();
      dir.deleteSync(recursive: true);
    });

    test('shows values as JSON, keeps int keys, and writes back what was there', () async {
      final box = await Hive.openBox<Object>('settings');
      await box.putAll({
        'name': 'Capy',
        'count': 3,
        'profile': {'id': 7},
        1: 'by int key',
      });
      final store = CapybaraHiveBox(box);
      expect(store.id, 'hive:settings');
      expect(store.label, 'Hive: settings');
      expect(await _read(store), {'1': 'by int key', 'count': '3', 'name': 'Capy', 'profile': '{"id":7}'});

      await store.set('profile', '{"id":8}');
      await store.set('count', '4');
      await store.set('name', '{"still":"a string"}');
      await store.set('1', 'changed');
      expect(box.get('profile'), {'id': 8});
      expect(box.get('count'), 4);
      expect(box.get('name'), '{"still":"a string"}');
      expect(box.get(1), 'changed');
      await expectLater(store.set('count', 'four'), throwsA(isA<FormatException>()));
    });

    test('tells about writes as they happen, and reads lazy boxes', () async {
      final box = await Hive.openBox<Object>('watched');
      final changes = CapybaraHiveBox(box).changes.take(2).toList();
      await box.put('a', 1);
      await box.delete('a');
      expect(await changes, [(op: 'set', key: 'a'), (op: 'remove', key: 'a')]);

      final lazy = await Hive.openLazyBox<Object>('lazy');
      await lazy.put('k', [1, 2]);
      expect(await _read(CapybaraHiveBox(lazy)), {'k': '[1,2]'});
    });
  });
}
