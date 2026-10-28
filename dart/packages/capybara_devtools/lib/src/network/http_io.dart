import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'body.dart';
import 'recorder.dart';

/// Records the requests of every `HttpClient` made while it is `HttpOverrides.global`, which covers
/// `package:http`'s default client, dio's default adapter and `Image.network`. [parent] makes the clients, so
/// overrides the app set before still apply; an app that sets its own afterwards can pass Capybara's as theirs.
final class CapybaraHttpOverrides extends HttpOverrides {
  CapybaraHttpOverrides({HttpOverrides? parent}) : _parent = parent;

  final HttpOverrides? _parent;

  // Set while an outer Capybara override makes a client through this one: only the outer one records.
  static int _making = 0;

  HttpOverrides? get parent => _parent;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final HttpClient client;
    _making++;
    try {
      client = _parent?.createHttpClient(context) ?? super.createHttpClient(context);
    } finally {
      _making--;
    }
    final recorder = activeRecorder;
    if (recorder == null || _making > 0 || client is _TrackedClient) return client;
    return _TrackedClient(client, recorder);
  }

  @override
  String findProxyFromEnvironment(Uri url, Map<String, String>? environment) =>
      _parent?.findProxyFromEnvironment(url, environment) ?? super.findProxyFromEnvironment(url, environment);
}

/// Puts Capybara's overrides in front of the app's, again whenever the app replaced them; the function returned
/// takes them out, if nobody set others since.
({void Function() check, void Function() remove}) installHttpOverrides() {
  CapybaraHttpOverrides? installed;
  void check() {
    final current = HttpOverrides.current;
    if (current is CapybaraHttpOverrides) return;
    installed = CapybaraHttpOverrides(parent: current);
    HttpOverrides.global = installed;
  }

  void remove() {
    final ours = installed;
    if (ours != null && identical(HttpOverrides.current, ours)) HttpOverrides.global = ours.parent;
  }

  check();
  return (check: check, remove: remove);
}

Map<String, String> _headers(HttpHeaders headers) {
  final out = <String, String>{};
  headers.forEach((name, values) => out[name] = values.join(', '));
  return out;
}

final class _TrackedClient implements HttpClient {
  _TrackedClient(this._inner, this._recorder);

  final HttpClient _inner;
  final NetworkRecorder _recorder;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    if (_recorder.ignores(url)) return _inner.openUrl(method, url);
    final call = _recorder.start(method, url);
    try {
      return _TrackedRequest(await _inner.openUrl(method, url), call, _recorder);
    } catch (error) {
      // A WebSocket the app wrapped reports its own failure.
      if (!_recorder.isClaimedWebSocket(url)) call.fail(error);
      rethrow;
    }
  }

  // As dart:io builds the URL from host, port and path.
  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) {
    var queryStart = path.length;
    var fragmentStart = path.length;
    for (var i = path.length - 1; i >= 0; i--) {
      final char = path[i];
      if (char == '#') {
        fragmentStart = i;
        queryStart = i;
      } else if (char == '?') {
        queryStart = i;
      }
    }
    final query = queryStart < fragmentStart ? path.substring(queryStart + 1, fragmentStart) : null;
    return openUrl(
      method,
      Uri(scheme: 'http', host: host, port: port, path: path.substring(0, queryStart), query: query),
    );
  }

  @override
  Future<HttpClientRequest> get(String host, int port, String path) => open('get', host, port, path);

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('get', url);

  @override
  Future<HttpClientRequest> post(String host, int port, String path) => open('post', host, port, path);

  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('post', url);

  @override
  Future<HttpClientRequest> put(String host, int port, String path) => open('put', host, port, path);

  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('put', url);

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => open('delete', host, port, path);

  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => openUrl('delete', url);

  @override
  Future<HttpClientRequest> head(String host, int port, String path) => open('head', host, port, path);

  @override
  Future<HttpClientRequest> headUrl(Uri url) => openUrl('head', url);

  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => open('patch', host, port, path);

  @override
  Future<HttpClientRequest> patchUrl(Uri url) => openUrl('patch', url);

  @override
  bool get autoUncompress => _inner.autoUncompress;

  @override
  set autoUncompress(bool value) => _inner.autoUncompress = value;

  @override
  Duration? get connectionTimeout => _inner.connectionTimeout;

  @override
  set connectionTimeout(Duration? value) => _inner.connectionTimeout = value;

  @override
  Duration get idleTimeout => _inner.idleTimeout;

  @override
  set idleTimeout(Duration value) => _inner.idleTimeout = value;

  @override
  int? get maxConnectionsPerHost => _inner.maxConnectionsPerHost;

  @override
  set maxConnectionsPerHost(int? value) => _inner.maxConnectionsPerHost = value;

  @override
  String? get userAgent => _inner.userAgent;

  @override
  set userAgent(String? value) => _inner.userAgent = value;

  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) =>
      _inner.addCredentials(url, realm, credentials);

  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) =>
      _inner.addProxyCredentials(host, port, realm, credentials);

  @override
  set authenticate(Future<bool> Function(Uri url, String scheme, String? realm)? f) => _inner.authenticate = f;

  @override
  set authenticateProxy(Future<bool> Function(String host, int port, String scheme, String? realm)? f) =>
      _inner.authenticateProxy = f;

  @override
  set badCertificateCallback(bool Function(X509Certificate cert, String host, int port)? callback) =>
      _inner.badCertificateCallback = callback;

  @override
  set connectionFactory(Future<ConnectionTask<Socket>> Function(Uri url, String? proxyHost, int? proxyPort)? f) =>
      _inner.connectionFactory = f;

  @override
  set findProxy(String Function(Uri url)? f) => _inner.findProxy = f;

  @override
  set keyLog(Function(String line)? callback) => _inner.keyLog = callback;

  @override
  void close({bool force = false}) => _inner.close(force: force);

  // Members dart:io adds later reach here until this class declares them.
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _TrackedRequest implements HttpClientRequest {
  _TrackedRequest(this._inner, this._call, this._recorder);

  final HttpClientRequest _inner;
  final HttpCall _call;
  final NetworkRecorder _recorder;
  final BodyBytes _body = BodyBytes();
  Future<HttpClientResponse>? _response;
  bool _aborted = false;

  bool get _isWebSocket => _inner.headers.value(HttpHeaders.upgradeHeader)?.toLowerCase() == 'websocket';

  void _sent() {
    // A WebSocket's handshake waits for its answer: if the app wrapped the socket, the request is left out.
    if (_isWebSocket) return;
    _call.request(_headers(_inner.headers), _body.preview(_inner.headers.value(HttpHeaders.contentTypeHeader)));
  }

  Future<HttpClientResponse> _track(Future<HttpClientResponse> response) {
    return _response ??= response.then(
      (response) {
        if (_isWebSocket && _recorder.isClaimedWebSocket(_call.url)) return response;
        if (_isWebSocket) _call.request(_headers(_inner.headers));
        return _TrackedResponse(
          response,
          _call.respond(response.statusCode, response.reasonPhrase, _headers(response.headers)),
        );
      },
      onError: (Object error, StackTrace stack) {
        _call.fail(error, aborted: _aborted);
        return Future<HttpClientResponse>.error(error, stack);
      },
    );
  }

  @override
  Future<HttpClientResponse> close() {
    _sent();
    return _track(_inner.close());
  }

  @override
  Future<HttpClientResponse> get done => _track(_inner.done);

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    _aborted = true;
    _inner.abort(exception, stackTrace);
  }

  @override
  void add(List<int> data) {
    _body.add(data);
    _inner.add(data);
  }

  @override
  void write(Object? object) {
    final text = '$object';
    if (text.isEmpty) return;
    _body.add(_inner.encoding.encode(text));
    _inner.write(text);
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) => write(objects.join(separator));

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  Future<void> addStream(Stream<List<int>> stream) => _inner.addStream(
    stream.map((chunk) {
      _body.add(chunk);
      return chunk;
    }),
  );

  @override
  void addError(Object error, [StackTrace? stackTrace]) => _inner.addError(error, stackTrace);

  @override
  Future<void> flush() => _inner.flush();

  @override
  bool get bufferOutput => _inner.bufferOutput;

  @override
  set bufferOutput(bool value) => _inner.bufferOutput = value;

  @override
  int get contentLength => _inner.contentLength;

  @override
  set contentLength(int value) => _inner.contentLength = value;

  @override
  Encoding get encoding => _inner.encoding;

  @override
  set encoding(Encoding value) => _inner.encoding = value;

  @override
  bool get followRedirects => _inner.followRedirects;

  @override
  set followRedirects(bool value) => _inner.followRedirects = value;

  @override
  int get maxRedirects => _inner.maxRedirects;

  @override
  set maxRedirects(int value) => _inner.maxRedirects = value;

  @override
  bool get persistentConnection => _inner.persistentConnection;

  @override
  set persistentConnection(bool value) => _inner.persistentConnection = value;

  @override
  HttpConnectionInfo? get connectionInfo => _inner.connectionInfo;

  @override
  List<Cookie> get cookies => _inner.cookies;

  @override
  HttpHeaders get headers => _inner.headers;

  @override
  String get method => _inner.method;

  @override
  Uri get uri => _inner.uri;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _TrackedResponse extends Stream<List<int>> implements HttpClientResponse {
  _TrackedResponse(this._inner, this._tap);

  final HttpClientResponse _inner;
  final ResponseTap _tap;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    final subscription = _inner.listen(
      (chunk) {
        _tap.add(chunk);
        onData?.call(chunk);
      },
      onError: _onError(_tap, onError),
      onDone: () {
        _tap.done();
        onDone?.call();
      },
      cancelOnError: cancelOnError,
    );
    return _Subscription(subscription, _tap);
  }

  @override
  Future<Socket> detachSocket() {
    _tap.done();
    return _inner.detachSocket();
  }

  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      _inner.redirect(method, url, followLoops);

  @override
  X509Certificate? get certificate => _inner.certificate;

  @override
  HttpClientResponseCompressionState get compressionState => _inner.compressionState;

  @override
  HttpConnectionInfo? get connectionInfo => _inner.connectionInfo;

  @override
  int get contentLength => _inner.contentLength;

  @override
  List<Cookie> get cookies => _inner.cookies;

  @override
  HttpHeaders get headers => _inner.headers;

  @override
  bool get isRedirect => _inner.isRedirect;

  @override
  bool get persistentConnection => _inner.persistentConnection;

  @override
  String get reasonPhrase => _inner.reasonPhrase;

  @override
  List<RedirectInfo> get redirects => _inner.redirects;

  @override
  int get statusCode => _inner.statusCode;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Ends the response when its body fails, then hands the error on as the stream would have.
void Function(Object, StackTrace) _onError(ResponseTap tap, Function? handler) => (error, stack) {
  tap.done();
  if (handler is void Function(Object, StackTrace)) {
    handler(error, stack);
  } else if (handler is void Function(Object)) {
    handler(error);
  } else {
    Zone.current.handleUncaughtError(error, stack);
  }
};

/// The app's subscription to a response; cancelling it ends the response with what came so far.
final class _Subscription implements StreamSubscription<List<int>> {
  _Subscription(this._inner, this._tap);

  final StreamSubscription<List<int>> _inner;
  final ResponseTap _tap;

  @override
  Future<void> cancel() {
    _tap.done();
    return _inner.cancel();
  }

  @override
  void onData(void Function(List<int> data)? handleData) => _inner.onData((chunk) {
    _tap.add(chunk);
    handleData?.call(chunk);
  });

  @override
  void onDone(void Function()? handleDone) => _inner.onDone(() {
    _tap.done();
    handleDone?.call();
  });

  @override
  void onError(Function? handleError) => _inner.onError(_onError(_tap, handleError));

  @override
  void pause([Future<void>? resumeSignal]) => _inner.pause(resumeSignal);

  @override
  void resume() => _inner.resume();

  @override
  bool get isPaused => _inner.isPaused;

  @override
  Future<E> asFuture<E>([E? futureValue]) => _inner.asFuture<E>(futureValue).whenComplete(_tap.done);
}

/// `package:http`'s client over dart:io, whose requests the overrides record already.
bool isIoClient(Object client) => client.runtimeType.toString() == 'IOClient';
