import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:capybara_devtools/src/network/recorder.dart';

/// The events a recorder emitted, in order.
final class Recorded {
  final List<(String, Map<String, Object?>)> events = [];

  late final NetworkRecorder recorder = NetworkRecorder((kind, payload) => events.add((kind, payload)));

  List<Map<String, Object?>> of(String kind) => [
    for (final (k, payload) in events)
      if (k == kind) payload,
  ];

  List<String> get kinds => [for (final (kind, _) in events) kind];
}

/// A local server with the answers the tests need.
final class TestServer {
  TestServer._(this._server);

  final HttpServer _server;

  static final String big = List.filled(1024 * 1024 ~/ 8, 'abcdefgh').join();

  static Future<TestServer> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final test = TestServer._(server);
    server.listen(test._handle);
    return test;
  }

  Uri url(String path) => Uri.parse('http://127.0.0.1:${_server.port}$path');

  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    switch (request.uri.path) {
      case '/text':
        response.headers.contentType = ContentType.text;
        response.write('hello');
      case '/echo':
        final body = await request.fold<List<int>>([], (all, chunk) => all..addAll(chunk));
        response.headers.set(HttpHeaders.contentTypeHeader, request.headers.value(HttpHeaders.contentTypeHeader) ?? '');
        response.add(body);
      case '/big':
        response.headers.contentType = ContentType.json;
        response.write(big);
      case '/gzip':
        response.headers.contentType = ContentType.json;
        response.headers.set(HttpHeaders.contentEncodingHeader, 'gzip');
        response.add(gzip.encode(utf8.encode('{"zipped":true}')));
      case '/missing':
        response.statusCode = HttpStatus.notFound;
        response.write('nope');
      case '/binary':
        response.headers.contentType = ContentType.binary;
        response.add(List.filled(300, 7));
      case '/slow':
        response.headers.contentType = ContentType.text;
        response.bufferOutput = false;
        response.write('first ');
        await response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 800));
        response.write('second');
      case '/never':
        await Future<void>.delayed(const Duration(seconds: 30));
      case '/ws':
        final socket = await WebSocketTransformer.upgrade(request);
        socket.listen(socket.add, onDone: () => socket.close(socket.closeCode, socket.closeReason));
        return;
    }
    await response.close();
  }
}
