import 'dart:convert';
import 'dart:typed_data';

/// Bodies are cut after this many bytes, and their text after this many characters, as in the JS SDK.
const int maxBodySize = 128 * 1024;

/// WebSocket messages are cut after this many characters.
const int maxMessageSize = 16 * 1024;

final _textual = RegExp(
  r'^(text/|application/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)\b)',
  caseSensitive: false,
);

/// A body without a content type is taken as text, as browsers show it.
bool isTextual(String? contentType) => contentType == null || _textual.hasMatch(contentType.trim());

Map<String, Object?> textPreview(
  String text, {
  int max = maxBodySize,
  String? contentType,
  int? size,
  String kind = 'text',
}) {
  final truncated = text.length > max;
  return {
    'kind': kind,
    'text': truncated ? text.substring(0, max) : text,
    'size': size ?? utf8.encode(text).length,
    'truncated': truncated,
    'contentType': ?contentType,
  };
}

/// The first bytes of a body, and how many there were in all.
final class BodyBytes {
  BodyBytes({this.max = maxBodySize});

  final int max;
  final BytesBuilder _kept = BytesBuilder(copy: true);
  int total = 0;

  bool get isEmpty => total == 0;

  void add(List<int> chunk) {
    total += chunk.length;
    final room = max - _kept.length;
    if (room > 0) _kept.add(chunk.length > room ? chunk.sublist(0, room) : chunk);
  }

  /// What the UI shows of the body: its text when the content type is textual, else its size.
  Map<String, Object?>? preview(String? contentType) {
    if (total == 0) return null;
    if (contentType != null && RegExp(r'^text/event-stream', caseSensitive: false).hasMatch(contentType)) {
      return {'kind': 'stream', 'contentType': contentType, 'summary': 'Event stream'};
    }
    if (!isTextual(contentType)) {
      return {'kind': 'binary', 'size': total, 'contentType': ?contentType, 'summary': contentType ?? 'Binary'};
    }
    final text = utf8.decode(_kept.toBytes(), allowMalformed: true);
    final cut = total > _kept.length || text.length > max;
    return {
      'kind': 'text',
      'text': text.length > max ? text.substring(0, max) : text,
      'size': total,
      'truncated': cut,
      'contentType': ?contentType,
    };
  }
}
