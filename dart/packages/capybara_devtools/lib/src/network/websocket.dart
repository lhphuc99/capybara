import 'dart:async';

import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'body.dart';
import 'recorder.dart';

/// [channel], recording its handshake, messages both ways and close as `ws.*` events.
WebSocketChannel trackWebSocket(WebSocketChannel channel, Uri url, NetworkRecorder recorder) {
  if (channel is _TrackedChannel || recorder.ignores(url)) return channel;
  recorder.claimWebSocket(url);
  return _TrackedChannel(channel, _Socket(recorder, recorder.nextSocketId(), url));
}

final class _Socket {
  _Socket(this._recorder, this.id, Uri url) : _clock = Stopwatch()..start() {
    _recorder.emit('ws.connect', {'id': id, 'url': url.toString()});
  }

  final NetworkRecorder _recorder;
  final String id;
  final Stopwatch _clock;
  bool _closed = false;

  // What the app closed the socket with: when it closes first, the channel may report no code of its own.
  bool closing = false;
  int? closingCode;
  String? closingReason;

  void open(String? protocol) => _recorder.emit('ws.open', {
    'id': id,
    if (protocol != null && protocol.isNotEmpty) 'protocol': protocol,
    'duration': _clock.elapsedMilliseconds,
  });

  void message(String direction, Object? data) =>
      _recorder.emit('ws.message', {'id': id, 'direction': direction, 'data': _preview(data)});

  void error(Object error) => _recorder.emit('ws.error', {'id': id, 'message': _describe(error)});

  void close(int? code, String? reason) {
    if (_closed) return;
    _closed = true;
    _recorder.emit('ws.close', {
      'id': id,
      'code': ?code,
      if (reason != null && reason.isNotEmpty) 'reason': reason,
      // No close frame came back: the connection broke, as 1006 says in browsers.
      'wasClean': code != null && code != 1006,
      'duration': _clock.elapsedMilliseconds,
    });
  }

  static Map<String, Object?> _preview(Object? data) {
    if (data is String) return textPreview(data, max: maxMessageSize);
    if (data is List<int>) return {'kind': 'binary', 'size': data.length, 'summary': 'Binary'};
    return {'kind': 'unknown', 'summary': '${data.runtimeType}'};
  }

  static String _describe(Object error) {
    final inner = error is WebSocketChannelException ? error.inner : null;
    return '${inner ?? error.toString()}'.replaceFirst(RegExp(r'^(WebSocketChannelException|Exception): '), '');
  }
}

final class _TrackedChannel with StreamChannelMixin<dynamic> implements WebSocketChannel {
  _TrackedChannel(this._inner, this._socket) : sink = _TrackedSink(_inner.sink, _socket) {
    ready = _inner.ready.then(
      (_) => _socket.open(_inner.protocol),
      onError: (Object error, StackTrace stack) {
        _socket
          ..error(error)
          ..close(1006, null);
        return Future<void>.error(error, stack);
      },
    );
    // The app may never await ready; its failure is reported above, and stays the app's to handle.
    unawaited(ready.catchError((_) {}));
    // An app that stopped listening before the socket closed never sees the stream end; the sink still does.
    unawaited(_inner.sink.done.then((_) => _closed(), onError: (_) => _closed()));
  }

  final WebSocketChannel _inner;
  final _Socket _socket;

  @override
  late final Future<void> ready;

  @override
  final WebSocketSink sink;

  @override
  late final Stream<dynamic> stream = _inner.stream.transform(
    StreamTransformer.fromHandlers(
      handleData: (data, out) {
        _socket.message('received', data);
        out.add(data);
      },
      handleError: (error, stack, out) {
        _socket.error(error);
        out.addError(error, stack);
      },
      handleDone: (out) {
        _closed();
        out.close();
      },
    ),
  );

  // 1005 is what browsers report for a close without a code, 1006 for a connection that just ended.
  void _closed() => _socket.close(
    _inner.closeCode ?? _socket.closingCode ?? (_socket.closing ? 1005 : 1006),
    _inner.closeReason ?? _socket.closingReason,
  );

  @override
  String? get protocol => _inner.protocol;

  @override
  int? get closeCode => _inner.closeCode;

  @override
  String? get closeReason => _inner.closeReason;
}

final class _TrackedSink implements WebSocketSink {
  _TrackedSink(this._inner, this._socket);

  final WebSocketSink _inner;
  final _Socket _socket;

  @override
  void add(dynamic data) {
    _socket.message('sent', data);
    _inner.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) => _inner.addError(error, stackTrace);

  @override
  Future<void> addStream(Stream<dynamic> stream) => _inner.addStream(
    stream.map((data) {
      _socket.message('sent', data);
      return data;
    }),
  );

  @override
  Future<dynamic> close([int? closeCode, String? closeReason]) {
    _socket
      ..closing = true
      ..closingCode = closeCode
      ..closingReason = closeReason;
    return _inner.close(closeCode, closeReason);
  }

  @override
  Future<dynamic> get done => _inner.done;
}
