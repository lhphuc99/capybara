@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';

import 'package:capybara_devtools/src/network/recorder.dart';
import 'package:capybara_devtools/src/network/websocket.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/io.dart';

import 'support.dart';

void main() {
  late TestServer server;
  late Recorded recorded;

  setUp(() async {
    server = await TestServer.start();
    recorded = Recorded();
  });

  tearDown(() => server.close());

  test('records the handshake, messages both ways, and the close', () async {
    final url = server.url('/ws').replace(scheme: 'ws');
    final channel = trackWebSocket(IOWebSocketChannel.connect(url), url, recorded.recorder);
    await channel.ready;
    final received = <Object?>[];
    final done = Completer<void>();
    channel.stream.listen(received.add, onDone: done.complete);
    channel.sink
      ..add('hello')
      ..add([1, 2, 3]);
    while (received.length < 2) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(received, [
      'hello',
      [1, 2, 3],
    ]);
    await channel.sink.close(1000, 'bye');
    await done.future;

    expect(recorded.kinds.first, 'ws.connect');
    final id = recorded.of('ws.connect').single['id'];
    expect(recorded.of('ws.connect').single['url'], url.toString());
    expect(recorded.of('ws.open').single, containsPair('id', id));
    final messages = recorded.of('ws.message');
    expect([for (final message in messages) message['direction']], ['sent', 'sent', 'received', 'received']);
    expect(messages[0]['data'], {'kind': 'text', 'text': 'hello', 'size': 5, 'truncated': false});
    expect(messages[1]['data'], {'kind': 'binary', 'size': 3, 'summary': 'Binary'});
    final close = recorded.of('ws.close').single;
    expect(close['code'], 1000);
    expect(close['reason'], 'bye');
    expect(close['wasClean'], isTrue);
  });

  test('records the close of a socket the app stopped listening to', () async {
    final url = server.url('/ws').replace(scheme: 'ws');
    final channel = trackWebSocket(IOWebSocketChannel.connect(url), url, recorded.recorder);
    await channel.ready;
    final first = channel.stream.first;
    channel.sink.add('only one');
    expect(await first, 'only one');
    await channel.sink.close(1000, 'done');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(recorded.of('ws.open').single.containsKey('protocol'), isFalse);
    expect(recorded.of('ws.close').single, containsPair('code', 1000));
    expect(recorded.of('ws.close').single, containsPair('reason', 'done'));
  });

  test('records a socket that could not connect, and still fails ready for the app', () async {
    final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final url = Uri.parse('ws://127.0.0.1:${closed.port}/ws');
    await closed.close();
    final channel = trackWebSocket(IOWebSocketChannel.connect(url), url, recorded.recorder);
    await expectLater(channel.ready, throwsA(anything));
    expect(recorded.kinds, ['ws.connect', 'ws.error', 'ws.close']);
    expect(recorded.of('ws.error').single['message'], contains('Connection refused'));
    expect(recorded.of('ws.close').single, containsPair('wasClean', false));
  });

  test('wraps a channel once, and leaves ignored URLs alone', () {
    final url = Uri.parse('ws://127.0.0.1:1/ws');
    final channel = IOWebSocketChannel.connect(url);
    final tracked = trackWebSocket(channel, url, recorded.recorder);
    expect(trackWebSocket(tracked, url, recorded.recorder), same(tracked));
    final ignoring = NetworkRecorder((_, _) {}, ignoreUrls: ['127.0.0.1:1']);
    expect(trackWebSocket(channel, url, ignoring), same(channel));
    tracked.ready.catchError((_) {});
  });
}
