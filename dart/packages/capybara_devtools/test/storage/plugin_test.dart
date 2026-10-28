import 'dart:async';

import 'package:capybara_devtools/src/core/client.dart';
import 'package:capybara_devtools/src/storage/storage.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fake_socket.dart';

final class _Memory extends CapybaraStorage {
  _Memory(this.id, this.values, {this.readOnly = false, this.secret = false});

  @override
  final String id;

  @override
  String get label => 'Memory $id';

  @override
  final bool readOnly;

  @override
  final bool secret;

  final Map<String, String> values;
  final StreamController<({String op, String? key})> _changes = StreamController.broadcast();

  @override
  Future<Iterable<String>> keys() async => values.keys;

  @override
  Future<String?> get(String key) async => values[key];

  @override
  Future<void> set(String key, String value) async {
    values[key] = value;
    _changes.add((op: 'set', key: key));
  }

  @override
  Future<void> remove(String key) async => values.remove(key);

  @override
  Future<void> clear() async => values.clear();

  @override
  Stream<({String op, String? key})> get changes => _changes.stream;
}

void main() {
  late FakeServer server;
  late StoragePlugin plugin;
  late CapybaraClient client;

  setUp(() async {
    server = FakeServer();
    plugin = StoragePlugin();
    client = CapybaraClient(
      session: {'appName': 'Test', 'platform': 'ios'},
      targets: () => [Uri.parse('ws://127.0.0.1:7357/client')],
      plugins: [plugin],
      connect: server.connect,
      flushInterval: Duration.zero,
    )..start();
    await pumpEventQueue();
    server.last.receive({'t': 'welcome', 'lastSeq': 0});
    await pumpEventQueue();
  });

  tearDown(() => client.stop());

  Future<Map<String, Object?>> command(String method, [Map<String, Object?>? params]) async {
    final id = '${server.last.sent.length}';
    server.last.receive({'t': 'command', 'id': id, 'plugin': 'storage', 'method': method, 'params': params});
    for (var i = 0; i < 50; i++) {
      await pumpEventQueue();
      final result = server.last.sent.where((m) => m['t'] == 'result' && m['id'] == id).firstOrNull;
      if (result != null) return result;
    }
    throw StateError('No answer to $method');
  }

  test('lists the stores the app added, with what the UI needs to know of them', () async {
    plugin
      ..add(_Memory('prefs', {}))
      ..add(_Memory('keychain', {}, readOnly: true, secret: true));
    expect((await command('list'))['result'], [
      {'id': 'prefs', 'label': 'Memory prefs', 'readOnly': false, 'canClear': true},
      {'id': 'keychain', 'label': 'Memory keychain', 'readOnly': true, 'canClear': false, 'secret': true},
    ]);
  });

  test('lists entries sorted, cut to a preview, and reads one value in full', () async {
    plugin.add(_Memory('prefs', {'b': 'x' * 3000, 'a': 'é'}));
    final entries = (await command('entries', {'adapter': 'prefs'}))['result']! as Map;
    expect(entries['total'], 2);
    final list = entries['entries']! as List;
    expect(list[0], {'key': 'a', 'value': 'é', 'size': 2, 'truncated': false});
    expect((list[1] as Map)['truncated'], isTrue);
    expect(((list[1] as Map)['value']! as String).length, 2000);
    final full = (await command('get', {'adapter': 'prefs', 'key': 'b'}))['result']! as Map;
    expect((full['value']! as String).length, 3000);
    expect((await command('get', {'adapter': 'prefs', 'key': 'missing'}))['result'], isNull);
  });

  test('writes, removes and clears, and refuses what a store does not allow', () async {
    final memory = _Memory('prefs', {'a': '1'});
    plugin
      ..add(memory)
      ..add(_Memory('keychain', {'token': 't'}, readOnly: true));
    expect((await command('set', {'adapter': 'prefs', 'key': 'b', 'value': '2'}))['ok'], isTrue);
    expect((await command('remove', {'adapter': 'prefs', 'key': 'a'}))['ok'], isTrue);
    expect(memory.values, {'b': '2'});
    expect((await command('clear', {'adapter': 'prefs'}))['ok'], isTrue);
    expect(memory.values, isEmpty);

    final readOnly = await command('set', {'adapter': 'keychain', 'key': 'token', 'value': 'x'});
    expect(readOnly['error'], 'Memory keychain is read-only');
    expect((await command('clear', {'adapter': 'keychain'}))['error'], 'Memory keychain cannot be cleared');
    expect((await command('entries', {'adapter': 'nope'}))['error'], 'Unknown storage "nope"');
  });

  test('tells the UI when a store changes, and when one is added', () async {
    final memory = _Memory('prefs', {});
    plugin.add(memory);
    await memory.set('a', '1');
    await pumpEventQueue();
    final changes = [
      for (final event in server.last.events)
        if (event['kind'] == 'storage.change') event['payload'],
    ];
    expect(changes, [
      {'adapter': 'prefs', 'op': 'unknown'},
      {'adapter': 'prefs', 'op': 'set', 'key': 'a'},
    ]);
  });
}
