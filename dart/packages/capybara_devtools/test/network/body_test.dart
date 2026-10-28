import 'dart:convert';

import 'package:capybara_devtools/src/network/body.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('takes text content types, and no content type, as text', () {
    expect(isTextual(null), isTrue);
    expect(isTextual('application/json; charset=utf-8'), isTrue);
    expect(isTextual('application/vnd.api+json'), isTrue);
    expect(isTextual('application/x-www-form-urlencoded'), isTrue);
    expect(isTextual('image/png'), isFalse);
    expect(isTextual('multipart/form-data; boundary=x'), isFalse);
  });

  test('keeps the first bytes of a body and counts them all', () {
    final body = BodyBytes(max: 4)
      ..add(utf8.encode('ab'))
      ..add(utf8.encode('cdef'));
    expect(body.preview('text/plain'), {
      'kind': 'text',
      'text': 'abcd',
      'size': 6,
      'truncated': true,
      'contentType': 'text/plain',
    });
    expect(BodyBytes().preview('text/plain'), isNull);
  });

  test('describes binary bodies and event streams by what they are', () {
    final binary = BodyBytes()..add([1, 2, 3]);
    expect(binary.preview('image/png'), {
      'kind': 'binary',
      'size': 3,
      'contentType': 'image/png',
      'summary': 'image/png',
    });
    expect(binary.preview('text/event-stream'), {
      'kind': 'stream',
      'contentType': 'text/event-stream',
      'summary': 'Event stream',
    });
  });

  test('decodes text cut inside a character without failing', () {
    final body = BodyBytes(max: 2)..add(utf8.encode('éé'));
    expect(body.preview('text/plain')?['text'], 'é');
  });
}
