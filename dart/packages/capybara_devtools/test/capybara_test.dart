// ignore_for_file: avoid_print

import 'dart:async';
import 'dart:ui';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_socket.dart';

Future<void> _until(bool Function() done) async {
  for (var i = 0; i < 300 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(done(), isTrue, reason: 'timed out waiting');
}

List<Map<String, Object?>> _logs(FakeSocket socket) => [
  for (final event in socket.events)
    if (event['kind'] == 'log') event['payload']! as Map<String, Object?>,
];

Map<String, Object?> _firstArg(Map<String, Object?> log) => (log['args']! as List).first as Map<String, Object?>;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeServer server;
  FlutterExceptionHandler? flutterHandler;
  ErrorCallback? platformHandler;
  DebugPrintCallback? printHandler;

  setUp(() {
    // flutter_test plays Android, where the app also tries the address the emulator gives the computer.
    server = FakeServer()..refusedHosts.add('10.0.2.2');
    Capybara.connectForTesting = server.connect;
    flutterHandler = FlutterError.onError;
    platformHandler = PlatformDispatcher.instance.onError;
    printHandler = debugPrint;
  });

  tearDown(() async {
    await Capybara.stop();
    Capybara.connectForTesting = null;
    FlutterError.onError = flutterHandler;
    PlatformDispatcher.instance.onError = platformHandler;
    debugPrint = printHandler!;
  });

  Future<FakeSocket> welcomed() async {
    await _until(() => server.sockets.isNotEmpty && server.last.sent.isNotEmpty);
    server.last.receive({'t': 'welcome', 'lastSeq': 0});
    return server.last;
  }

  test('sends what the app prints, in a session that names the app and the package', () async {
    Capybara.run(() => print('hello'), options: const CapybaraOptions(appName: 'Shop'));
    final socket = await welcomed();
    final session = socket.sent.first['session']! as Map<String, Object?>;
    expect(session['appName'], 'Shop');
    // What flutter_test makes defaultTargetPlatform.
    expect(session['platform'], 'android');
    expect(session['sdk'], {'name': 'capybara_devtools', 'version': capybaraVersion});
    expect(session['runtime'], contains('Dart '));
    // Code outside lib/, as this test is, belongs to no package.
    expect(session.containsKey('dartPackages'), isFalse);
    await _until(() => _logs(socket).isNotEmpty);
    expect(_logs(socket).single, {
      'level': 'log',
      'source': 'console',
      'args': ['hello'],
    });
  });

  test('reports an uncaught error once, and still passes it on', () async {
    final error = StateError('boom');
    final caught = <Object>[];
    runZonedGuarded(
      () => Capybara.run(() => scheduleMicrotask(() => throw error)),
      (error, stack) => caught.add(error),
    );
    final socket = await welcomed();
    await _until(() => _logs(socket).isNotEmpty);
    expect(caught, [error]);
    // The engine hands some errors to PlatformDispatcher.onError as well.
    expect(PlatformDispatcher.instance.onError!(error, StackTrace.current), isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(_logs(socket), hasLength(1));
    expect(_logs(socket).single['level'], 'error');
    expect(_logs(socket).single['source'], 'uncaught');
    expect(_firstArg(_logs(socket).single), containsPair('name', 'StateError'));
  });

  test('reports Flutter errors with what Flutter knows about them, and hands them on', () async {
    final seen = <FlutterErrorDetails>[];
    FlutterError.onError = seen.add;
    Capybara.run(() {});
    final socket = await welcomed();
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: Exception('overflow'),
        library: 'rendering library',
        context: ErrorDescription('during layout'),
      ),
    );
    await _until(() => _logs(socket).isNotEmpty);
    expect(seen, hasLength(1));
    expect(_logs(socket).single['level'], 'error');
    expect(_firstArg(_logs(socket).single), {
      r'$t': 'error',
      'name': 'Exception',
      'message': 'overflow',
      'props': {
        'library': 'Exception caught by rendering library',
        'context': 'The following Exception was thrown during layout',
      },
    });
  });

  test('gets back in front of a handler set after it, and reports each error once', () async {
    FlutterError.onError = (_) {};
    Capybara.run(() {});
    final socket = await welcomed();
    final capybara = FlutterError.onError!;
    final later = <FlutterErrorDetails>[];
    // As crash reporters do: report, then pass the error to the handler that was there.
    FlutterError.onError = (details) {
      later.add(details);
      capybara(details);
    };
    final reporter = FlutterError.onError;
    await _until(() => !identical(FlutterError.onError, reporter));
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('again')));
    await _until(() => _logs(socket).isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(later, hasLength(1));
    expect(_logs(socket), hasLength(1));
  });

  test('sends log entries with a level and structured data', () async {
    Capybara.run(() {});
    final socket = await welcomed();
    Capybara.log('Saved', level: 'warning', data: {'id': 7});
    Capybara.log('Plain');
    await _until(() => _logs(socket).length == 2);
    expect(_logs(socket), [
      {
        'level': 'warn',
        'source': 'api',
        'args': [
          'Saved',
          {'id': 7},
        ],
      },
      {
        'level': 'log',
        'source': 'api',
        'args': ['Plain'],
      },
    ]);
  });

  test('init sends debugPrint output, and stop puts back what it replaced', () async {
    final lines = <String?>[];
    debugPrint = (message, {wrapWidth}) => lines.add(message);
    final appPrint = debugPrint;
    final appFlutterHandler = FlutterError.onError;
    final appPlatformHandler = PlatformDispatcher.instance.onError;
    Capybara.init();
    Capybara.init();
    expect(debugPrint, isNot(same(appPrint)));
    final socket = await welcomed();
    debugPrint('from debugPrint');
    await _until(() => _logs(socket).isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(_logs(socket).single['args'], ['from debugPrint']);
    expect(lines, ['from debugPrint']);

    await Capybara.stop();
    expect(debugPrint, same(appPrint));
    expect(FlutterError.onError, same(appFlutterHandler));
    expect(PlatformDispatcher.instance.onError, same(appPlatformHandler));
    expect(server.last.closed, isTrue);
  });

  test('init inside run sends each debugPrint line once', () async {
    Capybara.run(() {
      Capybara.init();
      debugPrint('once');
    });
    final socket = await welcomed();
    await _until(() => _logs(socket).isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(_logs(socket), hasLength(1));
  });

  test('keeps one session when started again', () async {
    Capybara.run(() {});
    final client = Capybara.client;
    Capybara.run(() {});
    expect(Capybara.client, same(client));
    await _until(() => server.sockets.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.sockets, hasLength(1));
  });

  test('only runs the app when turned off', () async {
    var ran = false;
    Capybara.run(() => ran = true, options: const CapybaraOptions(enabled: false));
    Capybara.init(const CapybaraOptions(enabled: false));
    Capybara.log('nowhere');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(ran, isTrue);
    expect(Capybara.client, isNull);
    expect(server.attempts, isEmpty);
  });
}
