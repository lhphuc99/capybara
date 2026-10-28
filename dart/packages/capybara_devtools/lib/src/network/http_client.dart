import 'dart:async';

import 'package:http/http.dart' as http;

import 'body.dart';
import 'http_stub.dart' if (dart.library.io) 'http_io.dart';
import 'recorder.dart';

/// A `package:http` client that records its requests in Capybara: for clients outside dart:io, such as
/// cupertino_http's and cronet_http's, whose requests Capybara would not see otherwise.
///
/// ```dart
/// final client = CapybaraHttpClient(CupertinoClient.defaultSessionConfiguration());
/// ```
///
/// Requests through dart:io, as `http.Client()` and dio make them, are recorded already: wrapping such a client
/// records nothing more.
final class CapybaraHttpClient extends http.BaseClient {
  CapybaraHttpClient([http.Client? inner]) : _inner = inner ?? http.Client();

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final recorder = activeRecorder;
    if (recorder == null || isIoClient(_inner) || recorder.ignores(request.url)) return _inner.send(request);
    final call = recorder.start(request.method, request.url);
    call.request(Map.of(request.headers), _requestBody(request));
    final http.StreamedResponse response;
    try {
      response = await _inner.send(request);
    } catch (error) {
      call.fail(error, aborted: error.runtimeType.toString() == 'RequestAbortedException');
      rethrow;
    }
    final tap = call.respond(response.statusCode, response.reasonPhrase, _lowerCase(response.headers));
    final stream = response.stream.transform(
      StreamTransformer<List<int>, List<int>>.fromHandlers(
        handleData: (chunk, sink) {
          tap.add(chunk);
          sink.add(chunk);
        },
        handleError: (error, stack, sink) {
          tap.done();
          sink.addError(error, stack);
        },
        handleDone: (sink) {
          tap.done();
          sink.close();
        },
      ),
    );
    // Clients that know where redirects led say so through BaseResponseWithUrl; the copy keeps it.
    if (response is http.BaseResponseWithUrl) {
      return _ResponseWithUrl(
        stream,
        response.statusCode,
        url: (response as http.BaseResponseWithUrl).url,
        contentLength: response.contentLength,
        request: response.request,
        headers: response.headers,
        isRedirect: response.isRedirect,
        persistentConnection: response.persistentConnection,
        reasonPhrase: response.reasonPhrase,
      );
    }
    return http.StreamedResponse(
      stream,
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}

Map<String, String> _lowerCase(Map<String, String> headers) => {
  for (final MapEntry(:key, :value) in headers.entries) key.toLowerCase(): value,
};

Map<String, Object?>? _requestBody(http.BaseRequest request) {
  final contentType = _lowerCase(request.headers)['content-type'];
  if (request is http.Request) {
    final bytes = BodyBytes()..add(request.bodyBytes);
    return bytes.preview(contentType);
  }
  if (request is http.MultipartRequest) {
    final lines = [
      for (final MapEntry(:key, :value) in request.fields.entries) '$key=$value',
      for (final file in request.files)
        '${file.field}=[file ${file.filename ?? 'blob'}, ${file.contentType.mimeType}, ${file.length} B]',
    ];
    return textPreview(lines.join('\n'), contentType: 'multipart/form-data', kind: 'form');
  }
  if (request.contentLength == 0) return null;
  return {'kind': 'stream', 'contentType': ?contentType, 'summary': 'Streamed request body'};
}

final class _ResponseWithUrl extends http.StreamedResponse implements http.BaseResponseWithUrl {
  _ResponseWithUrl(
    super.stream,
    super.statusCode, {
    required this.url,
    super.contentLength,
    super.request,
    super.headers,
    super.isRedirect,
    super.persistentConnection,
    super.reasonPhrase,
  });

  @override
  final Uri url;
}
