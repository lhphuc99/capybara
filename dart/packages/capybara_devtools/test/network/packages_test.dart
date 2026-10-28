@TestOn('vm')
library;

import 'dart:io';

import 'package:capybara_devtools/src/network/http_client.dart';
import 'package:capybara_devtools/src/network/http_io.dart';
import 'package:capybara_devtools/src/network/recorder.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import 'support.dart';

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

  Future<T> overridden<T>(Future<T> Function() body) =>
      HttpOverrides.runWithHttpOverrides(body, CapybaraHttpOverrides());

  test('records dio requests once, with their bodies', () async {
    await overridden(() async {
      final dio = Dio();
      final response = await dio.post<String>(
        server.url('/echo').toString(),
        data: '{"cart":3}',
        options: Options(contentType: 'application/json', responseType: ResponseType.plain),
      );
      expect(response.data, '{"cart":3}');
      dio.close();
    });
    expect(recorded.kinds, ['network.request', 'network.response']);
    expect(recorded.of('network.request').single['body'], containsPair('text', '{"cart":3}'));
    expect(recorded.of('network.response').single['body'], containsPair('text', '{"cart":3}'));
  });

  test('records package:http requests once, also through CapybaraHttpClient over dart:io', () async {
    await overridden(() async {
      expect((await http.get(server.url('/text'))).body, 'hello');
      final client = CapybaraHttpClient(IOClient());
      expect((await client.get(server.url('/text'))).body, 'hello');
      client.close();
    });
    expect(recorded.kinds, ['network.request', 'network.response', 'network.request', 'network.response']);
  });
}
