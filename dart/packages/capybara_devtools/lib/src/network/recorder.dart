import 'dart:async';
import 'dart:math';

import 'body.dart';

typedef Emit = void Function(String kind, Map<String, Object?> payload);

const Duration _streamAfter = Duration(milliseconds: 500);
const Duration _streamEvery = Duration(seconds: 1);

/// The recorder of the running Capybara client, for the HTTP clients and WebSockets the app wraps itself.
NetworkRecorder? activeRecorder;

/// Turns what the app's HTTP clients and WebSockets do into `network.*` and `ws.*` events.
final class NetworkRecorder {
  NetworkRecorder(this._emit, {List<Pattern> ignoreUrls = const [], bool Function(Uri url)? isCapybara})
    : _ignoreUrls = ignoreUrls,
      _isCapybara = isCapybara ?? ((_) => false);

  final Emit _emit;
  final List<Pattern> _ignoreUrls;
  final bool Function(Uri url) _isCapybara;
  final String _prefix = '${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${Random().nextInt(1 << 20)}';
  int _requests = 0;
  int _sockets = 0;
  final Map<String, DateTime> _wrappedSockets = {};

  bool ignores(Uri url) {
    if (_isCapybara(url)) return true;
    final text = url.toString();
    for (final pattern in _ignoreUrls) {
      if (pattern is RegExp ? pattern.hasMatch(text) : text.contains(pattern)) return true;
    }
    return false;
  }

  HttpCall start(String method, Uri url) => HttpCall._(this, 'dart-$_prefix-${++_requests}', method.toUpperCase(), url);

  String nextSocketId() => 'ws-$_prefix-${++_sockets}';

  void emit(String kind, Map<String, Object?> payload) {
    try {
      _emit(kind, payload);
    } catch (_) {
      // Never throw into the app.
    }
  }

  /// A WebSocket the app wrapped, whose handshake request is then left out of the request list.
  void claimWebSocket(Uri url) {
    final now = DateTime.now();
    _wrappedSockets.removeWhere((_, at) => now.difference(at) > const Duration(seconds: 30));
    _wrappedSockets[_socketKey(url)] = now;
  }

  bool isClaimedWebSocket(Uri url) {
    final at = _wrappedSockets[_socketKey(url)];
    return at != null && DateTime.now().difference(at) < const Duration(seconds: 30);
  }

  // The handshake goes over http(s) to the address the app gave as ws(s).
  static String _socketKey(Uri url) => '${url.host}:${url.port}${url.path}?${url.query}';
}

/// One request: `network.request` once its body is known, `network.response` once the body has arrived (with
/// what came so far after 500 ms, and every second while more comes), or `network.error`.
final class HttpCall {
  HttpCall._(this._recorder, this.id, this.method, this.url) : _clock = Stopwatch()..start();

  final NetworkRecorder _recorder;
  final String id;
  final String method;
  final Uri url;
  final Stopwatch _clock;
  bool _requested = false;
  bool _finished = false;

  int get elapsed => _clock.elapsedMilliseconds;

  void request(Map<String, String> headers, [Map<String, Object?>? body]) {
    if (_requested) return;
    _requested = true;
    _recorder.emit('network.request', {
      'id': id,
      'initiator': 'other',
      'method': method,
      'url': url.toString(),
      'headers': headers,
      'body': ?body,
    });
  }

  ResponseTap respond(int status, String? statusText, Map<String, String> headers) {
    request(const {});
    return ResponseTap._(this, status, statusText, headers, elapsed);
  }

  void fail(Object error, {bool aborted = false}) {
    if (_finished) return;
    _finished = true;
    request(const {});
    final message = _message(error);
    _recorder.emit('network.error', {
      'id': id,
      'message': message,
      'duration': elapsed,
      if (aborted) 'aborted': true,
      if (error is TimeoutException || message.contains('timed out')) 'timeout': true,
    });
  }

  static String _message(Object error) {
    final text = error.toString();
    return text.startsWith('Exception: ') ? text.substring('Exception: '.length) : text;
  }
}

/// The body of a response as the app reads it. Nothing is read that the app does not read itself.
final class ResponseTap {
  ResponseTap._(this._call, this._status, this._statusText, this._headers, this._duration) {
    _timer = Timer(_streamAfter, _progress);
  }

  final HttpCall _call;
  final int _status;
  final String? _statusText;
  final Map<String, String> _headers;
  final int _duration;
  final BodyBytes _body = BodyBytes();
  Timer? _timer;
  Stopwatch? _sinceReport;

  String? get _contentType => _headers['content-type'];

  void add(List<int> chunk) {
    if (_call._finished) return;
    _body.add(chunk);
    final since = _sinceReport;
    if (since != null && since.elapsed >= _streamEvery) _progress();
  }

  /// The body is complete, or the app stopped reading it.
  void done() {
    if (_call._finished) return;
    _call._finished = true;
    _timer?.cancel();
    _emit(_body.preview(_contentType));
  }

  void _progress() {
    if (_call._finished) return;
    _sinceReport = Stopwatch()..start();
    _emit(_body.preview(_contentType), streaming: true);
  }

  void _emit(Map<String, Object?>? body, {bool streaming = false}) {
    _call._recorder.emit('network.response', {
      'id': _call.id,
      'status': _status,
      if (_statusText != null && _statusText.isNotEmpty) 'statusText': _statusText,
      'headers': _headers,
      'body': ?body,
      'duration': _duration,
      if (streaming) 'streaming': true,
    });
  }
}
