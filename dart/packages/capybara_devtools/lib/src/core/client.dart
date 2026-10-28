import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'serialize.dart';
import 'socket.dart';

/// The protocol version of Capybara's server; it turns away apps that speak another one.
const int protocolVersion = 1;
const int _maxBatchEvents = 200;
const int _maxBatchChars = 512 * 1024;

typedef CommandHandler = FutureOr<Object?> Function(Object? params);

/// Something the client reports, and answers commands from the UI for: logs, errors, network, storage, state.
abstract class CapybaraPlugin {
  String get name;

  /// Installs the plugin's hooks; the function returned undoes them.
  void Function()? setup(PluginContext context) => null;

  Map<String, CommandHandler> get commands => const {};
}

/// What a plugin reports through.
final class PluginContext {
  PluginContext._(this._client);

  final CapybaraClient _client;

  /// `ts` dates an event that happened before now, in milliseconds since the epoch.
  void emit(String kind, Map<String, Object?> payload, {int? ts}) => _client.emit(kind, payload, ts: ts);

  Object? serialize(Object? value) => _client.serializeValue(value);

  /// Events reach the server now. Plugins that only count changes while offline look here.
  bool get connected => _client.connected;
}

final class _Buffered {
  _Buffered(this.seq, this.json);

  final int seq;
  final String json;
}

/// Sends what the app does to Capybara's server: one session for the life of the client, events numbered so
/// that after a reconnect the server says what it has and the rest is sent again. A port of the JS SDK's client.
final class CapybaraClient {
  CapybaraClient({
    required Map<String, Object?> session,
    required List<Uri> Function() targets,
    List<CapybaraPlugin> plugins = const [],
    SocketConnector? connect,
    this.maxBufferEvents = 2000,
    this.maxBufferChars = 8 * 1024 * 1024,
    this.flushInterval = const Duration(milliseconds: 50),
    this.minRetry = const Duration(seconds: 1),
    this.maxRetry = const Duration(seconds: 10),
    this.serializeOptions = const SerializeOptions(),
    void Function(String message)? diagnostic,
  }) : _targets = targets,
       _plugins = List.unmodifiable(plugins),
       _connect = connect,
       _diagnostic = diagnostic ?? ((_) {}),
       session = {
         ...session,
         'id': _randomId(),
         'startedAt': DateTime.now().millisecondsSinceEpoch,
         'plugins': [for (final plugin in plugins) plugin.name],
       } {
    final context = PluginContext._(this);
    for (final plugin in _plugins) {
      try {
        final teardown = plugin.setup(context);
        if (teardown != null) _teardowns.add(teardown);
      } catch (error) {
        _diagnostic('Plugin "${plugin.name}" failed to start: $error');
      }
    }
  }

  /// What the server shows about the app, with the id this client keeps for its whole life. Changes made before
  /// [start] reach the server.
  final Map<String, Object?> session;
  final int maxBufferEvents;

  /// Approximate size cap of the replay buffer, in characters.
  final int maxBufferChars;
  final Duration flushInterval;
  final Duration minRetry;
  final Duration maxRetry;
  final SerializeOptions serializeOptions;

  final List<CapybaraPlugin> _plugins;
  final SocketConnector? _connect;
  final void Function(String message) _diagnostic;
  final List<void Function()> _teardowns = [];
  List<Uri> Function() _targets;

  // Events are encoded once when recorded, so sending them again after a reconnect costs nothing extra.
  final List<_Buffered> _buffer = [];
  int _bufferChars = 0;
  int _seq = 0;
  int _sentSeq = 0;
  bool _ready = false;
  bool _started = false;
  bool _stopped = false;
  bool _opening = false;
  // Bumped when the addresses change, so a connection opened to the old ones is dropped.
  int _generation = 0;
  int _attempts = 0;
  Timer? _flushTimer;
  Timer? _retryTimer;
  CapybaraSocket? _socket;
  StreamSubscription<String>? _subscription;
  Uri? _preferred;
  final Set<String> _told = {};

  /// The server has acknowledged this session, so events are flowing.
  bool get connected => _ready;

  /// Where the client sends to, or last tried to.
  Uri? get target => _preferred;

  void start() {
    if (_started || _stopped) return;
    _started = true;
    unawaited(_open());
  }

  Object? serializeValue(Object? value) => serialize(value, serializeOptions);

  void emit(String kind, Map<String, Object?> payload, {int? ts}) {
    if (_stopped) return;
    final String json;
    try {
      json = jsonEncode({
        'seq': _seq + 1,
        'ts': ts ?? DateTime.now().millisecondsSinceEpoch,
        'kind': kind,
        'payload': payload,
      });
    } catch (_) {
      return;
    }
    _seq++;
    _buffer.add(_Buffered(_seq, json));
    _bufferChars += json.length;
    while (_buffer.length > 1 && (_buffer.length > maxBufferEvents || _bufferChars > maxBufferChars)) {
      _bufferChars -= _buffer.removeAt(0).json.length;
    }
    _scheduleFlush();
  }

  /// A log entry that does not go through `print`, e.g. from the app's own logger.
  void log(String level, List<Object?> args) {
    emit('log', {
      'level': level,
      'source': 'api',
      'args': [for (final arg in args) serializeValue(arg)],
    });
  }

  /// Sends to other addresses from now on, e.g. when the debugger tells the app where Capybara runs.
  void retarget(List<Uri> Function() targets) {
    _targets = targets;
    _preferred = null;
    _generation++;
    if (!_started || _stopped) return;
    _retryTimer?.cancel();
    _retryTimer = null;
    _attempts = 0;
    final socket = _socket;
    if (socket != null) {
      _detach();
      unawaited(socket.close());
    }
    unawaited(_open());
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _retryTimer?.cancel();
    for (final teardown in _teardowns.reversed) {
      try {
        teardown();
      } catch (_) {
        // keep tearing down the rest
      }
    }
    final socket = _socket;
    _detach();
    await socket?.close();
  }

  Future<void> _open() async {
    if (_opening) return;
    _opening = true;
    final generation = _generation;
    final socket = await _connectAny();
    _opening = false;
    if (_stopped || generation != _generation) {
      unawaited(socket?.close());
      if (!_stopped) unawaited(_open());
      return;
    }
    if (socket == null) {
      _scheduleRetry();
      return;
    }
    _socket = socket;
    _attempts = 0;
    _subscription = socket.messages.listen(
      (data) => _onMessage(socket, data),
      onError: (Object _) => _lost(socket),
      onDone: () => _lost(socket),
      cancelOnError: true,
    );
    _send(socket, jsonEncode({'t': 'hello', 'protocol': protocolVersion, 'session': session}));
  }

  /// Tries the address that answered last time, then every address at once; the first to answer is kept.
  Future<CapybaraSocket?> _connectAny() async {
    final targets = _targets();
    final preferred = _preferred;
    if (preferred != null && targets.length > 1 && targets.contains(preferred)) {
      final socket = await _race([preferred]);
      if (socket != null) return socket;
    }
    return _race(targets);
  }

  Future<CapybaraSocket?> _race(List<Uri> urls) {
    final connect = _connect;
    if (connect == null || urls.isEmpty) return Future.value();
    final result = Completer<CapybaraSocket?>();
    var failed = 0;
    for (final url in urls) {
      Future.sync(() => connect(url)).then(
        (socket) {
          if (result.isCompleted) {
            unawaited(socket.close());
          } else {
            _preferred = url;
            result.complete(socket);
          }
        },
        onError: (Object error) {
          if (error is CapybaraSetupError && _told.add(error.message)) _diagnostic(error.message);
          if (++failed == urls.length && !result.isCompleted) result.complete(null);
        },
      );
    }
    return result.future;
  }

  void _onMessage(CapybaraSocket socket, String data) {
    if (!identical(socket, _socket)) return;
    final Object? message;
    try {
      message = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (message is! Map) return;
    switch (message['t']) {
      case 'welcome':
        final lastSeq = message['lastSeq'];
        _sentSeq = lastSeq is int ? lastSeq : 0;
        _ready = true;
        _flush();
      case 'command':
        unawaited(_handleCommand(socket, message));
      case 'reject':
        _diagnostic('The Capybara server turned this app away: ${message['reason']}');
        unawaited(stop());
    }
  }

  Future<void> _handleCommand(CapybaraSocket socket, Map<dynamic, dynamic> message) async {
    final id = message['id'];
    final pluginName = message['plugin'];
    final method = message['method'];
    final handler = _plugins.where((plugin) => plugin.name == pluginName).firstOrNull?.commands[method];
    Map<String, Object?> reply;
    if (handler == null) {
      reply = {'t': 'result', 'id': id, 'ok': false, 'error': 'Unknown command $pluginName.$method'};
    } else {
      try {
        reply = {'t': 'result', 'id': id, 'ok': true, 'result': await handler(message['params'])};
      } catch (error) {
        reply = {'t': 'result', 'id': id, 'ok': false, 'error': _errorMessage(error)};
      }
    }
    String json;
    try {
      json = jsonEncode(reply);
    } catch (error) {
      json = jsonEncode({'t': 'result', 'id': id, 'ok': false, 'error': 'The result could not be sent: $error'});
    }
    _send(socket, json);
  }

  void _lost(CapybaraSocket socket) {
    if (!identical(socket, _socket)) return;
    _detach();
    _scheduleRetry();
  }

  void _detach() {
    _socket = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    _ready = false;
    _flushTimer?.cancel();
    _flushTimer = null;
  }

  void _scheduleRetry() {
    if (_stopped || _retryTimer != null) return;
    final factor = 1 << min(_attempts, 20);
    final delay = Duration(microseconds: min(maxRetry.inMicroseconds, minRetry.inMicroseconds * factor));
    _attempts++;
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (!_stopped) unawaited(_open());
    });
  }

  void _scheduleFlush() {
    if (!_ready || _flushTimer != null) return;
    _flushTimer = Timer(flushInterval, _flush);
  }

  void _flush() {
    _flushTimer = null;
    final socket = _socket;
    if (!_ready || socket == null) return;
    var i = _buffer.length;
    while (i > 0 && _buffer[i - 1].seq > _sentSeq) {
      i--;
    }
    while (i < _buffer.length) {
      final parts = <String>[];
      var chars = 0;
      while (i < _buffer.length && parts.length < _maxBatchEvents && (parts.isEmpty || chars < _maxBatchChars)) {
        parts.add(_buffer[i].json);
        chars += _buffer[i].json.length;
        i++;
      }
      // On failure sentSeq stays, and the events go out again after the next welcome.
      if (!_send(socket, '{"t":"events","events":[${parts.join(',')}]}')) return;
      _sentSeq = _buffer[i - 1].seq;
    }
  }

  bool _send(CapybaraSocket socket, String data) {
    try {
      socket.send(data);
      return true;
    } catch (_) {
      return false;
    }
  }
}

final _random = Random();

String _randomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  final time = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
  return '$time${List.generate(8, (_) => alphabet[_random.nextInt(alphabet.length)]).join()}';
}

// What Dart puts before an error's message says nothing to someone reading it in the UI.
final _errorPrefix = RegExp(r'^(Exception|Bad state|Unsupported operation|Invalid argument\(s\)|FormatException): ');

String _errorMessage(Object error) => error.toString().replaceFirst(_errorPrefix, '');
