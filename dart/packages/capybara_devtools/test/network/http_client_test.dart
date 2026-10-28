import 'dart:convert';

import 'package:capybara_devtools/src/network/http_client.dart';
import 'package:capybara_devtools/src/network/recorder.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support.dart';

void main() {
  late Recorded recorded;

  setUp(() {
    recorded = Recorded();
    activeRecorder = recorded.recorder;
  });

  tearDown(() => activeRecorder = null);

  final native = MockClient((request) async {
    if (request.url.path == '/fail') throw http.ClientException('Network is down', request.url);
    return http.Response(
      request.body.isEmpty ? '{"ok":true}' : request.body,
      201,
      headers: {'Content-Type': 'application/json'},
      reasonPhrase: 'Created',
      request: request,
    );
  });

  test('records requests of a client outside dart:io, with both bodies', () async {
    final client = CapybaraHttpClient(native);
    final response = await client.post(
      Uri.parse('https://api.test/items'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'name': 'Capy'}),
    );
    expect(response.body, '{"name":"Capy"}');
    final request = recorded.of('network.request').single;
    expect(request['method'], 'POST');
    expect(request['url'], 'https://api.test/items');
    expect(request['body'], containsPair('text', '{"name":"Capy"}'));
    final recordedResponse = recorded.of('network.response').single;
    expect(recordedResponse['status'], 201);
    expect(recordedResponse['statusText'], 'Created');
    expect((recordedResponse['headers']! as Map)['content-type'], 'application/json');
    expect(recordedResponse['body'], containsPair('text', '{"name":"Capy"}'));
  });

  test('describes multipart and streamed request bodies without reading files', () async {
    final client = CapybaraHttpClient(native);
    final form = http.MultipartRequest('POST', Uri.parse('https://api.test/upload'))
      ..fields['title'] = 'Photo'
      ..files.add(http.MultipartFile.fromBytes('file', List.filled(10, 1), filename: 'a.png'));
    await (await client.send(form)).stream.drain<void>();
    final streamed = http.StreamedRequest('PUT', Uri.parse('https://api.test/stream'));
    final sent = client.send(streamed);
    streamed.sink.add([1, 2]);
    await streamed.sink.close();
    await (await sent).stream.drain<void>();
    final bodies = [for (final request in recorded.of('network.request')) request['body']];
    expect(bodies[0], containsPair('kind', 'form'));
    expect(bodies[0], containsPair('text', 'title=Photo\nfile=[file a.png, application/octet-stream, 10 B]'));
    expect(bodies[1], {'kind': 'stream', 'summary': 'Streamed request body'});
  });

  test('records a failed request, and gives the app the error', () async {
    final client = CapybaraHttpClient(native);
    await expectLater(client.get(Uri.parse('https://api.test/fail')), throwsA(isA<http.ClientException>()));
    expect(recorded.kinds, ['network.request', 'network.error']);
    expect(recorded.of('network.error').single['message'], contains('Network is down'));
  });

  test('only passes requests on while Capybara is not running', () async {
    activeRecorder = null;
    final client = CapybaraHttpClient(native);
    expect((await client.get(Uri.parse('https://api.test/items'))).statusCode, 201);
    expect(recorded.events, isEmpty);
  });
}
