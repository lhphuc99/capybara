// Talks to Capybara's real server, built from this repository, over a real WebSocket. Skipped until the CLI is
// built (`npm run build` at the root), and where Node is missing.
// ignore_for_file: avoid_print
@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:capybara_devtools/src/core/client.dart';
import 'package:capybara_devtools/src/core/socket_io.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

final String? _skip = () {
  if (!File('../../../packages/cli/dist/server.js').existsSync()) return 'Build the CLI first: npm run build';
  try {
    Process.runSync('node', ['--version']);
    return null;
  } on ProcessException {
    return 'Needs Node';
  }
}();

/// The server with one viewer connected, as the UI would be.
final class _Capybara {
  _Capybara._(this._process);

  final Process _process;
  final List<Map<String, Object?>> received = [];
  late final int port;

  static Future<_Capybara> start() async {
    final process = await Process.start('node', ['test/support/capybara_server.mjs']);
    final capybara = _Capybara._(process);
    final ready = Completer<int>();
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      final message = jsonDecode(line) as Map<String, Object?>;
      if (!ready.isCompleted && message['port'] is int) {
        ready.complete(message['port']! as int);
      } else {
        capybara.received.add(message);
      }
    });
    process.stderr.transform(utf8.decoder).listen(stderr.write);
    capybara.port = await ready.future.timeout(const Duration(seconds: 20));
    return capybara;
  }

  Future<Map<String, Object?>> waitFor(bool Function(Map<String, Object?> message) test) async {
    for (var i = 0; i < 500; i++) {
      final found = received.where(test).firstOrNull;
      if (found != null) return found;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    throw TimeoutException('No such message among ${received.length}: ${received.map((m) => m['t']).toList()}');
  }

  Future<Map<String, Object?>> session(String appName, {bool connected = true}) => waitFor((message) {
    final session = message['session'];
    return message['t'] == 'session' &&
        session is Map &&
        (session['info'] as Map)['appName'] == appName &&
        session['connected'] == connected;
  });

  /// The events the viewer got for a session, in order.
  List<Map<String, Object?>> events(String sessionId) => [
    for (final message in received)
      if (message['t'] == 'events' && message['sessionId'] == sessionId)
        ...(message['events']! as List).cast<Map<String, Object?>>(),
  ];

  void send(Map<String, Object?> message) => _process.stdin.writeln(jsonEncode(message));

  Future<void> stop() async {
    await _process.stdin.close();
    await _process.exitCode.timeout(const Duration(seconds: 10), onTimeout: () => _process.kill() ? -1 : -1);
  }
}

String _id(Map<String, Object?> sessionMessage) => ((sessionMessage['session']! as Map)['info'] as Map)['id'] as String;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  group('with the real server', skip: _skip, () {
    late _Capybara capybara;

    setUp(() async {
      capybara = await _Capybara.start();
    });

    tearDown(() async {
      await capybara.stop();
    });

    test('the server shows the session, logs and errors of an app running the package', () async {
      final previous = FlutterError.onError;
      addTearDown(() async {
        await Capybara.stop();
        FlutterError.onError = previous;
      });
      FlutterError.onError = (_) {};
      Capybara.run(
        () => print('hello from Dart'),
        options: CapybaraOptions(appName: 'Contract', host: '127.0.0.1', port: capybara.port),
      );
      final id = _id(await capybara.session('Contract'));
      Capybara.log('Saved', level: 'info', data: {'id': 9007199254740993, 'at': DateTime.utc(2026)});
      FlutterError.reportError(FlutterErrorDetails(exception: StateError('closed'), library: 'widgets library'));

      await capybara.waitFor((_) => capybara.events(id).length >= 3);
      final payloads = [for (final event in capybara.events(id)) event['payload']! as Map];
      expect(capybara.events(id).map((event) => event['seq']), [1, 2, 3]);
      expect(payloads[0], {
        'level': 'log',
        'source': 'console',
        'args': ['hello from Dart'],
      });
      expect(payloads[1], {
        'level': 'info',
        'source': 'api',
        'args': [
          'Saved',
          {
            'id': {r'$t': 'number', 'v': '9007199254740993'},
            'at': {r'$t': 'date', 'v': '2026-01-01T00:00:00.000Z'},
          },
        ],
      });
      expect(payloads[2]['source'], 'uncaught');
      expect((payloads[2]['args'] as List).single, containsPair('name', 'StateError'));

      await Capybara.stop();
      await capybara.session('Contract', connected: false);
    });

    test('a command from the UI reaches the plugin and its answer comes back', () async {
      final client = CapybaraClient(
        session: {
          'appName': 'Commands',
          'platform': 'ios',
          'sdk': {'name': 'capybara_devtools', 'version': capybaraVersion},
        },
        targets: () => [Uri(scheme: 'ws', host: '127.0.0.1', port: capybara.port, path: '/client')],
        plugins: [_Storage()],
        connect: connectSocket,
      )..start();
      addTearDown(client.stop);
      final id = _id(await capybara.session('Commands'));

      capybara.send({'t': 'command', 'id': 'c1', 'sessionId': id, 'plugin': 'storage', 'method': 'list'});
      capybara.send({'t': 'command', 'id': 'c2', 'sessionId': id, 'plugin': 'storage', 'method': 'clear'});
      final listed = await capybara.waitFor((message) => message['t'] == 'result' && message['id'] == 'c1');
      final unknown = await capybara.waitFor((message) => message['t'] == 'result' && message['id'] == 'c2');
      expect(listed, {
        't': 'result',
        'id': 'c1',
        'ok': true,
        'result': ['token'],
      });
      expect(unknown, {'t': 'result', 'id': 'c2', 'ok': false, 'error': 'Unknown command storage.clear'});
    });

    test('after the server restarts, the app reconnects to it as the same session', () async {
      final client = CapybaraClient(
        session: {'appName': 'Restart', 'platform': 'android'},
        targets: () => [Uri(scheme: 'ws', host: '127.0.0.1', port: capybara.port, path: '/client')],
        connect: connectSocket,
        minRetry: const Duration(milliseconds: 100),
      )..start();
      addTearDown(client.stop);
      final id = _id(await capybara.session('Restart'));
      client.log('log', ['before']);
      await capybara.waitFor((_) => capybara.events(id).isNotEmpty);

      // A new server on another port: the app is told the new address, as the debugger does for phones.
      await capybara.stop();
      capybara = await _Capybara.start();
      client
        ..log('log', ['while away'])
        ..retarget(() => [Uri(scheme: 'ws', host: '127.0.0.1', port: capybara.port, path: '/client')]);
      expect(_id(await capybara.session('Restart')), id);
      await capybara.waitFor((_) => capybara.events(id).length >= 2);
      expect(
        [for (final event in capybara.events(id)) (event['payload']! as Map)['args']],
        [
          ['before'],
          ['while away'],
        ],
      );
    });
  });
}

final class _Storage extends CapybaraPlugin {
  @override
  String get name => 'storage';

  @override
  Map<String, CommandHandler> get commands => {
    'list': (_) => ['token'],
  };
}
