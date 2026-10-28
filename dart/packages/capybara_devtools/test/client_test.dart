import 'package:capybara_devtools/src/core/client.dart';
import 'package:capybara_devtools/src/core/socket.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

final class _Plugin extends CapybaraPlugin {
  _Plugin(this.name, {this.commands = const {}, this.onSetup});

  @override
  final String name;

  @override
  final Map<String, CommandHandler> commands;

  final void Function(PluginContext context)? onSetup;
  int tornDown = 0;

  @override
  void Function()? setup(PluginContext context) {
    onSetup?.call(context);
    return () => tornDown++;
  }
}

final _local = Uri.parse('ws://127.0.0.1:7357/client');
final _emulator = Uri.parse('ws://10.0.2.2:7357/client');

CapybaraClient _client(
  FakeServer server, {
  List<CapybaraPlugin> plugins = const [],
  List<Uri>? targets,
  int maxBufferEvents = 2000,
  List<String>? diagnostics,
}) => CapybaraClient(
  session: {
    'appName': 'Test',
    'platform': 'ios',
    'sdk': {'name': 'test', 'version': '0'},
  },
  targets: () => targets ?? [_local],
  plugins: plugins,
  connect: server.connect,
  flushInterval: Duration.zero,
  maxBufferEvents: maxBufferEvents,
  diagnostic: diagnostics?.add,
);

void _log(CapybaraClient client, int n) {
  for (var i = 0; i < n; i++) {
    client.log('log', ['line $i']);
  }
}

List<int> _seqs(FakeSocket socket) => [for (final event in socket.events) event['seq']! as int];

void main() {
  test('says hello with the session, and sends events only after the welcome', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      async.flushMicrotasks();
      final socket = server.last;
      final hello = socket.sent.single;
      expect(hello['t'], 'hello');
      expect(hello['protocol'], 1);
      expect(hello['session'], containsPair('appName', 'Test'));
      expect((hello['session']! as Map)['id'], client.session['id']);
      expect((hello['session']! as Map)['startedAt'], isA<int>());

      client.log('info', [
        'hello',
        {'a': 1},
      ]);
      async.elapse(const Duration(seconds: 1));
      expect(socket.events, isEmpty);
      expect(client.connected, isFalse);

      socket.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();
      expect(client.connected, isTrue);
      expect(socket.events.single, containsPair('seq', 1));
      expect(socket.events.single['kind'], 'log');
      expect(socket.events.single['payload'], {
        'level': 'info',
        'source': 'api',
        'args': [
          'hello',
          {'a': 1},
        ],
      });
    });
  });

  test('names its plugins in the hello, and gives them a way to report', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(
        server,
        plugins: [
          _Plugin('logs', onSetup: (context) => context.emit('log', {'level': 'log', 'args': []})),
        ],
      )..start();
      async.flushMicrotasks();
      expect(client.session['plugins'], ['logs']);
      server.last.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();
      expect(_seqs(server.last), [1]);
    });
  });

  test('sends at most 200 events in a message', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      _log(client, 450);
      async.flushMicrotasks();
      server.last.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();
      final batches = server.last.sent.where((message) => message['t'] == 'events').toList();
      expect([for (final batch in batches) (batch['events']! as List).length], [200, 200, 50]);
      expect(_seqs(server.last), List.generate(450, (i) => i + 1));
    });
  });

  test('after a reconnect resends only what the server is missing', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      async.flushMicrotasks();
      server.last.receive({'t': 'welcome', 'lastSeq': 0});
      _log(client, 3);
      async.elapse(Duration.zero);
      expect(_seqs(server.last), [1, 2, 3]);

      final first = server.last;
      first.drop();
      async.flushMicrotasks();
      expect(client.connected, isFalse);
      _log(client, 1);
      async.elapse(const Duration(seconds: 1));
      expect(server.sockets, hasLength(2));
      // The server got only the first two before the connection went.
      server.last.receive({'t': 'welcome', 'lastSeq': 2});
      async.flushMicrotasks();
      expect(_seqs(server.last), [3, 4]);
    });
  });

  test('drops the oldest events when the buffer is full', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server, maxBufferEvents: 3)..start();
      _log(client, 5);
      async.flushMicrotasks();
      server.last.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();
      expect(_seqs(server.last), [3, 4, 5]);
    });
  });

  test('skips an event JSON cannot carry, without a gap in the numbers', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      client.emit('log', {'value': Object()});
      _log(client, 1);
      async.flushMicrotasks();
      server.last.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();
      expect(_seqs(server.last), [1]);
    });
  });

  test('runs plugin commands and answers with their results and errors', () {
    fakeAsync((async) {
      final server = FakeServer();
      _client(
        server,
        plugins: [
          _Plugin(
            'storage',
            commands: {
              'list': (params) async => ['token'],
              'read': (params) => throw Exception('No key ${(params! as Map)['key']}'),
              'raw': (params) => Object(),
            },
          ),
        ],
      ).start();
      async.flushMicrotasks();
      final socket = server.last;
      socket.receive({'t': 'welcome', 'lastSeq': 0});
      for (final (id, plugin, method) in [
        ('1', 'storage', 'list'),
        ('2', 'storage', 'read'),
        ('3', 'storage', 'wipe'),
        ('4', 'state', 'list'),
        ('5', 'storage', 'raw'),
      ]) {
        socket.receive({
          't': 'command',
          'id': id,
          'plugin': plugin,
          'method': method,
          'params': {'key': 'a'},
        });
      }
      async.flushMicrotasks();
      final results = {for (final message in socket.sent.where((m) => m['t'] == 'result')) message['id']: message};
      expect(results['1'], {
        't': 'result',
        'id': '1',
        'ok': true,
        'result': ['token'],
      });
      expect(results['2'], {'t': 'result', 'id': '2', 'ok': false, 'error': 'No key a'});
      expect(results['3']!['error'], 'Unknown command storage.wipe');
      expect(results['4']!['error'], 'Unknown command state.list');
      expect(results['5']!['ok'], isFalse);
      expect(results['5']!['error'], startsWith('The result could not be sent'));
    });
  });

  test('stops for good when the server turns the app away', () {
    fakeAsync((async) {
      final server = FakeServer();
      final diagnostics = <String>[];
      final plugin = _Plugin('logs');
      _client(server, plugins: [plugin], diagnostics: diagnostics).start();
      async.flushMicrotasks();
      server.last.receive({'t': 'reject', 'reason': 'Protocol 2 is not supported'});
      async.elapse(const Duration(minutes: 1));
      expect(diagnostics, ['The Capybara server turned this app away: Protocol 2 is not supported']);
      expect(server.last.closed, isTrue);
      expect(server.sockets, hasLength(1));
      expect(plugin.tornDown, 1);
    });
  });

  test('tells once what in the app keeps it from connecting', () {
    fakeAsync((async) {
      final diagnostics = <String>[];
      final server = FakeServer()..failure = const CapybaraSetupError('Add the entitlement');
      _client(server, diagnostics: diagnostics).start();
      async.elapse(const Duration(seconds: 30));
      expect(server.attempts.length, greaterThan(3));
      expect(diagnostics, ['Add the entitlement']);
    });
  });

  test('waits longer after each failed attempt, up to 10 seconds', () {
    fakeAsync((async) {
      final server = FakeServer()..up = false;
      _client(server).start();
      final times = <int>[];
      var seen = 0;
      for (var second = 0; second <= 40; second++) {
        async.flushMicrotasks();
        if (server.attempts.length > seen) {
          seen = server.attempts.length;
          times.add(second);
        }
        async.elapse(const Duration(seconds: 1));
      }
      expect(times, [0, 1, 3, 7, 15, 25, 35]);
    });
  });

  test('tries every address at once, then the one that answered first', () {
    fakeAsync((async) {
      final server = FakeServer()..refusedHosts.add('127.0.0.1');
      final client = _client(server, targets: [_local, _emulator])..start();
      async.flushMicrotasks();
      expect(server.attempts, ['127.0.0.1', '10.0.2.2']);
      expect(client.target, _emulator);

      server.attempts.clear();
      server.last.drop();
      async.elapse(const Duration(seconds: 1));
      expect(server.attempts, ['10.0.2.2']);

      // When it stops answering, both are tried again straight away.
      server.attempts.clear();
      server.refusedHosts
        ..clear()
        ..add('10.0.2.2');
      server.last.drop();
      async.elapse(const Duration(seconds: 1));
      expect(server.attempts, ['10.0.2.2', '127.0.0.1', '10.0.2.2']);
      expect(client.target, _local);
    });
  });

  test('moves to new addresses at once', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      async.flushMicrotasks();
      final first = server.last;
      first.receive({'t': 'welcome', 'lastSeq': 0});
      async.flushMicrotasks();

      final phone = Uri.parse('ws://192.168.1.20:7357/client');
      client.retarget(() => [phone]);
      async.flushMicrotasks();
      expect(first.closed, isTrue);
      expect(server.sockets, hasLength(2));
      expect(server.last.url, phone);
      expect(client.connected, isFalse);
    });
  });

  test('drops a connection to the old addresses that opens after they changed', () {
    fakeAsync((async) {
      final server = FakeServer();
      final client = _client(server)..start();
      final phone = Uri.parse('ws://192.168.1.20:7357/client');
      client.retarget(() => [phone]);
      async.flushMicrotasks();
      expect(server.sockets.map((socket) => socket.url), [_local, phone]);
      expect(server.sockets.first.closed, isTrue);
      expect(client.target, phone);
    });
  });

  test('stop tears the plugins down, closes the socket and records nothing more', () async {
    final server = FakeServer();
    final plugin = _Plugin('logs');
    final client = _client(server, plugins: [plugin])..start();
    await pumpEventQueue();
    await client.stop();
    client.log('log', ['late']);
    expect(plugin.tornDown, 1);
    expect(server.last.closed, isTrue);
    expect(client.connected, isFalse);
  });
}
