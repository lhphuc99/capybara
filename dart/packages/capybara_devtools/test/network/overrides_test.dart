@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:capybara_devtools/src/network/http_io.dart';
import 'package:capybara_devtools/src/network/recorder.dart';
import 'package:capybara_devtools/src/network/websocket.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/io.dart';

import 'support.dart';

final class _Agent extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => super.createHttpClient(context)..userAgent = 'parent-agent';
}

Future<String> _get(Uri url) async {
  final client = HttpClient();
  try {
    final response = await (await client.getUrl(url)).close();
    return await utf8.decodeStream(response);
  } finally {
    client.close();
  }
}

void main() {
  late TestServer server;
  late Recorded recorded;

  setUp(() async {
    server = await TestServer.start();
    recorded = Recorded();
    activeRecorder = recorded.recorder;
  });

  tearDown(() async {
    activeRecorder = null;
    await server.close();
  });

  Future<T> overridden<T>(Future<T> Function() body, [HttpOverrides? parent]) =>
      HttpOverrides.runWithHttpOverrides(body, CapybaraHttpOverrides(parent: parent));

  test('records a request and its response once the body has come', () async {
    expect(await overridden(() => _get(server.url('/text'))), 'hello');
    expect(recorded.kinds, ['network.request', 'network.response']);
    final request = recorded.of('network.request').single;
    expect(request['method'], 'GET');
    expect(request['url'], server.url('/text').toString());
    expect(request['initiator'], 'other');
    expect((request['headers']! as Map)['user-agent'], startsWith('Dart/'));
    final response = recorded.of('network.response').single;
    expect(response['id'], request['id']);
    expect(response['status'], 200);
    expect(response['statusText'], 'OK');
    expect(response['duration'], isA<int>());
    expect(response['body'], {
      'kind': 'text',
      'text': 'hello',
      'size': 5,
      'truncated': false,
      'contentType': 'text/plain; charset=utf-8',
    });
  });

  test('records what the app writes as the request body', () async {
    final echoed = await overridden(() async {
      final client = HttpClient();
      final request = await client.postUrl(server.url('/echo'));
      request.headers.contentType = ContentType.json;
      request.write('{"a":');
      request.add(utf8.encode('1}'));
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      client.close();
      return text;
    });
    expect(echoed, '{"a":1}');
    final request = recorded.of('network.request').single;
    expect(request['method'], 'POST');
    expect(request['body'], containsPair('text', '{"a":1}'));
    expect(request['body'], containsPair('size', 7));
    expect(recorded.of('network.response').single['body'], containsPair('text', '{"a":1}'));
  });

  test('cuts a large body, keeping its full size', () async {
    final text = await overridden(() => _get(server.url('/big')));
    expect(text.length, TestServer.big.length);
    final body = recorded.of('network.response').single['body']! as Map;
    expect(body['truncated'], isTrue);
    expect((body['text']! as String).length, 128 * 1024);
    expect(body['size'], TestServer.big.length);
  });

  test('shows a gzip body as the app reads it', () async {
    expect(await overridden(() => _get(server.url('/gzip'))), '{"zipped":true}');
    expect(recorded.of('network.response').single['body'], containsPair('text', '{"zipped":true}'));
    expect((recorded.of('network.response').single['headers']! as Map)['content-encoding'], 'gzip');
  });

  test('records error statuses and binary bodies', () async {
    await overridden(() => _get(server.url('/missing')));
    await overridden(() async {
      final client = HttpClient();
      final response = await (await client.getUrl(server.url('/binary'))).close();
      await response.drain<void>();
      client.close();
    });
    final responses = recorded.of('network.response');
    expect(responses[0]['status'], 404);
    expect(responses[0]['statusText'], 'Not Found');
    expect(responses[1]['body'], {
      'kind': 'binary',
      'size': 300,
      'contentType': 'application/octet-stream',
      'summary': 'application/octet-stream',
    });
  });

  test('records a request that could not connect', () async {
    final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = closed.port;
    await closed.close();
    await expectLater(overridden(() => _get(Uri.parse('http://127.0.0.1:$port/'))), throwsA(isA<SocketException>()));
    expect(recorded.kinds, ['network.request', 'network.error']);
    final error = recorded.of('network.error').single;
    expect(error['message'], contains('Connection refused'));
    expect(error['duration'], isA<int>());
  });

  test('records a request the app aborted', () async {
    await overridden(() async {
      final client = HttpClient();
      final request = await client.getUrl(server.url('/never'));
      final response = request.close();
      request.abort();
      await expectLater(response, throwsA(anything));
      client.close(force: true);
    });
    expect(recorded.of('network.error').single['aborted'], isTrue);
  });

  test('sends what came so far of a slow body, then all of it', () async {
    expect(await overridden(() => _get(server.url('/slow'))), 'first second');
    final responses = recorded.of('network.response');
    expect(responses.first['streaming'], isTrue);
    expect(responses.first['body'], containsPair('text', 'first '));
    expect(responses.last.containsKey('streaming'), isFalse);
    expect(responses.last['body'], containsPair('text', 'first second'));
  });

  test('makes clients through the overrides the app set before, and records once when nested', () async {
    await overridden(() => _get(server.url('/text')), CapybaraHttpOverrides(parent: _Agent()));
    expect(recorded.of('network.request'), hasLength(1));
    expect((recorded.of('network.request').single['headers']! as Map)['user-agent'], 'parent-agent');
  });

  test('leaves out requests the app ignores', () async {
    final ignoring = Recorded();
    activeRecorder = NetworkRecorder(
      (kind, payload) => ignoring.events.add((kind, payload)),
      ignoreUrls: [RegExp(r'/text$')],
    );
    await overridden(() => _get(server.url('/text')));
    expect(ignoring.events, isEmpty);
  });

  test('records the handshake of a WebSocket the app did not wrap, and only the socket of one it did', () async {
    final url = server.url('/ws').replace(scheme: 'ws');
    // dart:io keeps one HttpClient for WebSocket.connect, made at its first use: here the test runner's own socket.
    await overridden(() async {
      final socket = await WebSocket.connect(url.toString(), customClient: HttpClient());
      await socket.close(1000);
    });
    expect(recorded.kinds, ['network.request', 'network.response']);
    expect(recorded.of('network.response').single['status'], 101);

    recorded.events.clear();
    await overridden(() async {
      final channel = trackWebSocket(
        IOWebSocketChannel.connect(url, customClient: HttpClient()),
        url,
        recorded.recorder,
      );
      await channel.ready;
      await channel.sink.close(1000);
    });
    expect(recorded.kinds.where((kind) => kind.startsWith('network.')), isEmpty);
    expect(recorded.kinds, contains('ws.open'));
  });

  test('installs in front of the app overrides, and again after the app replaces them', () {
    // dart:io has no getter for HttpOverrides.global; outside any zone that sets one, current is it.
    addTearDown(() => HttpOverrides.global = null);
    final app = _Agent();
    HttpOverrides.global = app;
    final installed = installHttpOverrides();
    expect(HttpOverrides.current, isA<CapybaraHttpOverrides>());
    expect((HttpOverrides.current! as CapybaraHttpOverrides).parent, same(app));

    final later = _Agent();
    HttpOverrides.global = later;
    installed.check();
    expect((HttpOverrides.current! as CapybaraHttpOverrides).parent, same(later));
    installed.remove();
    expect(HttpOverrides.current, same(later));
  });
}
