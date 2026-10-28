@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';

import 'package:capybara_devtools/src/core/socket_io.dart';
import 'package:flutter_test/flutter_test.dart';

final class _NoHttp extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => throw StateError('HttpClient taken over');
}

void main() {
  test('connects past HttpOverrides, which test bindings and request capture install', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.transform(WebSocketTransformer()).listen((socket) => socket.listen(socket.add));

    final url = Uri(scheme: 'ws', host: '127.0.0.1', port: server.port, path: '/client');
    final socket = await HttpOverrides.runWithHttpOverrides(() => connectSocket(url), _NoHttp());
    final reply = socket.messages.first;
    socket.send('hello');
    expect(await reply, 'hello');
    await socket.close();
  });

  test('gives up on an address that does not answer', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    // Accepts the connection but never answers the upgrade.
    server.listen((_) {});
    final url = Uri(scheme: 'ws', host: '127.0.0.1', port: server.port, path: '/client');
    await expectLater(connectSocket(url), throwsA(isA<TimeoutException>()));
  });
}
